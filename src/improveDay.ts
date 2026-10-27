import { dayStartTime, schedule, type Activity, type Day, type Journey, type Place } from './model';
import type { OpeningInfo } from './openingHours';
import { checkVisitHours, type VisitHoursCheck } from './visitHours';
import { scheduleWithOpeningHours } from './hoursPlanning';

/** All provider data here is transient; only a reviewed order is saved to the trip. */
export interface ImproveInput {
  tripId: string;
  date: string;
  timezone: string;
  day: Day;
  places: Record<string, Place>;
  hours: Record<string, OpeningInfo | undefined>;
  locks: string[];
}
export type ImproveMatrix = Record<string, Record<string, Journey>>;
export interface ImproveEligibility {
  ok: boolean;
  reason?: string;
  action?: 'day-plan' | 'locations' | 'modes';
}
export interface ImproveEvaluation {
  schedule: ReturnType<typeof schedule>;
  checks: Record<string, VisitHoursCheck>;
  unknownHours: number;
  regularHours: number;
  /** Late bookings, visits outside known hours, and a missed finish deadline. */
  conflicts: number;
  feasible: boolean;
}
export interface ImproveCandidate {
  order: string[];
  legs: Record<string, Journey>;
  evaluation: ImproveEvaluation;
  moved: number;
  saving: number;
}
export const MIN_IMPROVEMENT_MINUTES = 5;
export const MAX_IMPROVE_STOPS = 8;

const validCoordinates = (place: Place | undefined) => Boolean(place
  && Number.isFinite(place.lat) && Math.abs(place.lat!) <= 90
  && Number.isFinite(place.lng) && Math.abs(place.lng!) <= 180);

function movableSegments(input: ImproveInput): number[][] {
  const locked = new Set(input.locks);
  const segments: number[][] = [];
  let segment: number[] = [];
  input.day.items.forEach((item, index) => {
    if (item.fixed !== null || locked.has(item.aid)) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    } else segment.push(index);
  });
  if (segment.length > 1) segments.push(segment);
  return segments;
}

export function eligibility(input: ImproveInput): ImproveEligibility {
  const { day, places } = input;
  if (day.endMode === 'flight' || day.endFlightId || day.items.some(item => item.mode === 'flight' || item.flightId)) return { ok: false, reason: 'Days with flights keep their scheduled order. Flight-day reordering is not supported yet.' };
  if (day.items.length < 2) return { ok: false, reason: 'Add at least two stops to compare their order.' };
  if (day.items.length > MAX_IMPROVE_STOPS) return { ok: false, reason: 'This comparison supports up to 8 stops in one day. Move some visits to another day first.' };
  if (day.endMode === 'transit' || day.items.some(item => item.mode !== day.endMode)) {
    return { ok: false, reason: 'Choose walking for every journey, or driving for every journey, including the final journey. Mixed modes and public transport cannot be compared yet.', action: 'modes' };
  }
  if (!validCoordinates(places[day.startPlaceId ?? 'hotel']) || !validCoordinates(places[day.endPlaceId ?? 'hotel'])
    || day.items.some(item => !validCoordinates(places[item.placeId]))) {
    return { ok: false, reason: 'Choose a mapped location for the start, end and every stop before comparing routes.', action: 'locations' };
  }
  const date = new Date(`${input.date}T00:00:00Z`);
  let validTimezone = true;
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { validTimezone = false; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== input.date || !validTimezone
    || !Number.isInteger(dayStartTime(day)) || dayStartTime(day) < 0
    || day.items.some(item => !Number.isInteger(item.duration) || item.duration <= 0
      || (item.fixed !== null && (!Number.isInteger(item.fixed) || item.fixed < 0)))) {
    return { ok: false, reason: 'Check the day’s date, departure time and visit durations before comparing.', action: 'day-plan' };
  }
  if (new Set(day.items.map(item => item.aid)).size !== day.items.length) {
    return { ok: false, reason: 'This day has duplicate activity IDs. Reload the trip before trying again.' };
  }
  if (!movableSegments(input).length) {
    return { ok: false, reason: 'Keep at least two flexible stops together between bookings or locked stops. Stops cannot move across those anchors.' };
  }
  return { ok: true };
}

/** Names and notes do not affect the comparison. A note edited during review survives Apply. */
export function signature(input: ImproveInput): string {
  const { day, places } = input;
  const ids = [...new Set([day.startPlaceId ?? 'hotel', day.endPlaceId ?? 'hotel', ...day.items.map(item => item.placeId)])].sort();
  const activityIds = new Set(day.items.map(item => item.aid));
  return JSON.stringify({
    tripId: input.tripId, date: input.date, timezone: input.timezone, dayId: day.id,
    startTime: dayStartTime(day), finishBy: day.finishBy ?? null,
    startPlaceId: day.startPlaceId ?? 'hotel', endPlaceId: day.endPlaceId ?? 'hotel', endMode: day.endMode,
    items: day.items.map(({ aid, placeId, duration, fixed, mode, freeTime }) => ({ aid, placeId, duration, fixed, mode, freeTime })),
    places: ids.map(id => ({ id, googlePlaceId: places[id]?.googlePlaceId ?? null, lat: places[id]?.lat ?? null, lng: places[id]?.lng ?? null })),
    hours: [...new Set(day.items.map(item => item.placeId))].sort().map(id => [id, input.hours[id] ?? null]),
    locks: [...new Set(input.locks)].filter(id => activityIds.has(id)).sort(),
  });
}

export function legsForOrder(input: ImproveInput, items: Activity[], matrix: ImproveMatrix): Record<string, Journey> {
  const legs: Record<string, Journey> = {};
  let previous = input.day.startPlaceId ?? 'hotel';
  for (const item of items) {
    const leg = matrix[previous]?.[item.placeId];
    if (leg) legs[item.aid] = leg;
    previous = item.placeId;
  }
  const returnLeg = matrix[previous]?.[input.day.endPlaceId ?? 'hotel'];
  if (returnLeg) legs.return = returnLeg;
  return legs;
}

function evaluateSchedule(input: ImproveInput, result: ReturnType<typeof schedule>, cache?: Map<string, VisitHoursCheck>): ImproveEvaluation {
  const checks: Record<string, VisitHoursCheck> = {};
  let unknownHours = 0, regularHours = 0, conflicts = 0;
  for (const row of result.rows) {
    const start = Math.max(row.start, row.arrive);
    const key = `${row.it.aid}:${start}:${row.physicalEnd}:${row.approx}`;
    let check = cache?.get(key);
    if (!check) {
      check = checkVisitHours(input.hours[row.it.placeId], { date: input.date, start, end: row.physicalEnd, approx: row.approx, allowWait: row.it.fixed === null });
      if (cache) {
        if (cache.size >= 12_000) cache.clear();
        cache.set(key, check);
      }
    }
    checks[row.it.aid] = check;
    if (check.status === 'unknown') unknownHours += 1;
    if (check.source === 'regular') regularHours += 1;
    if (check.status === 'closed' || check.status === 'short') conflicts += 1;
    if (row.late > 0) conflicts += 1;
  }
  if (input.day.finishBy != null && result.finish > input.day.finishBy) conflicts += 1;
  return { schedule: result, checks, unknownHours, regularHours, conflicts, feasible: result.unknown === 0 && !result.finishApprox && conflicts === 0 };
}

export function evaluateOrder(input: ImproveInput, items: Activity[], legs: Record<string, Journey>): ImproveEvaluation {
  return evaluateSchedule(input, scheduleWithOpeningHours({ ...input.day, items }, input.places, legs, { date: input.date, hours: input.hours }));
}

function* legalOrders(input: ImproveInput): Generator<Activity[]> {
  const segments = movableSegments(input);
  const order = [...input.day.items];
  function* segmentOrders(segmentIndex: number): Generator<Activity[]> {
    if (segmentIndex === segments.length) { yield [...order]; return; }
    const slots = segments[segmentIndex];
    const remaining = slots.map(slot => input.day.items[slot]);
    function* permute(offset: number): Generator<Activity[]> {
      if (offset === slots.length) { yield* segmentOrders(segmentIndex + 1); return; }
      for (let index = offset; index < remaining.length; index++) {
        [remaining[offset], remaining[index]] = [remaining[index], remaining[offset]];
        order[slots[offset]] = remaining[offset];
        yield* permute(offset + 1);
        [remaining[offset], remaining[index]] = [remaining[index], remaining[offset]];
      }
    }
    yield* permute(0);
  }
  yield* segmentOrders(0);
}

function assertCurrent(current: () => boolean) {
  if (!current()) throw new DOMException('This comparison was cancelled.', 'AbortError');
}

/** Exhaustive, directed comparison bounded by 8! orders. Yield between short batches. */
export async function searchOrders(input: ImproveInput, matrix: ImproveMatrix, current: () => boolean = () => true): Promise<ImproveCandidate[]> {
  assertCurrent(current);
  const allowed = eligibility(input);
  if (!allowed.ok) throw new Error(allowed.reason);
  const baseline = evaluateOrder(input, input.day.items, legsForOrder(input, input.day.items, matrix));
  if (baseline.schedule.unknown || baseline.schedule.finishApprox) {
    throw new Error('A route in the current day is unavailable. Confirm every journey before comparing another order.');
  }
  const best: ImproveCandidate[] = [];
  const hoursCache = new Map<string, VisitHoursCheck>();
  const compare = (a: ImproveCandidate, b: ImproveCandidate) => a.evaluation.schedule.travel - b.evaluation.schedule.travel
    || a.evaluation.schedule.finish - b.evaluation.schedule.finish || a.moved - b.moved;
  let inspected = 0;
  for (const items of legalOrders(input)) {
    if (++inspected % 200 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      assertCurrent(current);
    }
    const legs = legsForOrder(input, items, matrix);
    const result = scheduleWithOpeningHours({ ...input.day, items }, input.places, legs, { date: input.date, hours: input.hours });
    const saving = baseline.schedule.travel - result.travel;
    if (result.unknown || result.finishApprox || result.late > 0 || result.finish > baseline.schedule.finish
      || (input.day.finishBy != null && result.finish > input.day.finishBy) || saving < MIN_IMPROVEMENT_MINUTES) continue;
    const moved = items.filter((item, index) => item.aid !== input.day.items[index].aid).length;
    if (best.length === 3) {
      const worst = best[best.length - 1];
      if (result.travel > worst.evaluation.schedule.travel
        || (result.travel === worst.evaluation.schedule.travel && result.finish > worst.evaluation.schedule.finish)
        || (result.travel === worst.evaluation.schedule.travel && result.finish === worst.evaluation.schedule.finish && moved >= worst.moved)) continue;
    }
    const evaluation = evaluateSchedule(input, result, hoursCache);
    if (!evaluation.feasible) continue;
    best.push({ order: items.map(item => item.aid), legs, evaluation, moved, saving });
    best.sort(compare);
    if (best.length > 3) best.pop();
  }
  assertCurrent(current);
  return best;
}

/** Reorder whole stop objects: attached free time follows its place, and newer notes survive. */
export function applyOrder(day: Day, order: string[]): Day {
  const byId = new Map(day.items.map(item => [item.aid, item]));
  if (byId.size !== day.items.length || order.length !== day.items.length || new Set(order).size !== order.length
    || order.some(id => !byId.has(id))) throw new Error('The day changed. Compare it again before applying this order.');
  if (day.items.some((item, index) => item.fixed !== null && order[index] !== item.aid)) {
    throw new Error('A booking cannot change position. Compare this day again.');
  }
  return { ...day, items: order.map(id => byId.get(id)!) };
}
