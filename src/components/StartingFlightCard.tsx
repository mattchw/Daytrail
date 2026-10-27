import {AlertTriangle, ChevronDown, Clock3, MapPin, Pencil, Plane, PlaneLanding} from 'lucide-react';
import {flightTiming, formatDuration, formatTime, type Journey, type Mode, type Place} from '../model';
import type {FlightSegment} from '../bookings/types';
import {bookingDate, bookingPlaceName} from './FlightCard';
import './starting-flight.css';

export interface StartingFlightCardProps {
  disabled?: boolean;
  flight: FlightSegment;
  places: Record<string, Place>;
  /** The day's start clock, in startTimezone, rather than the scheduled departure clock. */
  startTime: number;
  startTimezone: string;
  onChooseStart?: () => void;
  onChooseEnd?: () => void;
  onEdit?: () => void;
  onChangeMode?: (mode: Mode) => void;
  journey?: Journey;
}

function readyLabel(timestamp: number, timezone: string, arrivalDate: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${value.year}-${value.month}-${value.day}`;
  return `${value.hour}:${value.minute}${date !== arrivalDate ? ` · ${bookingDate(date)}` : ''}`;
}

/** The first airport, scheduled flight and arrival airport form one public timeline item. */
export default function StartingFlightCard({flight, places, startTime, startTimezone, onChooseStart, onChooseEnd, onEdit, onChangeMode, journey, disabled=false}: StartingFlightCardProps) {
  const timing = flightTiming(flight);
  const arrivalName = bookingPlaceName(places[flight.toPlaceId]);
  const title = [flight.airline, flight.flightNumber].filter(Boolean).join(' · ') || 'Your flight';
  const dateOffset = Math.round((Date.parse(`${flight.arrival.date}T12:00:00Z`) - Date.parse(`${flight.departure.date}T12:00:00Z`)) / 86_400_000);
  const warnings = [...new Set([
    ...(timing.status !== 'ready' ? timing.issues : []),
    journey?.warning && journey.warning !== 'Scheduled flight; not live status.' ? journey.warning : '',
    journey?.min === null ? journey.status === 'loading' ? 'Calculating journey…' : journey.reason || 'Journey timing to confirm.' : '',
  ].filter(Boolean))];
  const ready = timing.status === 'ready' && timing.arrivalReadyMs !== null ? readyLabel(timing.arrivalReadyMs, flight.arrival.timezone, flight.arrival.date) : null;
  return <article className="starting-flight-card" aria-label="Starting flight">
    <div className="starting-flight-stop is-origin">
      <span className="starting-flight-marker" aria-hidden="true"><MapPin size={17}/></span>
      <div className="starting-flight-content">
        <span className="starting-flight-label">Start from</span>
        <h3>{bookingPlaceName(places[flight.fromPlaceId])}</h3>
        <p className="starting-flight-start-time">Day starts at <strong>{formatTime(startTime)}</strong><span> · {startTimezone.replaceAll('_', ' ')}</span></p>
        {flight.departureTerminal && <p className="starting-flight-terminal">Terminal {flight.departureTerminal}</p>}
      </div>
      {onChooseStart && <button type="button" className="starting-flight-change" onClick={onChooseStart} aria-label="Choose day start">Change<ChevronDown size={13} aria-hidden="true"/></button>}
    </div>

    <div className="starting-flight-segment">
      <span className="starting-flight-marker is-plane" aria-hidden="true"><Plane size={17}/></span>
      <div className="starting-flight-content starting-flight-ticket">
        <div className="starting-flight-heading">
          <div className="starting-flight-heading-text">
            {onChangeMode ? <label className="starting-flight-mode"><span className="starting-flight-sr">Transport to {arrivalName}</span><select disabled={disabled} aria-busy={disabled||undefined} aria-label={`Transport to ${arrivalName}`} value={journey?.mode || 'flight'} onChange={event => onChangeMode(event.currentTarget.value as Mode)}><option value="walk">Walk</option><option value="transit">Transit</option><option value="drive">Drive</option><option value="flight">Flight</option></select><ChevronDown size={11} aria-hidden="true"/></label> : <span className="starting-flight-label">Flight</span>}
            <h4>{title}</h4>
          </div>
          {onEdit && <button type="button" className="starting-flight-edit" onClick={onEdit} aria-label={`Edit ${flight.flightNumber || 'flight'}`}><Pencil size={14} aria-hidden="true"/><span>Edit</span></button>}
        </div>
        <div className="starting-flight-clock"><span>Departs</span><strong>{flight.departure.time || 'To confirm'}</strong></div>
        <p className="starting-flight-local">{bookingDate(flight.departure.date)} · {flight.departure.timezone.replaceAll('_', ' ')}</p>
        <p className="starting-flight-duration"><Clock3 size={13} aria-hidden="true"/>{timing.durationMinutes !== null ? `${formatDuration(timing.durationMinutes)} flight` : 'Flight duration to confirm'}<span> · local times</span></p>
      </div>
    </div>

    <div className="starting-flight-stop is-arrival">
      <span className="starting-flight-marker" aria-hidden="true"><PlaneLanding size={17}/></span>
      <div className="starting-flight-content">
        <span className="starting-flight-label">Arrive at</span>
        <h3>{arrivalName}</h3>
        <div className="starting-flight-clock"><strong>{flight.arrival.time || 'To confirm'}</strong>{Number.isFinite(dateOffset) && dateOffset !== 0 && <span className="starting-flight-offset">{dateOffset > 0 ? '+' : '−'}{Math.abs(dateOffset)} {Math.abs(dateOffset) === 1 ? 'day' : 'days'}</span>}</div>
        <p className="starting-flight-local">{bookingDate(flight.arrival.date)} · {flight.arrival.timezone.replaceAll('_', ' ')}</p>
        {flight.arrivalTerminal && <p className="starting-flight-terminal">Terminal {flight.arrivalTerminal}</p>}
        <p className="starting-flight-ready">{ready ? <>Ready to leave at <strong>{ready}</strong> · </> : null}Allow {formatDuration(flight.arrivalBufferMinutes ?? 60)} after landing.</p>
      </div>
      {onChooseEnd && <button type="button" className="starting-flight-change" onClick={onChooseEnd} aria-label="Choose day end">Change<ChevronDown size={13} aria-hidden="true"/></button>}
    </div>
    {warnings.length > 0 && <div className="starting-flight-warnings" role="status"><AlertTriangle size={16} aria-hidden="true"/><div>{warnings.map(warning => <p key={warning}>{warning}</p>)}</div></div>}
  </article>;
}
