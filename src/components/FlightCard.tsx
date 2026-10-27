import type {ReactNode} from 'react';
import {Clock, LockKeyhole, Pencil, Plane, PlaneLanding, PlaneTakeoff} from 'lucide-react';
import type {Place} from '../model';
import type {FlightMoment, FlightSegment} from '../bookings/types';
import {flightTiming} from '../bookings/model';
import './bookings.css';

export function bookingPlaceName(place: Place | undefined) {return place?.userLabel || place?.name || 'Location to confirm';}
export function bookingDate(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(value.getTime()) ? value.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}) : 'Date to confirm';
}
export function bookingDuration(minutes: number) {return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60 ? `${minutes % 60}m` : ''}`.trim() || '0m';}
function airportGoal(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone}).format(timestamp);
}
export function previousFlightConnection(flight: FlightSegment, flights: FlightSegment[]): FlightSegment | undefined {
  if (!flight.groupId) return undefined;
  const connected = flights.filter(item => item.id === flight.id || item.id === flight.groupId || item.groupId === flight.groupId)
    .sort((a, b) => {
      const first = flightTiming(a).departureMs, second = flightTiming(b).departureMs;
      return first !== null && second !== null ? first - second : `${a.departure.date}${a.departure.time || ''}`.localeCompare(`${b.departure.date}${b.departure.time || ''}`);
    });
  const index = connected.findIndex(item => item.id === flight.id);
  return index > 0 ? connected[index - 1] : undefined;
}
function FlightEndpoint({label, moment, place, terminal, gate}: {label: 'Departure' | 'Arrival'; moment: FlightMoment; place?: Place; terminal?: string; gate?: string}) {
  const Icon = label === 'Departure' ? PlaneTakeoff : PlaneLanding;
  return <div className="dt-flight-endpoint"><span className="dt-booking-kicker"><Icon size={14} aria-hidden="true"/>{label}</span><strong className="dt-flight-time">{moment.time || <span className="is-unknown">To confirm</span>}</strong><span className="dt-flight-date">{bookingDate(moment.date)}</span><h4>{bookingPlaceName(place)}</h4><small>{moment.timezone.replaceAll('_', ' ')}</small>{(terminal || gate) && <p className="dt-flight-terminal">{terminal && `Terminal ${terminal}`}{terminal && gate && ' · '}{gate && `Gate ${gate}`}</p>}</div>;
}

/** Private booking fields are opt-in, so the same card is safe in read-only snapshots. */
export default function FlightCard({flight, places, showPrivate = false, compact = false, onEdit, children, previousFlight}: {
  flight: FlightSegment; places: Record<string, Place>; showPrivate?: boolean; compact?: boolean; onEdit?: () => void; children?: ReactNode; previousFlight?: FlightSegment;
}) {
  const timing = flightTiming(flight);
  const previousTiming = previousFlight ? flightTiming(previousFlight) : null;
  const previousArrival = previousTiming?.status === 'ready' ? previousTiming.arrivalMs : null;
  const connectionMinutes = previousArrival !== null && timing.status === 'ready' && timing.departureMs !== null ? (timing.departureMs - previousArrival) / 60_000 : null;
  return <article className={`dt-flight-card ${compact ? 'is-compact' : ''}`}>
    <div className="dt-booking-card-heading"><span className="dt-booking-symbol"><Plane size={18} aria-hidden="true"/></span><div><span className="dt-booking-kicker">Flight</span><h3>{[flight.airline, flight.flightNumber].filter(Boolean).join(' · ') || 'Your flight'}</h3></div>{onEdit && <button type="button" className="dt-booking-icon" onClick={onEdit} aria-label={`Edit ${flight.flightNumber || 'flight'}`}><Pencil size={16} aria-hidden="true"/></button>}</div>
    <div className="dt-flight-route"><FlightEndpoint label="Departure" moment={flight.departure} place={places[flight.fromPlaceId]} terminal={flight.departureTerminal} gate={showPrivate ? flight.departureGate : undefined}/><div className="dt-flight-connector" aria-hidden="true"><span/><Plane size={17}/><span/></div><FlightEndpoint label="Arrival" moment={flight.arrival} place={places[flight.toPlaceId]} terminal={flight.arrivalTerminal} gate={showPrivate ? flight.arrivalGate : undefined}/></div>
    <div className="dt-flight-duration"><Clock size={14} aria-hidden="true"/>{timing.durationMinutes !== null ? `${bookingDuration(timing.durationMinutes)} flight · local times shown` : 'Flight duration to confirm · local times shown'}</div>
    {previousFlight && <div className={`dt-flight-connection ${connectionMinutes !== null && connectionMinutes < 0 ? 'is-warning' : ''}`}><PlaneLanding size={14} aria-hidden="true"/><span>{connectionMinutes === null ? 'Connection time to confirm.' : connectionMinutes < 0 ? `Connection overlaps by ${bookingDuration(-connectionMinutes)}. Check both flight times.` : previousFlight.toPlaceId === flight.fromPlaceId ? `${bookingDuration(connectionMinutes)} layover at ${bookingPlaceName(places[flight.fromPlaceId])}.` : `${bookingDuration(connectionMinutes)} between flights. Airports change; allow for a ground transfer.`} {previousFlight.flightNumber && `After ${previousFlight.flightNumber}.`}</span></div>}
    {timing.status !== 'ready' && timing.issues.length > 0 && <p className="dt-booking-small">{timing.issues[0]}</p>}
    {!compact && <div className="dt-flight-buffers">{timing.departureGoalMs !== null && <span><strong>Airport arrival goal: {airportGoal(timing.departureGoalMs, flight.departure.timezone)}</strong> · {flight.departure.timezone.replaceAll('_', ' ')}</span>}<span>Allow {bookingDuration(flight.airportBufferMinutes ?? 120)} before departure · {bookingDuration(flight.arrivalBufferMinutes ?? 60)} after landing</span></div>}
    {showPrivate && (flight.bookingReference || flight.privateNotes) && <details className="dt-booking-private"><summary><LockKeyhole size={14} aria-hidden="true"/>Private booking details</summary>{flight.bookingReference && <p><span>Booking reference</span><strong className="dt-booking-reference">{flight.bookingReference}</strong></p>}{flight.privateNotes && <p className="dt-booking-notes">{flight.privateNotes}</p>}</details>}
    {children && <div className="dt-booking-card-actions">{children}</div>}
  </article>;
}
