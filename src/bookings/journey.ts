import {
  accommodationSuggestions, bookingDayDate, dayHasFlight, dayMinutesAt, dayStartTime, dayTimezone,
  flightTiming, isFlight, isStay, isTrip, localDateAt,
  type AccommodationBooking, type FlightSegment, type GroundMode, type Trip,
} from '../model';
import {applyStay, extendTripRange, saveFlight, saveStay} from './actions';

export type FlightIntent = 'arrival' | 'departure';
export interface TripFlightOptions {intent?: FlightIntent; applyToDay?: boolean; extendTrip?: boolean; transferMode?: GroundMode}
export interface TripStayOptions {applyToDays?: boolean; extendTrip?: boolean}
export interface FlightDayBoundary {
  intent: FlightIntent; date: string; dayIndex: number; dayId?: string; placeId: string; timezone: string;
  minutes: number | null; minute: number | null; ready: boolean; issues: string[]; issue?: string;
}
export interface BookingNight {date: string; dayId: string; stayIds: string[]; status: 'missing' | 'booked' | 'overlap'}
export interface AppliedFlightBoundaries {
  arrival: FlightSegment | null; departure: FlightSegment | null;
  arrivalCandidates: FlightSegment[]; departureCandidates: FlightSegment[];
  ambiguousArrival: boolean; ambiguousDeparture: boolean;
}

/** A calendar date uses the relevant airport's zone, not the browser's zone. */
function boundaryMoment(flight: FlightSegment, intent: FlightIntent) {
  const timing = flightTiming(flight), moment = intent === 'arrival' ? flight.arrival : flight.departure;
  const timestamp = intent === 'arrival' ? timing.arrivalReadyMs : timing.departureGoalMs;
  const date = timestamp === null ? moment.date : localDateAt(timestamp, moment.timezone);
  return {timing, timestamp, date, timezone: moment.timezone};
}

/** Preview the actual day change. An outside date may be explicitly added on save. */
export function flightDayBoundary(trip: Trip, flight: FlightSegment, intent: FlightIntent): FlightDayBoundary {
  const {timing, timestamp, date, timezone: airportZone} = boundaryMoment(flight, intent);
  const dayIndex = trip.days.findIndex((_, index) => bookingDayDate(trip, index) === date), day = trip.days[dayIndex];
  const timezone = intent === 'arrival' ? airportZone : day ? dayTimezone(trip, day) : airportZone;
  const minutes = timestamp === null ? null : Math.round(dayMinutesAt(timestamp, date, timezone));
  const issues = timing.status === 'ready' ? [] : timing.issues.length ? [...timing.issues] : ['Confirm both flight times before using this flight in your day plan.'];
  if (minutes !== null && (minutes < 0 || minutes >= 1440)) issues.push('The airport time falls on a different date in this day’s time zone. Review the day’s time zone first.');
  if (day && dayHasFlight(day)) issues.push('This day already contains a linked flight journey. Unlink that journey in Flights & stays before using an arrival or departure boundary. Your stops will be kept.');
  if (day && minutes !== null && intent === 'departure' && minutes <= dayStartTime(day)) issues.push('The airport arrival goal is before this day starts. Choose an earlier start time from the day’s Start control, or save the flight without applying it yet.');
  if (day && minutes !== null && intent === 'arrival' && day.finishBy != null && minutes >= day.finishBy) issues.push('You will leave the arrival airport after this day’s finish goal. Review the finish goal from the day’s End control, or save the flight without applying it yet.');
  return {intent, date, dayIndex, ...(day ? {dayId: day.id} : {}), placeId: intent === 'arrival' ? flight.toPlaceId : flight.fromPlaceId,
    timezone, minutes, minute: minutes, ready: timing.status === 'ready' && minutes !== null && !issues.length, issues,
    ...(issues.length ? {issue: issues.join(' ')} : {})};
}

/** Multiple matches remain explicit choices; never guess between connection flights. */
export function tripBookingSummary(trip: Trip) {
  const lastDate = bookingDayDate(trip, trip.days.length - 1);
  const arrivals = (trip.flights ?? []).filter(flight => {
    const moment = boundaryMoment(flight, 'arrival');
    return flight.arrival.date === trip.startDate || moment.date === trip.startDate && flight.arrival.date < trip.startDate;
  });
  const departures = (trip.flights ?? []).filter(flight => flight.departure.date === lastDate || boundaryMoment(flight, 'departure').date === lastDate);
  const nights: BookingNight[] = trip.days.slice(0, -1).map((day, index) => {
    const date = bookingDayDate(trip, index);
    const stayIds = (trip.stays ?? []).filter(stay => stay.checkInDate <= date && stay.checkOutDate > date).map(stay => stay.id);
    return {date, dayId: day.id, stayIds, status: stayIds.length === 0 ? 'missing' : stayIds.length === 1 ? 'booked' : 'overlap'};
  });
  return {arrivals, departures, arrivalFlights: arrivals, departureFlights: departures,
    arrival: arrivals.length === 1 ? arrivals[0] : null, departure: departures.length === 1 ? departures[0] : null,
    nights, totalNights: nights.length, bookedNights: nights.filter(night => night.stayIds.length > 0).length,
    missingNights: nights.filter(night => night.status === 'missing').length,
    overlappingNights: nights.filter(night => night.status === 'overlap').length};
}

/** Airport + calendar day association keeps warnings visible after a manual time edit. */
export function appliedFlightBoundaries(trip: Trip, dayId: string): AppliedFlightBoundaries {
  const dayIndex = trip.days.findIndex(day => day.id === dayId), day = trip.days[dayIndex];
  if (!day || dayHasFlight(day)) return {arrival: null, departure: null, arrivalCandidates: [], departureCandidates: [], ambiguousArrival: false, ambiguousDeparture: false};
  const date = bookingDayDate(trip, dayIndex);
  const arrivals = (trip.flights ?? []).filter(flight => flight.toPlaceId === (day.startPlaceId ?? 'hotel') && boundaryMoment(flight, 'arrival').date === date);
  const departures = (trip.flights ?? []).filter(flight => flight.fromPlaceId === (day.endPlaceId ?? 'hotel') && boundaryMoment(flight, 'departure').date === date);
  const choose = (candidates: FlightSegment[], intent: FlightIntent) => {
    if (candidates.length === 1) return candidates[0];
    const exact = candidates.filter(flight => {
      const moment = boundaryMoment(flight, intent);
      return moment.timestamp !== null && Math.round(dayMinutesAt(moment.timestamp, date, dayTimezone(trip, day))) === (intent === 'arrival' ? dayStartTime(day) : day.finishBy);
    });
    return exact.length === 1 ? exact[0] : null;
  };
  const arrival = choose(arrivals, 'arrival'), departure = choose(departures, 'departure');
  return {arrival, departure, arrivalCandidates: arrivals, departureCandidates: departures,
    ambiguousArrival: arrivals.length > 1 && !arrival, ambiguousDeparture: departures.length > 1 && !departure};
}

function assertValid(trip: Trip) {
  if (!isTrip(trip)) throw Error('This change would break a flight or stay link. Review the booking and day plan before saving.');
}

/** Detach only an exact earlier generated boundary, never a traveller's retimed endpoint. */
function clearPreviousBoundary(trip: Trip, flight: FlightSegment, intent: FlightIntent) {
  const moment = boundaryMoment(flight, intent), dayIndex = trip.days.findIndex((_, index) => bookingDayDate(trip, index) === moment.date), day = trip.days[dayIndex];
  if (!day || moment.timestamp === null || moment.timing.status !== 'ready' || dayHasFlight(day)) return;
  const minute = Math.round(dayMinutesAt(moment.timestamp, moment.date, dayTimezone(trip, day)));
  if (intent === 'arrival' && day.startPlaceId === flight.toPlaceId && dayStartTime(day) === minute && !day.startStayId) {
    day.startPlaceId = 'hotel'; day.startTime = 540;
    // A previous arrival may have established the local zone. Keep it: resetting
    // other existing appointment clocks to the trip default would be surprising.
    if (day.finishBy != null && day.finishBy <= day.startTime) day.startTime = Math.max(0, day.finishBy - 1);
    const suggestion = accommodationSuggestions(trip)[dayIndex];
    if (suggestion.startStayId) {day.startStayId = suggestion.startStayId; day.startPlaceId = suggestion.startPlaceId;}
  }
  if (intent === 'departure' && day.endPlaceId === flight.fromPlaceId && day.finishBy === minute && !day.endStayId) {
    day.endPlaceId = 'hotel'; day.finishBy = null;
    const suggestion = accommodationSuggestions(trip)[dayIndex];
    if (suggestion.endStayId) {day.endStayId = suggestion.endStayId; day.endPlaceId = suggestion.endPlaceId;}
  }
}

/** One transaction saves the booking and its accepted ground-day change. Stops retain identity. */
export function saveTripFlight(trip: Trip, flight: FlightSegment, options: TripFlightOptions = {}) {
  if (!isFlight(flight)) throw Error('Check the flight’s airports, dates, time zones and details.');
  const draft = structuredClone(trip), previous = draft.flights?.find(item => item.id === flight.id);
  if (options.intent && options.applyToDay && previous) clearPreviousBoundary(draft, previous, options.intent);
  saveFlight(draft, flight);
  if (options.intent && options.applyToDay) {
    let boundary = flightDayBoundary(draft, flight, options.intent);
    if (boundary.dayIndex < 0 && options.extendTrip) {
      // The origin/return flight can be outside the holiday. Only include the day
      // needed for this ground boundary, not the other airport's calendar date.
      extendTripRange(draft, boundary.date, boundary.date);
      boundary = flightDayBoundary(draft, flight, options.intent);
    }
    if (boundary.dayIndex < 0) throw Error('This airport transfer falls outside the trip dates. Extend the trip dates, or save the booking without applying it.');
    if (!boundary.ready || boundary.minutes === null) throw Error(boundary.issue || 'Confirm this flight’s times before using it in the day plan.');
    const day = draft.days[boundary.dayIndex];
    if (options.intent === 'arrival') {
      day.startPlaceId = flight.toPlaceId; day.startTime = boundary.minutes; day.timezone = boundary.timezone; delete day.startStayId;
      if (options.transferMode) {
        if (day.items.length) day.items[0].mode = options.transferMode;
        else day.endMode = options.transferMode;
      }
    } else {
      day.endPlaceId = flight.fromPlaceId; day.finishBy = boundary.minutes; delete day.endStayId;
      if (options.transferMode) day.endMode = options.transferMode;
    }
  }
  assertValid(draft);
  Object.assign(trip, draft);
}

/** Nights determine endpoints; chosen airports/custom endpoints and overlapping stays survive. */
export function saveTripStay(trip: Trip, stay: AccommodationBooking, options: TripStayOptions = {}) {
  if (!isStay(stay)) throw Error('Check the stay’s dates, time zone and details.');
  const draft = structuredClone(trip);
  const previous = draft.stays?.find(item => item.id === stay.id);
  const accepted = previous ? new Map(draft.days.map(day => [day.id, {
    start: day.startStayId === stay.id && day.startPlaceId === previous.placeId,
    end: day.endStayId === stay.id && day.endPlaceId === previous.placeId,
  }])) : new Map<string, {start: boolean; end: boolean}>();
  if (options.extendTrip) extendTripRange(draft, stay.checkInDate, stay.checkOutDate);
  saveStay(draft, stay);
  if (options.applyToDays) {
    const cleared = new Map<string, {start: boolean; end: boolean}>();
    for (const day of draft.days) {
      const old = accepted.get(day.id);
      const start = Boolean(old?.start && !day.startStayId && day.items[0]?.mode !== 'flight');
      const end = Boolean(old?.end && !day.endStayId && day.endMode !== 'flight');
      if (start) day.startPlaceId = 'hotel';
      if (end) day.endPlaceId = 'hotel';
      if (start || end) cleared.set(day.id, {start, end});
    }
    applyStay(draft, stay.id);
    // Shortening a previously accepted booking frees its expired nights for
    // another already-booked stay. It must not strand the old hotel as a manual override.
    for (const suggestion of accommodationSuggestions(draft)) {
      const changed = cleared.get(suggestion.dayId), day = draft.days[suggestion.dayIndex];
      if (changed?.start && suggestion.startStayId) {day.startStayId = suggestion.startStayId; day.startPlaceId = suggestion.startPlaceId;}
      if (changed?.end && suggestion.endStayId) {day.endStayId = suggestion.endStayId; day.endPlaceId = suggestion.endPlaceId;}
    }
  }
  assertValid(draft);
  Object.assign(trip, draft);
}
