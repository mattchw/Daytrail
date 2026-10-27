import type {Activity, Day, FlightSegment, Mode, Place, Trip} from '../model';

export type TravelMark = 'planned' | 'done' | 'skipped';
export type TravelMarks = Readonly<Record<string, TravelMark>>;
export interface TravelTarget {
  id: string;
  kind: 'activity' | 'end' | 'flight';
  dayId: string;
  placeId: string;
  mode: Mode;
  activity?: Activity;
  flight?: FlightSegment;
}

/** Visits and flights keep separate stable identities, including arrival-day views. */
export function travelTargets(day: Day, trip?: Pick<Trip, 'startDate' | 'days' | 'flights'>): TravelTarget[] {
  const flights = new Map(trip?.flights?.map(flight => [flight.id, flight]) ?? []);
  const targets: TravelTarget[] = [], seen = new Set<string>();
  const append = (target:TravelTarget) => { if (!seen.has(target.id)) { targets.push(target); seen.add(target.id); } };
  const appendFlight = (flightId:string | undefined) => {
    const flight = flightId ? flights.get(flightId) : undefined;
    if (!flight) return false;
    append({id:`flight:${flight.id}`,kind:'flight',dayId:day.id,placeId:flight.toPlaceId,mode:'flight',flight});
    return true;
  };
  // A long/overnight flight is still actionable on its arrival date. Its mark is
  // shared with the departure-day card; there is no second completion record.
  const dayIndex = trip?.days.findIndex(value => value.id === day.id) ?? -1;
  const date = trip && dayIndex >= 0 ? travelDayDate(trip.startDate, dayIndex) : null;
  if (trip && date && dayIndex > 0) {
    const linkedBefore = new Set(trip.days.slice(0,dayIndex).flatMap(previous => [
      ...previous.items.filter(item => item.mode === 'flight').map(item => item.flightId),
      ...(previous.endMode === 'flight' ? [previous.endFlightId] : []),
    ]));
    for (const flight of trip.flights ?? []) if (linkedBefore.has(flight.id) && flight.arrival.date === date) appendFlight(flight.id);
  }
  for (const activity of day.items) {
    const hasFlight = activity.mode === 'flight' && appendFlight(activity.flightId);
    if (hasFlight && activity.duration === 0) continue;
    append({id:`activity:${activity.aid}`,kind:'activity',dayId:day.id,placeId:activity.placeId,
      // A visit after landing is at the airport; it must never generate a flight directions URL.
      mode:activity.mode === 'flight' ? 'walk' : activity.mode,activity});
  }
  if (day.endMode === 'flight' && appendFlight(day.endFlightId)) return targets;
  if (day.items.length || (day.startPlaceId ?? 'hotel') !== (day.endPlaceId ?? 'hotel')) {
    append({id:`end:${day.id}`,kind:'end',dayId:day.id,placeId:day.endPlaceId ?? 'hotel',mode:day.endMode});
  }
  return targets;
}

/** Deduplicate cross-day projections before comparing controller/hook identities. */
export function travelTargetReferences(trip:Pick<Trip,'startDate'|'days'|'flights'>): Record<string,string> {
  return Object.fromEntries(trip.days.flatMap(day => travelTargets(day,trip)).map(target => [target.id,target.placeId]));
}

export function targetState(marks: TravelMarks, targetId: string): TravelMark {
  return marks[targetId] === 'done' || marks[targetId] === 'skipped' ? marks[targetId] : 'planned';
}

/** The clock never advances progress. An end point follows all remaining visits. */
export function nextTravelTarget(targets: readonly TravelTarget[], marks: TravelMarks, preferredId?: string | null): TravelTarget | null {
  const remaining = targets.filter(target => target.kind !== 'end' && targetState(marks, target.id) === 'planned');
  if (remaining.length) return remaining.find(target => target.id === preferredId) ?? remaining[0];
  return targets.find(target => target.kind === 'end' && targetState(marks, target.id) === 'planned') ?? null;
}

export function travelDayDate(startDate: string, dayIndex: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isInteger(dayIndex) || dayIndex < 0) return null;
  const date = new Date(`${startDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== startDate) return null;
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : null;
}

export function tripLocalDate(timezone: string, now: number | Date = Date.now()): string | null {
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { return null; }
}

export function todayTravelDay(trip: Pick<Trip, 'startDate' | 'timezone' | 'days'>, now: number | Date = Date.now()): number | null {
  const index = trip.days.findIndex((day, i) => {
    const date = tripLocalDate(day.timezone ?? trip.timezone, now);
    return date !== null && travelDayDate(trip.startDate, i) === date;
  });
  return index < 0 ? null : index;
}

export function initialTravelDay(trip: Pick<Trip, 'startDate' | 'timezone' | 'days'>, selectedIndex = 0, now: number | Date = Date.now()): number {
  return todayTravelDay(trip, now) ?? Math.max(0, Math.min(trip.days.length - 1, Number.isInteger(selectedIndex) ? selectedIndex : 0));
}

export function travelDateLabel(date: string | null): string {
  if (!date) return 'Date to confirm';
  return new Intl.DateTimeFormat('en-GB', {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'})
    .format(new Date(`${date}T12:00:00Z`));
}

export function travelPlaceName(place?: Place): string {
  return place?.userLabel?.trim() || place?.name?.trim() || 'Place to confirm';
}

/** Omit origin: Google Maps handles the traveller's current location and permission. */
export function travelDirectionsURL(place: Place | undefined, mode: Mode): string | null {
  if (!place || mode === 'flight' || mode !== 'walk' && mode !== 'drive' && mode !== 'transit') return null;
  const placeId = typeof place.googlePlaceId === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(place.googlePlaceId) ? place.googlePlaceId : null;
  const coordinates = typeof place.lat === 'number' && typeof place.lng === 'number'
    && Number.isFinite(place.lat) && Number.isFinite(place.lng)
    && Math.abs(place.lat) <= 90 && Math.abs(place.lng) <= 180 ? `${place.lat},${place.lng}` : null;
  if (!placeId && !coordinates) return null;
  const params = new URLSearchParams({api: '1', destination: placeId ? travelPlaceName(place) : coordinates!,
    travelmode: ({walk: 'walking', drive: 'driving', transit: 'transit'} as const)[mode]});
  if (placeId) params.set('destination_place_id', placeId);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
