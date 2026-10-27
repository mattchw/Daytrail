import type {Day, Trip} from '../model';
import {getStartingFlight} from './startingFlight';

/** A gap is identified by its neighbours, never by a possibly stale array index. */
export interface TimelineInsertionTarget {
  tripId: string;
  dayId: string;
  beforeAid: string | null;
  afterAid: string | null;
  /** An empty direct flight day has a conceptual gap after its landing. */
  directFlightId?: string;
}

const stale = () => Error('This part of the day has changed. Choose where to add the stop again.');

export function isTimelineInsertionAllowed(trip: Trip, day: Day, index: number): boolean {
  if (!trip.days.some(item => item.id === day.id) || !Number.isInteger(index) || index < 0 || index > day.items.length) return false;
  const next = day.items[index];
  // A normal stop cannot replace the airport immediately preceding a flight.
  if (next?.mode === 'flight' || next?.flightId) return false;
  if (index === day.items.length && (day.endMode === 'flight' || day.endFlightId)) {
    const starting = day.items.length === 0 ? getStartingFlight(trip, day) : null;
    return starting?.targetId === `end:${day.id}`;
  }
  return true;
}

export function createTimelineInsertion(trip: Trip, day: Day, index: number): TimelineInsertionTarget {
  if (!isTimelineInsertionAllowed(trip, day, index)) throw Error('Choose a position after the flight, or before its airport transfer. A stop cannot separate a flight from its departure airport.');
  const starting = day.items.length === 0 ? getStartingFlight(trip, day) : null;
  return {tripId: trip.id, dayId: day.id,
    beforeAid: index > 0 ? day.items[index - 1].aid : null,
    afterAid: index < day.items.length ? day.items[index].aid : null,
    ...(starting?.targetId === `end:${day.id}` ? {directFlightId: starting.flight.id} : {})};
}

function gapIndex(items: Day['items'], target: TimelineInsertionTarget): number {
  const before = target.beforeAid === null ? -1 : items.findIndex(item => item.aid === target.beforeAid);
  const after = target.afterAid === null ? items.length : items.findIndex(item => item.aid === target.afterAid);
  if (target.beforeAid !== null && before < 0 || target.afterAid !== null && after < 0 || after !== before + 1) throw stale();
  return after;
}

/** The returned index is relative to the destination after removing the moving activity. */
export function resolveTimelineInsertion(trip: Trip, target: TimelineInsertionTarget, movingAid?: string): {dayIndex: number; index: number} {
  if (target.tripId !== trip.id) throw stale();
  const dayIndex = trip.days.findIndex(day => day.id === target.dayId), day = trip.days[dayIndex];
  if (!day) throw stale();
  if (movingAid && !trip.days.some(item => item.items.some(activity => activity.aid === movingAid))) throw stale();
  if (target.directFlightId) {
    const starting = day.items.length === 0 ? getStartingFlight(trip, day) : null;
    if (target.beforeAid !== null || target.afterAid !== null || !starting || starting.flight.id !== target.directFlightId
      || starting.targetId !== `end:${day.id}` || !isTimelineInsertionAllowed(trip, day, 0)) throw stale();
    return {dayIndex, index: 0};
  }
  const movingIndex = movingAid ? day.items.findIndex(item => item.aid === movingAid) : -1;
  const items = movingIndex < 0 ? day.items : day.items.filter(item => item.aid !== movingAid);
  let index: number;
  if (movingAid && (target.beforeAid === movingAid || target.afterAid === movingAid)) {
    // Dropping immediately beside oneself is a no-op only while that original
    // adjacent gap still exists; do not ignore intervening collaborator edits.
    if (movingIndex < 0) throw stale();
    gapIndex(day.items, target);
    index = movingIndex;
  } else index = gapIndex(items, target);
  if (!isTimelineInsertionAllowed(trip, {...day, items}, index)) throw stale();
  return {dayIndex, index};
}
