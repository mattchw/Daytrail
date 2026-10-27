import { bookingDayDate, dayHasFlight, dayMinutesAt, dayTimezone, flightTiming, incomingFlightStartIssue, localDateAt, schedule, scheduleVisitWindow, type Activity, type Day, type Journey, type Place, type ScheduleContext, type Trip } from './model';
import type { OpeningInfo } from './openingHours';
import { checkVisitHours, openingWaitMinutes, type VisitHoursCheck } from './visitHours';

export type HoursByPlace = Record<string, OpeningInfo | undefined>;
export interface HoursScheduleOptions { date: string; hours: HoursByPlace; context?: ScheduleContext }
export type HoursSchedule = Omit<ReturnType<typeof schedule>, 'rows'> & {
  rows: (ReturnType<typeof schedule>['rows'][number] & { openingWaitMinutes?: number })[];
};

/** Calendar date at the visit's actual place-local start, including late-night plans.
 * The schedule window already handles flight timezone crossings; only its minute
 * overflow is normalized here. This is for labels/editing, not route simulation.
 */
export function visitDateForHours(row: ReturnType<typeof schedule>['rows'][number], date: string): string {
  const window = scheduleVisitWindow(row, date);
  const offset = Math.floor(window.start / 1440);
  if (!Number.isFinite(offset) || offset === 0) return window.date;
  const localDate = new Date(`${window.date}T00:00:00Z`);
  if (!Number.isFinite(localDate.getTime())) return window.date;
  localDate.setUTCDate(localDate.getUTCDate() + offset);
  return localDate.toISOString().slice(0, 10);
}

/** Resolve each flexible opening wait before scheduling subsequent stops and flight anchors.
 * Temporary start constraints are calculation-only: no activity is changed into a booking.
 * An explicit empty routes object is required when provider routes are unavailable.
 */
export function scheduleWithOpeningHours(day: Day, places: Record<string, Place>, legs: Record<string, Journey> | undefined, options: HoursScheduleOptions): HoursSchedule {
  const temporary: Day = { ...day, items: day.items.map(item => ({ ...item })) };
  let result = schedule(temporary, places, legs, options.context);
  const waits = new Map<string, number>();
  for (let index = 0; index < day.items.length; index++) {
    const item = day.items[index], row = result.rows[index];
    if (item.fixed !== null || item.mode === 'flight' || item.flightId || item.departureForFlightId || item.duration <= 0) continue;
    const waiting = openingWaitMinutes(options.hours[item.placeId], scheduleVisitWindow(row, options.date));
    if (!waiting) continue;
    temporary.items[index].fixed = row.start + waiting;
    waits.set(item.aid, waiting);
    result = schedule(temporary, places, legs, options.context);
  }
  return { ...result, rows: result.rows.map((row, index) => ({ ...row, it: day.items[index],
    ...(waits.has(row.it.aid) ? { openingWaitMinutes: waits.get(row.it.aid) } : {}) })) };
}

export interface HoursFixInput {
  trip: Trip;
  dayIndex: number;
  activityId: string;
  places: Record<string, Place>;
  hours: HoursByPlace;
  locks?: string[];
}
export interface HoursFixEvaluation {
  schedule: HoursSchedule;
  checks: Record<string, VisitHoursCheck>;
}
export interface HoursFix {
  kind: 'reorder' | 'move-day';
  label: string;
  detail: string;
  activityId: string;
  fromDayId: string;
  toDayId: string;
  insertIndex: number;
  inputSignature: string;
  verifiedAt: number;
  /** Real route results can be shown while the live route hook catches up after Apply. */
  legsByDayId: Record<string, Record<string, Journey>>;
  evaluationsByDayId: Record<string, HoursFixEvaluation>;
}
export type HoursRouteResolver = (candidateTrip: Trip, dayIndex: number, current: () => boolean) => Promise<Record<string, Journey>>;

/** Notes and booking references are deliberately excluded; edits to them survive Apply. */
export function hoursFixSignature(trip: Trip): string {
  return JSON.stringify({ id: trip.id, startDate: trip.startDate, timezone: trip.timezone,
    places: Object.entries(trip.customPlaces).sort(([a], [b]) => a.localeCompare(b)).map(([id, place]) => ({
      id, googlePlaceId: place.googlePlaceId, lat: place.lat, lng: place.lng, lastEntryMinutes: place.lastEntryMinutes,
    })),
    days: trip.days.map(({ items, title: _title, label: _label, date: _date, ...day }) => ({ ...day,
      items: items.map(({ note: _note, ...item }) => item) })),
    flights: trip.flights?.map(({ id, fromPlaceId, toPlaceId, departure, arrival, airportBufferMinutes, arrivalBufferMinutes }) =>
      ({ id, fromPlaceId, toPlaceId, departure, arrival, airportBufferMinutes, arrivalBufferMinutes })),
  });
}
const isAnchor = (item: Activity) => item.mode === 'flight' || Boolean(item.flightId || item.departureForFlightId);
const issueRank = (check: VisitHoursCheck | undefined) => check?.status === 'closed' ? 2 : check?.status === 'short' ? 1 : 0;
function assertCurrent(current: () => boolean) {
  if (!current()) throw new DOMException('The trip changed while checking opening hours.', 'AbortError');
}
function evaluate(input: HoursFixInput, trip: Trip, dayIndex: number, legs: Record<string, Journey>): HoursFixEvaluation {
  const date = bookingDayDate(trip, dayIndex);
  const result = scheduleWithOpeningHours(trip.days[dayIndex], input.places, legs, { date, hours: input.hours, context: { trip, dayIndex } });
  const checks = Object.fromEntries(result.rows.filter(row => !isAnchor(row.it)).map(row => [row.it.aid,
    checkVisitHours(input.hours[row.it.placeId], { ...scheduleVisitWindow(row, date), allowWait: row.it.fixed === null })]));
  return { schedule: result, checks };
}
function safeChange(before: HoursFixEvaluation, after: HoursFixEvaluation, day: Day): boolean {
  if (after.schedule.unknown || after.schedule.finishApprox || after.schedule.late > before.schedule.late) return false;
  if (day.finishBy != null && Math.max(0, after.schedule.finish - day.finishBy) > Math.max(0, before.schedule.finish - day.finishBy)) return false;
  for (const row of after.schedule.rows) {
    const previous = before.schedule.rows.find(item => item.it.aid === row.it.aid);
    if (row.late > (previous?.late ?? 0)) return false;
    const oldCheck = before.checks[row.it.aid], nextCheck = after.checks[row.it.aid];
    if (issueRank(nextCheck) > issueRank(oldCheck)) return false;
    if (oldCheck && oldCheck.status !== 'unknown' && nextCheck?.status === 'unknown') return false;
    if (oldCheck?.status === 'short' && nextCheck?.status === 'short' && (nextCheck.availableMinutes ?? 0) < (oldCheck.availableMinutes ?? 0)) return false;
  }
  return true;
}
function candidateTrip(input: HoursFixInput, toDayIndex: number, insertIndex: number): Trip {
  const candidate = { ...input.trip, days: input.trip.days.map(day => ({ ...day, items: [...day.items] })) };
  const source = candidate.days[input.dayIndex], index = source.items.findIndex(item => item.aid === input.activityId);
  const [item] = source.items.splice(index, 1);
  candidate.days[toDayIndex].items.splice(insertIndex, 0, item);
  return candidate;
}
/** Protect a booked airport finish even when a traveller has edited the day finish goal. */
export function airportFinishGoal(trip: Trip, dayIndex: number): number | null | undefined {
  const day = trip.days[dayIndex];
  if (dayHasFlight(day)) return undefined; // Linked flight journeys are checked by schedule().
  const date = bookingDayDate(trip, dayIndex);
  const matches = (trip.flights ?? []).flatMap(flight => {
    if (flight.fromPlaceId !== (day.endPlaceId ?? 'hotel')) return [];
    const timing = flightTiming(flight);
    const goalDate = timing.departureGoalMs === null ? flight.departure.date : localDateAt(timing.departureGoalMs, flight.departure.timezone);
    return goalDate === date ? [{ flight, timing }] : [];
  });
  if (!matches.length) return undefined;
  const exact = matches.filter(({ timing }) => timing.departureGoalMs !== null && day.finishBy === Math.round(dayMinutesAt(timing.departureGoalMs, date, dayTimezone(trip, day))));
  const selected = matches.length === 1 ? matches[0] : exact.length === 1 ? exact[0] : null;
  return !selected || selected.timing.status !== 'ready' || selected.timing.departureGoalMs === null ? null
    : dayMinutesAt(selected.timing.departureGoalMs, date, dayTimezone(trip, day));
}
/** Nearest legal insertion first, verified using provider routes for every affected day.
 * No straight-line travel fallback, assumed transit duration, or speculative "fix" is accepted.
 */
export async function findOpeningHoursFix(input: HoursFixInput, resolveRoutes: HoursRouteResolver, current: () => boolean = () => true): Promise<HoursFix | null> {
  assertCurrent(current);
  const day = input.trip.days[input.dayIndex];
  const sourceIndex = day?.items.findIndex(item => item.aid === input.activityId) ?? -1;
  const item = day?.items[sourceIndex];
  if (!item || item.fixed !== null || isAnchor(item) || input.locks?.includes(item.aid)) return null;
  const baselines = new Map<number, { legs: Record<string, Journey>; evaluation: HoursFixEvaluation }>();
  const baseline = async (index: number) => {
    if (!baselines.has(index)) {
      const legs = await resolveRoutes(input.trip, index, current); assertCurrent(current);
      baselines.set(index, { legs, evaluation: evaluate(input, input.trip, index, legs) });
    }
    return baselines.get(index)!;
  };
  const original = await baseline(input.dayIndex);
  if (original.evaluation.checks[item.aid]?.status !== 'closed' || original.evaluation.schedule.unknown || original.evaluation.schedule.finishApprox) return null;
  const attempt = async (target: number, insertIndex: number): Promise<HoursFix | null> => {
    assertCurrent(current);
    const candidate = candidateTrip(input, target, insertIndex);
    if (candidate.days.some((_, index) => !incomingFlightStartIssue(input.trip, index) && incomingFlightStartIssue(candidate, index))) return null;
    const affected = [...new Set([input.dayIndex, target])];
    const legsByDayId: HoursFix['legsByDayId'] = {}, evaluationsByDayId: HoursFix['evaluationsByDayId'] = {};
    for (const index of affected) {
      const before = await baseline(index);
      const legs = await resolveRoutes(candidate, index, current); assertCurrent(current);
      const after = evaluate(input, candidate, index, legs);
      if (!safeChange(before.evaluation, after, candidate.days[index])) return null;
      const airportGoal = airportFinishGoal(candidate, index);
      if (airportGoal === null || airportGoal !== undefined
        && Math.max(0, after.schedule.finish - airportGoal) > Math.max(0, before.evaluation.schedule.finish - airportGoal)) return null;
      legsByDayId[candidate.days[index].id] = legs;
      evaluationsByDayId[candidate.days[index].id] = after;
    }
    const result = evaluationsByDayId[candidate.days[target].id];
    if (result.checks[item.aid]?.status !== 'fits') return null;
    const following = candidate.days[target].items[insertIndex + 1];
    const preceding = candidate.days[target].items[insertIndex - 1];
    const label = target !== input.dayIndex ? `Move to ${candidate.days[target].label}`
      : following ? `Visit before ${input.places[following.placeId]?.name ?? 'the next stop'}`
        : preceding ? `Visit after ${input.places[preceding.placeId]?.name ?? 'the previous stop'}` : 'Move earlier';
    return { kind: target === input.dayIndex ? 'reorder' : 'move-day', label,
      detail: 'Checked with current route estimates. Keeps your bookings and other stops in order.',
      activityId: item.aid, fromDayId: day.id, toDayId: candidate.days[target].id, insertIndex,
      inputSignature: hoursFixSignature(input.trip), verifiedAt: Date.now(), legsByDayId, evaluationsByDayId };
  };
  // Fixed booking times stay fixed; flexible visits may cross them if they still arrive on time.
  // Flight/departure anchors and explicit locks retain the same surrounding segment.
  const barrier = (activity: Activity) => isAnchor(activity) || input.locks?.includes(activity.aid);
  const left = day.items.slice(0, sourceIndex).reduce((last, activity, index) => barrier(activity) ? index + 1 : last, 0);
  const rightFound = day.items.findIndex((activity, index) => index > sourceIndex && barrier(activity));
  const right = rightFound < 0 ? day.items.length - 1 : rightFound - 1;
  const positions = Array.from({ length: Math.max(0, right - left + 1) }, (_, index) => left + index)
    .filter(index => index !== sourceIndex).sort((a, b) => Math.abs(a - sourceIndex) - Math.abs(b - sourceIndex) || a - b);
  for (const position of positions) { const fix = await attempt(input.dayIndex, position); if (fix) return fix; }
  const otherDays = input.trip.days.map((_, index) => index).filter(index => index !== input.dayIndex)
    .sort((a, b) => Math.abs(a - input.dayIndex) - Math.abs(b - input.dayIndex) || a - b);
  for (const target of otherDays) {
    const targetDay = input.trip.days[target];
    if (targetDay.items.length >= 100) continue;
    // Keep the new stop after an arrival flight and before airport check-in / departure.
    let first = 0, last = targetDay.items.length;
    targetDay.items.forEach((activity, index) => {
      if (activity.mode === 'flight') first = index + 1;
      if (activity.departureForFlightId) last = Math.min(last, index);
    });
    for (let position = first; position <= last; position++) { const fix = await attempt(target, position); if (fix) return fix; }
  }
  return null;
}

/** Apply only a still-current proposal, moving the live object so notes cannot be overwritten. */
export function applyOpeningHoursFix(trip: Trip, fix: HoursFix, now = Date.now()): void {
  if (hoursFixSignature(trip) !== fix.inputSignature || now < fix.verifiedAt || now - fix.verifiedAt > 5 * 60_000) {
    throw new Error('The trip or route check changed. Check this opening-hours fix again.');
  }
  const from = trip.days.find(day => day.id === fix.fromDayId), to = trip.days.find(day => day.id === fix.toDayId);
  const index = from?.items.findIndex(item => item.aid === fix.activityId) ?? -1;
  if (!from || !to || index < 0 || !Number.isInteger(fix.insertIndex) || fix.insertIndex < 0
    || fix.insertIndex > to.items.length - (from === to ? 1 : 0)) throw new Error('This stop moved. Check the fix again.');
  const [item] = from.items.splice(index, 1);
  to.items.splice(fix.insertIndex, 0, item);
}
