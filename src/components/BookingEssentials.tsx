import {useState,type ReactNode} from 'react';
import {ArrowRight, BedDouble, CalendarDays, Check, Copy, ExternalLink, LockKeyhole, MapPin, Navigation, Pencil, Phone, Plane} from 'lucide-react';
import type {Place, Trip} from '../model';
import type {AccommodationBooking} from '../bookings/types';
import {bookingDayDate, flightsForDay, flightTiming, incomingFlightStartIssue, staysForDay} from '../bookings/model';
import {localDateAt} from '../bookings/time';
import {travelDirectionsURL} from '../travel/model';
import FlightCard, {bookingDate, bookingPlaceName, previousFlightConnection} from './FlightCard';
import './bookings.css';

function safeBookingUrl(value?: string) {try {const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;} catch {return null;}}
export function StayCard({stay, places, showPrivate = false, onEdit, children}: {stay: AccommodationBooking; places: Record<string, Place>; showPrivate?: boolean; onEdit?: () => void; children?: ReactNode}) {
  const place = places[stay.placeId], directions = travelDirectionsURL(place, 'drive'), bookingUrl = showPrivate ? safeBookingUrl(stay.bookingUrl) : null;
  const [copied,setCopied]=useState(false),[copyError,setCopyError]=useState('');
  const address=place?.offlineDetails?.address?.trim()||place?.area?.trim(),localAddress=place?.offlineDetails?.localAddress?.trim();
  const addresses=[...new Set([address,localAddress].filter((value):value is string=>!!value))];
  async function copyAddress(){try{await navigator.clipboard.writeText([bookingPlaceName(place),...addresses].join('\n'));setCopied(true);setCopyError('');}catch{setCopyError('Select the address above to copy it. Clipboard access is unavailable.');}}
  return <article className="dt-stay-card"><div className="dt-booking-card-heading"><span className="dt-booking-symbol is-stay"><BedDouble size={19} aria-hidden="true"/></span><div><span className="dt-booking-kicker">Accommodation</span><h3>{bookingPlaceName(place)}</h3></div>{onEdit && <button type="button" className="dt-booking-icon" onClick={onEdit} aria-label={`Edit ${bookingPlaceName(place)}`}><Pencil size={16} aria-hidden="true"/></button>}</div>
    {addresses.map((value,index)=><p className="dt-booking-address" key={index} lang={value===localAddress?'und':undefined}><MapPin size={14} aria-hidden="true"/>{value}</p>)}
    <div className="dt-stay-dates"><div><span>Check-in</span><strong>{bookingDate(stay.checkInDate)}</strong><small>{stay.checkInTime || 'Time to confirm'}</small></div><ArrowRight size={17} aria-hidden="true"/><div><span>Check-out</span><strong>{bookingDate(stay.checkOutDate)}</strong><small>{stay.checkOutTime || 'Time to confirm'}</small></div></div><p className="dt-booking-small">{stay.timezone.replaceAll('_', ' ')} time</p>
    {showPrivate && (stay.bookingReference || stay.contact || stay.privateNotes || bookingUrl) && <details className="dt-booking-private"><summary><LockKeyhole size={14} aria-hidden="true"/>Private booking details</summary>{stay.bookingReference && <p><span>Booking reference</span><strong className="dt-booking-reference">{stay.bookingReference}</strong></p>}{stay.contact && <p className="dt-booking-contact"><Phone size={14} aria-hidden="true"/>{stay.contact}</p>}{bookingUrl && <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="dt-booking-link">Open booking website<ExternalLink size={13} aria-hidden="true"/></a>}{stay.privateNotes && <p className="dt-booking-notes">{stay.privateNotes}</p>}</details>}
    {(directions || children || addresses.length>0) && <div className="dt-booking-card-actions">{addresses.length>0&&<button type="button" className="dt-booking-link" onClick={()=>void copyAddress()}>{copied?<Check size={14} aria-hidden="true"/>:<Copy size={14} aria-hidden="true"/>}{copied?'Address copied':'Copy address'}</button>}{directions && <a className="dt-booking-link" href={directions} target="_blank" rel="noopener noreferrer"><Navigation size={14} aria-hidden="true"/>Directions<span className="dt-booking-sr"> in Google Maps, opens another app or tab</span></a>}{children}</div>}
    {copyError&&<p className="dt-booking-small" role="alert">{copyError}</p>}<span className="dt-booking-sr" role="status">{copied?'Address copied.':''}</span>
  </article>;
}

export interface BookingEssentialsProps {trip: Trip; places: Record<string, Place>; dayIndex?: number; date?: string; showPrivate?: boolean; onManage?: () => void; compact?: boolean; onStartFromFlight?: (flightId: string) => void}
export default function BookingEssentials({trip, places, dayIndex, date, showPrivate = false, onManage, compact = false, onStartFromFlight}: BookingEssentialsProps) {
  const index = dayIndex ?? (date ? trip.days.findIndex((_, i) => bookingDayDate(trip, i) === date) : -1);
  const flights = index >= 0 ? flightsForDay(trip, index).map(item => item.flight) : date ? [] : trip.flights ?? [];
  const stays = index >= 0 ? staysForDay(trip, index).map(item => item.stay) : date ? [] : trip.stays ?? [];
  function arrivalStart(flight: NonNullable<Trip['flights']>[number]) {
    const day = trip.days[index], dayDate = index >= 0 ? bookingDayDate(trip, index) : '';
    if (!onStartFromFlight || !day) return null;
    if (!incomingFlightStartIssue(trip, index)) return null;
    const linked = new Set(trip.days.flatMap(value => [value.endFlightId, ...value.items.map(activity => activity.flightId)]).filter(Boolean));
    const incoming = flightsForDay(trip, index)
      .filter(item => linked.has(item.flight.id) && ((item.arrival && !item.departure) || item.continuation))
      .map(item => item.flight);
    const latest = incoming.sort((a, b) => (flightTiming(b).arrivalMs ?? -Infinity) - (flightTiming(a).arrivalMs ?? -Infinity))[0];
    if (latest?.id !== flight.id) return null;
    const timing = flightTiming(flight), ready = timing.status === 'ready' ? timing.arrivalReadyMs : null, readyDate = ready === null ? null : localDateAt(ready, flight.arrival.timezone);
    const clock = ready === null ? null : new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:flight.arrival.timezone}).format(ready);
    return <div className="dt-booking-arrival-preview"><strong>Continue from {bookingPlaceName(places[flight.toPlaceId])}</strong><p>{clock ? `Ready to leave: ${clock} · ${flight.arrival.timezone.replaceAll('_', ' ')}. Includes your post-landing buffer.` : 'Confirm the flight arrival time before setting this day’s start.'}</p><p>This replaces the day’s starting location, start time and time zone. An earlier finish goal will be cleared.</p>{readyDate !== null && readyDate !== dayDate && <p className="is-warning">The arrival buffer ends on {bookingDate(readyDate)}. Use that day for your onward plan.</p>}<button type="button" className="dt-booking-button" disabled={ready === null || readyDate !== dayDate} onClick={() => onStartFromFlight(flight.id)}><Plane size={15} aria-hidden="true"/>Start this day at arrival airport</button></div>;
  }
  if (!flights.length && !stays.length && !onManage) return null;
  return <section className={`dt-booking-essentials ${compact ? 'is-compact' : ''}`} aria-label="Flights and accommodation"><div className="dt-booking-section-heading"><div><p className="dt-booking-kicker">The details that get you there</p><h2>Flights & stays</h2></div>{onManage && <button type="button" className="dt-booking-link" onClick={onManage}>Manage<ArrowRight size={15} aria-hidden="true"/></button>}</div>{!flights.length && !stays.length ? <div className="dt-booking-empty is-small"><CalendarDays size={22} aria-hidden="true"/><p>No flights or stays {index >= 0 ? 'for this day' : 'yet'}. Keep your travel details together here.</p>{onManage && <button type="button" className="dt-booking-button" onClick={onManage}>Add flight or stay<ArrowRight size={15} aria-hidden="true"/></button>}</div> : <div className="dt-booking-essentials-list">{flights.map(flight => <FlightCard key={flight.id} flight={flight} places={places} previousFlight={previousFlightConnection(flight, trip.flights ?? [])} showPrivate={showPrivate} compact={compact}>{arrivalStart(flight)}</FlightCard>)}{stays.map(stay => <StayCard key={stay.id} stay={stay} places={places} showPrivate={showPrivate}/>)}</div>}<p className="dt-booking-footnote"><Plane size={13} aria-hidden="true"/>Flight times are your saved booking details. Check your airline for live updates.</p></section>;
}
