export interface FlightMoment {
  date: string;
  time: string | null;
  timezone: string;
  /** UTC offset in minutes east of Greenwich, required to choose a repeated DST hour. */
  offsetMinutes?: number;
}

export interface FlightSegment {
  id: string;
  fromPlaceId: string;
  toPlaceId: string;
  departure: FlightMoment;
  arrival: FlightMoment;
  airline?: string;
  flightNumber?: string;
  departureTerminal?: string;
  arrivalTerminal?: string;
  departureGate?: string;
  arrivalGate?: string;
  bookingReference?: string;
  privateNotes?: string;
  airportBufferMinutes?: number;
  arrivalBufferMinutes?: number;
  groupId?: string;
}

export interface AccommodationBooking {
  id: string;
  placeId: string;
  checkInDate: string;
  checkOutDate: string;
  timezone: string;
  checkInTime?: string;
  checkOutTime?: string;
  bookingReference?: string;
  contact?: string;
  bookingUrl?: string;
  privateNotes?: string;
}

export interface ResolvedFlightMoment {
  status: 'ready' | 'incomplete' | 'invalid' | 'ambiguous';
  timestamp: number | null;
  candidates: { timestamp: number; offsetMinutes: number }[];
  reason?: string;
}

export interface FlightTiming {
  status: 'ready' | 'incomplete' | 'invalid' | 'ambiguous';
  departureMs: number | null;
  arrivalMs: number | null;
  durationMinutes: number | null;
  departureGoalMs: number | null;
  arrivalReadyMs: number | null;
  issues: string[];
}
