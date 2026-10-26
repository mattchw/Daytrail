import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dayStartPlace, dayStartTime, type Day, type Journey, type Place, type Trip } from './model';
import { computeJourney, hasCoordinates, unavailableJourney } from './googleMaps';

export interface DayRouteInput { date: string; timezone: string; day: Day; places: Record<string, Place> }
export type JourneyComputer = typeof computeJourney;

export function tripDayDate(startDate: string, dayIndex: number): string {
  const date = new Date(`${startDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.toISOString().slice(0, 10);
}

/** Convert trip-local wall time using its IANA zone, including DST and overnight visits. */
export function zonedDeparture(date: string, minutes: number, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minutes)) return null;
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const target = midnight + Math.round(minutes) * 60_000;
  if (!Number.isFinite(target)) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const wallTime = (timestamp: number): number => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
      return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    };
    let candidate = target;
    for (let index = 0; index < 5; index += 1) {
      const offset = target - wallTime(candidate);
      if (!offset) break;
      candidate += offset;
    }
    if (wallTime(candidate) !== target) return null; // A nonexistent local time during a clock change.
    // Prefer the first occurrence when clocks repeat an hour (or half hour).
    for (const delta of [120, 90, 60, 30]) {
      const earlier = candidate - delta * 60_000;
      if (wallTime(earlier) === target) return new Date(earlier);
    }
    return new Date(candidate);
  } catch { return null; }
}

export function transitDateReason(departure: Date, now = Date.now()): string | null {
  const days = (departure.getTime() - now) / 86_400_000;
  if (!Number.isFinite(days)) return 'Choose a valid trip date and time zone';
  if (days > 100) return 'Transit schedules are available up to 100 days ahead. Try walking or driving for now.';
  if (days < -7) return 'Transit schedules are unavailable more than 7 days in the past.';
  return null;
}

export function pendingLegs(input: DayRouteInput): Record<string, Journey> {
  const result: Record<string, Journey> = {};
  let previous = dayStartPlace(input.day, input.places);
  for (const item of input.day.items) {
    const place = input.places[item.placeId];
    result[item.aid] = hasCoordinates(previous) && hasCoordinates(place)
      ? { min: null, km: '—', mode: item.mode, status: 'loading', reason: 'Calculating route…' }
      : unavailableJourney(item.mode, 'Choose a map location');
    previous = place;
  }
  result.return = input.day.items.length === 0 ? { min: 0, km: '0.0', mode: input.day.endMode, status: 'ready', path: [] }
    : hasCoordinates(previous) && hasCoordinates(input.places.hotel)
      ? { min: null, km: '—', mode: input.day.endMode, status: 'loading', reason: 'Calculating route…' }
      : unavailableJourney(input.day.endMode, 'Choose a map location');
  return result;
}

/** Reuse only a real static journey with exactly the same endpoints and mode. */
export function reuseReadyStaticLegs(input: DayRouteInput, priorInput: DayRouteInput | null, priorLegs: Record<string, Journey>): Record<string, Journey> {
  const next = pendingLegs(input);
  if (!priorInput) return next;
  const pairs = (plan: DayRouteInput) => {
    let from = dayStartPlace(plan.day, plan.places);
    const result = plan.day.items.map(item => {
      const to = plan.places[item.placeId];
      const pair = { id: item.aid, from, to, mode: item.mode };
      from = to;
      return pair;
    });
    if (plan.day.items.length) result.push({ id: 'return', from, to: plan.places.hotel, mode: plan.day.endMode });
    return result;
  };
  const pairKey = (pair: ReturnType<typeof pairs>[number]) => {
    if (pair.mode === 'transit' || !hasCoordinates(pair.from) || !hasCoordinates(pair.to)) return null;
    return JSON.stringify([pair.from.googlePlaceId ?? null, pair.from.lat, pair.from.lng,
      pair.to.googlePlaceId ?? null, pair.to.lat, pair.to.lng, pair.mode]);
  };
  const reusable = new Map<string, Journey>();
  for (const pair of pairs(priorInput)) {
    const key = pairKey(pair), leg = priorLegs[pair.id];
    if (key && leg?.status === 'ready' && leg.mode === pair.mode && leg.min !== null && Number.isFinite(leg.min) && leg.min >= 0) reusable.set(key, leg);
  }
  for (const pair of pairs(input)) {
    const key = pairKey(pair), leg = key ? reusable.get(key) : undefined;
    if (leg) next[pair.id] = leg;
  }
  return next;
}

/** Transit departures depend on preceding journeys; fixed bookings never reset uncertainty. */
export async function calculateDayRoutes(
  input: DayRouteInput,
  onLeg: (id: string, leg: Journey) => void = () => {},
  current: () => boolean = () => true,
  compute: JourneyComputer = computeJourney,
  now = Date.now(),
): Promise<Record<string, Journey>> {
  const result = pendingLegs(input);
  if (!input.day.items.length) return result;
  let previous = dayStartPlace(input.day, input.places);
  let minutes = dayStartTime(input.day);
  let uncertain = false;
  const steps = [...input.day.items.map(item => ({ id: item.aid, place: input.places[item.placeId], mode: item.mode, duration: item.duration, fixed: item.fixed })),
    { id: 'return', place: input.places.hotel, mode: input.day.endMode, duration: 0, fixed: null }];
  for (const step of steps) {
    if (!current()) return result;
    let leg: Journey;
    if (!hasCoordinates(previous) || !hasCoordinates(step.place)) leg = unavailableJourney(step.mode, 'Choose a map location');
    else if (step.mode === 'transit' && uncertain) leg = unavailableJourney(step.mode, 'Confirm earlier journeys before calculating this transit departure');
    else {
      const departure = step.mode === 'transit' ? zonedDeparture(input.date, minutes, input.timezone) : undefined;
      const problem = step.mode === 'transit' ? departure ? transitDateReason(departure, now) : 'Choose a valid trip date and time zone' : null;
      leg = problem ? unavailableJourney(step.mode, problem) : await compute(previous, step.place, step.mode, departure ?? undefined);
    }
    if (!current()) return result;
    result[step.id] = leg;
    onLeg(step.id, leg);
    if (leg.min === null) uncertain = true;
    minutes = Math.max(minutes + (leg.min ?? 0), step.fixed ?? 0) + step.duration;
    previous = step.place;
  }
  return result;
}

/** The signature includes only inputs that can affect a route, never notes or UI selection. */
export function routeInputSignature(trip: Trip, dayIndex: number, places: Record<string, Place>): string {
  const day = trip.days[dayIndex];
  const routePlaces: Record<string, Place> = {};
  for (const id of [day.startPlaceId ?? 'hotel', 'hotel', ...day.items.map(item => item.placeId)]) {
    const place = places[id];
    if (place) routePlaces[id] = {
      id: place.id, name: '', cat: place.cat, x: 0, y: 0, area: '', typical: '', blurb: '',
      lat: place.lat, lng: place.lng, googlePlaceId: place.googlePlaceId,
    };
  }
  return JSON.stringify({ date: tripDayDate(trip.startDate, dayIndex), timezone: trip.timezone,
    day: {
      id: day.id, label: '', date: '', title: '', endMode: day.endMode,
      startTime: dayStartTime(day), startPlaceId: day.startPlaceId ?? 'hotel',
      items: day.items.map(item => ({ ...item, note: '' })),
    }, places: routePlaces });
}

interface RouteState { key: string; input: DayRouteInput | null; legs: Record<string, Journey>; loading: boolean; error: string | null }
export function useLiveRoutes(trip: Trip, dayIndex: number, places: Record<string, Place>, enabled = true): {
  legs: Record<string, Journey>; loading: boolean; error: string | null; retry: () => void;
} {
  const signature = routeInputSignature(trip, dayIndex, places);
  const input = useMemo(() => JSON.parse(signature) as DayRouteInput, [signature]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RouteState>({ key: '', input: null, legs: {}, loading: false, error: null });
  const latest = useRef(state);
  const key = `${attempt}:${signature}`;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const legs = reuseReadyStaticLegs(input, latest.current.input, latest.current.legs);
    const publish = (next: RouteState) => { latest.current = next; setState(next); };
    publish({ key, input, legs, loading: input.day.items.length > 0, error: null });
    const timer = window.setTimeout(() => {
      void calculateDayRoutes(input, (id, leg) => {
        if (!active) return;
        legs[id] = leg;
        publish({ key, input, legs: { ...legs }, loading: true, error: null });
      }, () => active).then(result => {
        if (!active) return;
        const failures = Object.values(result).filter(leg => leg.status === 'unavailable');
        publish({ key, input, legs: result, loading: false, error: failures.length ? `${failures.length} ${failures.length === 1 ? 'journey needs' : 'journeys need'} attention. Check the route notes below.` : null });
      }).catch(() => {
        if (!active) return;
        const failed = Object.fromEntries(Object.entries(legs).map(([id, leg]) => [id, leg.status === 'loading' ? unavailableJourney(leg.mode, 'Route unavailable. Please retry.') : leg]));
        publish({ key, input, legs: failed, loading: false, error: 'Routes could not be loaded. Please retry.' });
      });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled, key, input]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  if (!enabled) return { legs: {}, loading: false, error: null, retry };
  return state.key === key ? { legs: state.legs, loading: state.loading, error: state.error, retry }
    : { legs: reuseReadyStaticLegs(input, state.input, state.legs), loading: input.day.items.length > 0, error: null, retry };
}
