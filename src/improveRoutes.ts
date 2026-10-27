import { type Journey, type Place } from './model';
import { computeJourney, hasCoordinates, loadGoogleMaps, mapsErrorMessage, unavailableJourney } from './googleMaps';
import { fetchVisitOpeningInfo } from './discoveryData';
import { calculateDayRoutes, type JourneyComputer } from './useLiveRoutes';
import { applyOrder, eligibility, evaluateOrder, MIN_IMPROVEMENT_MINUTES, searchOrders, signature,
  type ImproveCandidate, type ImproveEligibility, type ImproveInput, type ImproveMatrix } from './improveDay';

export type ImproveProgress = 'checking' | 'comparing' | 'verifying';
export interface ImproveProposal {
  inputSignature: string;
  current: ImproveCandidate;
  suggested: ImproveCandidate;
  hours: ImproveInput['hours'];
  hoursErrors: number;
  warning?: string;
  verifiedAt: number;
}
export interface ImproveRunResult {
  phase: 'proposal' | 'none' | 'ineligible';
  message?: string;
  action?: ImproveEligibility['action'];
  proposal?: ImproveProposal;
  inputSignature?: string;
}
export class ImproveRunError extends Error {}
const CANCELLED = () => new DOMException('This comparison was cancelled.', 'AbortError');
function assertCurrent(current: () => boolean) { if (!current()) throw CANCELLED(); }

/** Cancellation removes queued work; already issued Google requests may still finish. */
export function createImproveTaskPool(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => { while (active < limit && queue.length) queue.shift()!(); };
  return <T>(work: () => Promise<T>, current: () => boolean = () => true): Promise<T> => new Promise((resolve, reject) => {
    queue.push(() => {
      if (!current()) { reject(CANCELLED()); return; }
      active++;
      void Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
    });
    pump();
  });
}
const hoursQueue = createImproveTaskPool(4);
const verifyQueue = createImproveTaskPool(2);

interface MatrixCell { condition?: string; durationMillis?: number; distanceMeters?: number; error?: unknown }
interface MatrixResponse { matrix?: { rows?: { items?: MatrixCell[] }[] } }
interface MatrixRequest {
  origins: (google.maps.places.Place | google.maps.LatLngLiteral)[];
  destinations: (google.maps.places.Place | google.maps.LatLngLiteral)[];
  travelMode: 'WALKING' | 'DRIVING';
  fields: string[];
  routingPreference?: 'TRAFFIC_UNAWARE';
}
interface MatrixLibrary { RouteMatrix: { computeRouteMatrix(request: MatrixRequest): Promise<MatrixResponse> } }
interface MatrixEntry { at: number; promise: Promise<Journey[][]>; subscribers: Set<() => boolean> }
const MATRIX_CACHE_MS = 10 * 60_000;
const MATRIX_CACHE_LIMIT = 24;

function sameLocation(a: Place, b: Place): boolean {
  return Boolean((a.googlePlaceId && a.googlePlaceId === b.googlePlaceId) || (a.lat === b.lat && a.lng === b.lng));
}
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), 25_000);
  })]).finally(() => clearTimeout(timer));
}

/** A small injectable adapter keeps billed matrix requests bounded and testable. */
export function createImproveMatrixService(load = loadGoogleMaps, now = Date.now) {
  const cache = new Map<string, MatrixEntry>();
  const enqueue = createImproveTaskPool(2);
  return async (input: ImproveInput, current: () => boolean = () => true): Promise<ImproveMatrix> => {
    assertCurrent(current);
    if (input.day.items.length > 8 || input.day.endMode === 'transit' || input.day.endMode === 'flight'
      || input.day.items.some(item => item.mode !== input.day.endMode)) {
      throw new ImproveRunError('Compare up to 8 stops using only walking or only driving.');
    }
    const mode = input.day.endMode;
    const ids = [...new Set([input.day.startPlaceId ?? 'hotel', input.day.endPlaceId ?? 'hotel', ...input.day.items.map(item => item.placeId)])].sort();
    const points = ids.map(id => input.places[id]);
    if (points.some(place => !hasCoordinates(place))) throw new ImproveRunError('Choose a mapped location for every stop and the day’s start and end.');
    // A provider ID and coincident coordinates use the same zero-journey rule as computeJourney.
    const groups: { point: Place; indices: number[] }[] = [];
    points.forEach((point, index) => {
      const group = groups.find(value => sameLocation(value.point, point));
      if (group) group.indices.push(index);
      else groups.push({ point, indices: [index] });
    });
    if (groups.length > 10) throw new ImproveRunError('This comparison supports at most 10 map locations.');
    const key = JSON.stringify([mode, groups.map(({ point }) => [point.googlePlaceId ?? null, point.lat, point.lng])]);
    let entry = cache.get(key);
    if (entry && now() - entry.at >= MATRIX_CACHE_MS) { cache.delete(key); entry = undefined; }
    if (!entry) {
      while (cache.size >= MATRIX_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      const subscribers = new Set([current]);
      const anyCurrent = () => [...subscribers].some(check => check());
      const promise = enqueue(async () => {
        assertCurrent(anyCurrent);
        if (groups.length === 1) return [[{ min: 0, km: '0.0', mode, status: 'ready', path: [] } as Journey]];
        try {
          const maps = await load();
          assertCurrent(anyCurrent);
          const [{ RouteMatrix }, { Place: GooglePlace }] = await Promise.all([
            maps.importLibrary('routes') as unknown as Promise<MatrixLibrary>,
            maps.importLibrary('places') as Promise<google.maps.PlacesLibrary>,
          ]);
          assertCurrent(anyCurrent);
          const waypoints = groups.map(({ point }) => point.googlePlaceId
            ? new GooglePlace({ id: point.googlePlaceId }) : { lat: point.lat!, lng: point.lng! });
          const result = await withTimeout(RouteMatrix.computeRouteMatrix({
            origins: waypoints, destinations: waypoints,
            travelMode: mode === 'walk' ? 'WALKING' : 'DRIVING',
            fields: ['durationMillis', 'distanceMeters', 'condition'],
            ...(mode === 'drive' ? { routingPreference: 'TRAFFIC_UNAWARE' as const } : {}),
          }));
          if (!result.matrix?.rows?.length) throw new Error('Missing route matrix');
          return groups.map((_, row) => groups.map((__, column): Journey => {
            if (row === column) return { min: 0, km: '0.0', mode, status: 'ready', path: [] };
            const cell = result.matrix?.rows?.[row]?.items?.[column];
            if (!cell || cell.condition !== 'ROUTE_EXISTS' || cell.error || !Number.isFinite(cell.durationMillis)
              || !Number.isFinite(cell.distanceMeters) || cell.durationMillis! < 0 || cell.distanceMeters! < 0) {
              return unavailableJourney(mode, 'No route is available for this journey.');
            }
            return { min: Math.ceil(cell.durationMillis! / 60_000), km: (cell.distanceMeters! / 1_000).toFixed(1), mode, status: 'ready' };
          }));
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          throw new ImproveRunError(mapsErrorMessage(error, 'routes'));
        }
      }, anyCurrent);
      entry = { at: now(), promise, subscribers };
      cache.set(key, entry);
      const owned = entry;
      void promise.then(rows => {
        // A partial provider failure should be retryable rather than cached for ten minutes.
        if (rows.some(row => row.some(leg => leg.min === null)) && cache.get(key) === owned) cache.delete(key);
      }, () => { if (cache.get(key) === owned) cache.delete(key); });
    }
    entry.subscribers.add(current);
    try {
      const rows = await entry.promise;
      assertCurrent(current);
      const groupFor = new Map(groups.flatMap((group, index) => group.indices.map(pointIndex => [pointIndex, index] as const)));
      return Object.fromEntries(ids.map((from, row) => [from, Object.fromEntries(ids.map((to, column) => [to,
        sameLocation(points[row], points[column]) ? { min: 0, km: '0.0', mode, status: 'ready', path: [] }
          : rows[groupFor.get(row)!][groupFor.get(column)!],
      ]))]));
    } finally { entry.subscribers.delete(current); }
  };
}
export const computeImproveMatrix = createImproveMatrixService();

export interface ImproveDependencies {
  fetchHours?: typeof fetchVisitOpeningInfo;
  matrix?: typeof computeImproveMatrix;
  journey?: JourneyComputer;
  now?: () => number;
}
export async function runImproveDay(
  initial: ImproveInput,
  onProgress: (phase: ImproveProgress) => void = () => {},
  current: () => boolean = () => true,
  dependencies: ImproveDependencies = {},
): Promise<ImproveRunResult> {
  assertCurrent(current);
  const allowed = eligibility(initial);
  if (!allowed.ok) return { phase: 'ineligible', message: allowed.reason, action: allowed.action };
  const input: ImproveInput = { ...initial, hours: {} };
  let hoursErrors = 0;
  onProgress('checking');
  const ids = [...new Set(input.day.items.map(item => item.placeId))];
  const byProvider = new Map<string, string[]>();
  for (const id of ids) {
    const providerId = input.places[id]?.googlePlaceId;
    // A failed provider refresh must not discard a traveller-confirmed cutoff.
    if (initial.hours[id]?.lastEntryMinutes) input.hours[id] = { fetchedAt: 0, lastEntryMinutes: initial.hours[id]!.lastEntryMinutes };
    if (providerId) byProvider.set(providerId, [...byProvider.get(providerId) ?? [], id]);
    else if (initial.hours[id]) input.hours[id] = initial.hours[id];
  }
  await Promise.all([...byProvider].map(([providerId, placeIds]) => hoursQueue(async () => {
    assertCurrent(current);
    try {
      const info = await (dependencies.fetchHours ?? fetchVisitOpeningInfo)(providerId);
      assertCurrent(current);
      for (const id of placeIds) input.hours[id] = initial.hours[id]?.lastEntryMinutes
        ? { ...info, lastEntryMinutes: initial.hours[id]!.lastEntryMinutes } : info;
    } catch (error) {
      assertCurrent(current);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      hoursErrors += placeIds.length;
    }
  }, current)));
  assertCurrent(current);
  onProgress('comparing');
  const matrix = await (dependencies.matrix ?? computeImproveMatrix)(input, current);
  assertCurrent(current);
  let candidates: ImproveCandidate[];
  try { candidates = await searchOrders(input, matrix, current); }
  catch (error) {
    assertCurrent(current);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ImproveRunError('A current journey could not be compared. Check its map location or retry.');
  }
  if (!candidates.length) return { phase: 'none', message: 'No order saves at least 5 minutes while protecting bookings, known opening hours and your finish time.' };
  onProgress('verifying');
  const journey = dependencies.journey ?? computeJourney;
  const verify = async (day = input.day) => {
    const legs = await calculateDayRoutes({ date: input.date, timezone: input.timezone, day, places: input.places, hours: input.hours }, undefined, current,
      (from, to, mode, departure) => verifyQueue(() => { assertCurrent(current); return journey(from, to, mode, departure); }, current));
    assertCurrent(current);
    return { legs, evaluation: evaluateOrder(input, day.items, legs) };
  };
  const baseline = await verify();
  if (baseline.evaluation.schedule.unknown || baseline.evaluation.schedule.finishApprox) {
    throw new ImproveRunError('Every current journey needs a verified route before we can compare savings. Retry when routes are available.');
  }
  const verified: ImproveCandidate[] = [];
  let unavailable = false;
  // At most three alternatives are checked against the same routing settings as the current day.
  for (const candidate of candidates.slice(0, 3)) {
    assertCurrent(current);
    const next = await verify(applyOrder(input.day, candidate.order));
    const saving = baseline.evaluation.schedule.travel - next.evaluation.schedule.travel;
    if (next.evaluation.schedule.unknown) unavailable = true;
    if (next.evaluation.feasible && next.evaluation.schedule.finish <= baseline.evaluation.schedule.finish && saving >= MIN_IMPROVEMENT_MINUTES) {
      verified.push({ ...candidate, ...next, saving });
    }
  }
  if (!verified.length) {
    if (unavailable) throw new ImproveRunError('The suggested routes could not all be verified. Your day is unchanged; please retry.');
    return { phase: 'none', message: 'After checking the complete routes, no alternative saves at least 5 minutes and meets the day’s constraints.' };
  }
  verified.sort((a, b) => a.evaluation.schedule.travel - b.evaluation.schedule.travel
    || a.evaluation.schedule.finish - b.evaluation.schedule.finish || a.moved - b.moved);
  assertCurrent(current);
  const inputSignature = signature(input);
  const suggested = verified[0];
  const warning = input.day.endMode === 'walk'
    ? 'Walking routes may be missing clear sidewalks or pedestrian paths. Check local conditions.'
    : 'Driving times are estimates without live traffic.';
  return { phase: 'proposal', inputSignature, proposal: {
    inputSignature, current: { order: input.day.items.map(item => item.aid), ...baseline, moved: 0, saving: 0 },
    suggested, hours: input.hours, hoursErrors, warning, verifiedAt: (dependencies.now ?? Date.now)(),
  } };
}
