import {bookingDayDate, flightsForDay, flightTiming, incomingFlightStartIssue, type Place, type Trip} from '../model';
import {localDateAt} from '../bookings/time';
import {bookingDate, bookingPlaceName} from './FlightCard';

export interface IncomingFlightNoticeProps {
  trip: Trip;
  places: Record<string, Place>;
  dayIndex: number;
  onStartFromFlight?: (flightId: string) => void;
}

/** Keep the legacy overnight-flight repair reachable without repeating all bookings. */
export default function IncomingFlightNotice({trip, places, dayIndex, onStartFromFlight}: IncomingFlightNoticeProps) {
  const issue = incomingFlightStartIssue(trip, dayIndex);
  if (!issue) return null;
  const linked = new Set(trip.days.flatMap(day => [day.endFlightId, ...day.items.map(item => item.flightId)]).filter(Boolean));
  const incoming = flightsForDay(trip, dayIndex)
    .filter(item => linked.has(item.flight.id) && ((item.arrival && !item.departure) || item.continuation))
    .map(item => ({flight: item.flight, timing: flightTiming(item.flight)}));
  const latest = incoming.sort((a, b) => (b.timing.arrivalMs ?? -Infinity) - (a.timing.arrivalMs ?? -Infinity))[0];
  const confirmed = incoming.length > 0 && incoming.every(item => item.timing.status === 'ready');
  const ready = confirmed ? latest.timing.arrivalReadyMs : null;
  const readyDate = ready === null ? null : localDateAt(ready, latest.flight.arrival.timezone);
  const dayDate = bookingDayDate(trip, dayIndex);
  const clock = ready === null ? null : new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: latest.flight.arrival.timezone,
  }).format(ready);
  return <section className="day-plan-error" role="alert" aria-label="Incoming flight timing">
    <strong>Continue after your flight</strong>
    <p>{issue}</p>
    {latest && <p><strong>{bookingPlaceName(places[latest.flight.toPlaceId])}</strong>{latest.flight.flightNumber ? ` · ${latest.flight.flightNumber}` : ''}
      {clock ? ` · ready to leave ${clock} (${latest.flight.arrival.timezone.replaceAll('_', ' ')}), including your arrival buffer.` : ' · Confirm the flight times in your trip bookings.'}</p>}
    {readyDate !== null && readyDate !== dayDate && <p>The arrival buffer ends on {bookingDate(readyDate)}. Open that day to plan onward travel.</p>}
    {onStartFromFlight && latest && <>
      {readyDate === dayDate && <p>This updates the starting place, start time and time zone. An earlier finish goal will be cleared; your stops stay in place.</p>}
      <button type="button" className="text-button" disabled={ready === null || readyDate !== dayDate} onClick={() => onStartFromFlight(latest.flight.id)}>Start this day at arrival airport</button>
    </>}
  </section>;
}
