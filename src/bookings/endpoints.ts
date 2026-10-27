import {
  bookingDayDate, dayMinutesAt, dayStartTime, dayTimezone, flightTiming, getPlaces, isTimezone, isTrip,
  type AccommodationBooking, type Trip,
} from '../model';
import {setDayEndpoints} from './actions';
import {appliedFlightBoundaries, flightDayBoundary, saveTripFlight} from './journey';

export type EndpointSide = 'start' | 'end';
export type DayEndpointChoice = {kind: 'flight' | 'stay'; id: string} | {kind: 'place'; placeId: string};
export interface EndpointTiming {startTime?: number; finishBy?: number | null; timezone?: string}
export interface DayEndpointOption {
  choice: {kind: 'flight' | 'stay'; id: string}; kind: 'flight' | 'stay'; id: string; placeId: string;
  date: string; time: number | null; timezone: string; disabled: boolean; enabled: boolean; issue?: string;
}

function coversEndpoint(stay: AccommodationBooking, date: string, endpoint: EndpointSide) {
  return endpoint === 'start' ? stay.checkInDate < date && stay.checkOutDate >= date
    : stay.checkInDate <= date && stay.checkOutDate > date;
}

/** Booked choices are local to this day: yesterday's stay, tonight's stay, or its airport boundary. */
export function listEndpointChoices(trip: Trip, dayId: string, endpoint: EndpointSide): DayEndpointOption[] {
  const dayIndex = trip.days.findIndex(day => day.id === dayId), day = trip.days[dayIndex];
  if (!day) return [];
  const date = bookingDayDate(trip, dayIndex), intent = endpoint === 'start' ? 'arrival' : 'departure';
  const flights: DayEndpointOption[] = (trip.flights ?? []).flatMap(flight => {
    const boundary = flightDayBoundary(trip, flight, intent);
    if (boundary.date !== date) return [];
    return [{choice: {kind: 'flight' as const, id: flight.id}, kind: 'flight' as const, id: flight.id, placeId: boundary.placeId,
      date, time: boundary.minutes, timezone: boundary.timezone, disabled: !boundary.ready, enabled: boundary.ready,
      ...(boundary.issue ? {issue: boundary.issue} : {})}];
  });
  const stays: DayEndpointOption[] = (trip.stays ?? []).filter(stay => coversEndpoint(stay, date, endpoint)).map(stay => ({
    choice: {kind: 'stay', id: stay.id}, kind: 'stay', id: stay.id, placeId: stay.placeId, date,
    time: endpoint === 'start' ? dayStartTime(day) : day.finishBy ?? null,
    timezone: dayTimezone(trip, day), disabled: false, enabled: true,
  }));
  return [...flights, ...stays];
}

function clearExactDepartureGoal(trip: Trip, dayId: string, nextPlaceId: string) {
  const dayIndex = trip.days.findIndex(day => day.id === dayId), day = trip.days[dayIndex];
  if (!day || nextPlaceId === (day.endPlaceId ?? 'hotel') || day.finishBy == null) return;
  const boundary = appliedFlightBoundaries(trip, dayId);
  const matches = boundary.departure ? [boundary.departure] : boundary.departureCandidates;
  const exact = matches.some(flight => {
    const goal = flightTiming(flight).departureGoalMs;
    return goal !== null && Math.round(dayMinutesAt(goal, bookingDayDate(trip, dayIndex), dayTimezone(trip, day))) === day.finishBy;
  });
  if (exact) day.finishBy = null;
}

/** Commit one chosen endpoint; every other day, booking and visit retains its identity. */
export function applyDayEndpoint(trip: Trip, dayId: string, endpoint: EndpointSide, choice: DayEndpointChoice, timing: EndpointTiming = {}) {
  const dayIndex = trip.days.findIndex(day => day.id === dayId);
  if (dayIndex < 0) throw Error('This day changed. Open its start or end location again.');
  const draft = structuredClone(trip), day = draft.days[dayIndex], date = bookingDayDate(draft, dayIndex);
  if (choice.kind === 'flight') {
    const flight = draft.flights?.find(item => item.id === choice.id);
    if (!flight) throw Error('This flight changed. Choose a booking again.');
    const intent = endpoint === 'start' ? 'arrival' : 'departure', boundary = flightDayBoundary(draft, flight, intent);
    if (boundary.dayId !== dayId) throw Error('This flight’s airport transfer belongs to another day. Choose a flight for this date.');
    if (!boundary.ready) throw Error(boundary.issue || 'Confirm the flight times before choosing this airport boundary.');
    // Canonical booking times take precedence over stale text-input drafts.
    saveTripFlight(draft, flight, {intent, applyToDay: true});
  } else {
    const stay = choice.kind === 'stay' ? draft.stays?.find(item => item.id === choice.id) : undefined;
    if (choice.kind === 'stay' && !stay) throw Error('This accommodation changed. Choose a stay again.');
    if (stay && !coversEndpoint(stay, date, endpoint)) throw Error(endpoint === 'start'
      ? 'Choose the stay covering the previous night for this day’s start.'
      : 'Choose the stay covering this night for this day’s end.');
    const placeId = choice.kind === 'place' ? choice.placeId : stay!.placeId;
    if (!Object.hasOwn(getPlaces(draft), placeId)) throw Error('Choose a saved location for this day.');
    if (endpoint === 'end') clearExactDepartureGoal(draft, dayId, placeId);
    if (timing.timezone !== undefined) {
      if (!isTimezone(timing.timezone)) throw Error('Choose a valid time zone for this day.');
      day.timezone = timing.timezone;
    }
    setDayEndpoints(draft, dayId, endpoint === 'start' ? placeId : day.startPlaceId ?? 'hotel', endpoint === 'end' ? placeId : day.endPlaceId ?? 'hotel');
    if (endpoint === 'start') {
      if (stay) day.startStayId = stay.id; else delete day.startStayId;
      if (timing.startTime !== undefined) day.startTime = timing.startTime;
    } else {
      if (stay) day.endStayId = stay.id; else delete day.endStayId;
      if (timing.finishBy !== undefined) day.finishBy = timing.finishBy;
    }
  }
  // Existing action helpers may refresh linked anchors elsewhere. A one-day
  // picker must not rewrite a different day's explicitly chosen appointments.
  draft.days = draft.days.map((value, index) => index === dayIndex ? value : structuredClone(trip.days[index]));
  if (!isTrip(draft)) throw Error('Check this day’s start and finish times. The finish goal must be after the start, and existing flight links must stay connected.');
  Object.assign(trip, draft);
}
