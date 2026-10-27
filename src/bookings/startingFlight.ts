import {bookingDayDate, getPlaces, isFlight, type Day, type FlightSegment, type Trip} from '../model';

export interface StartingFlight {
  flight: FlightSegment;
  targetId: string;
  activityId?: string;
  arrivalIsDayEnd: boolean;
}

/** Group only a real first flight leg; a ground airport transfer keeps its own timeline row. */
export function getStartingFlight(trip: Trip, day: Day): StartingFlight | null {
  const dayIndex = trip.days.findIndex(item => item.id === day.id);
  if (dayIndex < 0) return null;
  const first = day.items[0];
  const flightId = first ? first.mode === 'flight' ? first.flightId : undefined
    : day.endMode === 'flight' ? day.endFlightId : undefined;
  if (!flightId) return null;
  const flight = trip.flights?.find(item => item.id === flightId);
  const from = day.startPlaceId ?? 'hotel', to = first?.placeId ?? day.endPlaceId ?? 'hotel';
  const places = getPlaces(trip);
  if (!flight || !isFlight(flight) || flight.departure.date !== bookingDayDate(trip, dayIndex)
    || flight.fromPlaceId !== from || flight.toPlaceId !== to
    || !Object.hasOwn(places, from) || !Object.hasOwn(places, to)) return null;
  return {flight, targetId: first ? `activity:${first.aid}` : `end:${day.id}`,
    ...(first ? {activityId: first.aid} : {}),
    arrivalIsDayEnd: !first || day.items.length === 1 && (day.endPlaceId ?? 'hotel') === flight.toPlaceId && day.endMode !== 'flight'};
}

/** Make room after a direct flight without making a newly added stop its departure airport. */
export function prepareStopInsertion(trip: Trip, day: Day, index?: number): number {
  const starting = getStartingFlight(trip, day);
  if (starting?.targetId === `end:${day.id}`) {
    day.items.push({aid: crypto.randomUUID(), placeId: starting.flight.toPlaceId, duration: 0, fixed: null,
      mode: 'flight', flightId: starting.flight.id, note: ''});
    delete day.endFlightId;
    day.endMode = 'walk';
    return 1;
  }
  const minimum = starting?.activityId ? 1 : 0;
  return index === undefined || !Number.isFinite(index) ? day.items.length : Math.max(minimum, Math.min(day.items.length, Math.floor(index)));
}
