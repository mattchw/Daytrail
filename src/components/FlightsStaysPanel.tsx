import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {AlertCircle, ArrowLeft, ArrowRight, BedDouble, Check, CheckCircle2, ChevronDown, Link2, LoaderCircle, LockKeyhole, MapPin, Plane, Plus, Search, Trash2, Unlink} from 'lucide-react';
import type {Place, Trip} from '../model';
import type {AccommodationBooking, FlightMoment, FlightSegment} from '../bookings/types';
import {accommodationSuggestions, bookingDayDate, flightTiming, isFlight, isStay} from '../bookings/model';
import {resolveFlightMoment} from '../bookings/time';
import {appliedFlightBoundaries, flightDayBoundary} from '../bookings/journey';
import {extendTripRange} from '../bookings/actions';
import DiscoveryPanel from './DiscoveryPanel';
import FlightCard, {bookingDate, bookingPlaceName, previousFlightConnection} from './FlightCard';
import {StayCard} from './BookingEssentials';
import './bookings.css';

export interface BookingFlightTarget {dayId: string; targetId: string}
export type BookingFlightIntent = 'arrival' | 'departure';
export interface BookingFlightSaveOptions {intent?: BookingFlightIntent; applyToDay?: boolean; extendTrip?: boolean; transferMode?: 'walk' | 'transit' | 'drive'}
export interface BookingStaySaveOptions {applyToDays?: boolean; extendTrip?: boolean}
export interface FlightsStaysPanelProps {
  trip: Trip; places: Record<string, Place>;
  showPrivate?: boolean;
  onSaveFlight: (flight: FlightSegment, target?: BookingFlightTarget, options?: BookingFlightSaveOptions) => Promise<void>;
  onDeleteFlight: (id: string) => Promise<void>;
  onSaveStay: (stay: AccommodationBooking, options?: BookingStaySaveOptions) => Promise<void>;
  onDeleteStay: (id: string) => Promise<void>;
  onRememberPlace: (place: Place) => Promise<void>;
  onApplyStay?: (stayId: string, dayIds?: string[]) => Promise<void>;
  onLinkFlight?: (flightId: string, dayId: string, targetId: string) => Promise<void>;
  onUnlinkFlight?: (id: string) => Promise<void>;
  onExtendTrip?: (startDate: string, endDate: string) => Promise<void>;
  initialKind?: 'flight' | 'stay'; initialFlightDraft?: Partial<FlightSegment>;
  initialIntent?: BookingFlightIntent; initialFlightId?: string; initialStayId?: string; initialStayDate?: string;
  onNotFlying?: (intent: BookingFlightIntent) => void;
  initialTarget?: BookingFlightTarget; onClose?: () => void; onBusyChange?: (busy: boolean) => void;
}
type Page = 'list' | 'choose-flight' | 'flight' | 'stay' | 'location' | 'custom' | 'apply' | 'link';
type LocationField = 'fromPlaceId' | 'toPlaceId' | 'stay';
const zones = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Rome', 'Europe/Istanbul', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Vancouver', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Dubai', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];
const makeId = (kind: string) => `${kind}-${crypto.randomUUID()}`;
function newFlight(trip: Trip, initial?: Partial<FlightSegment>, intent?: BookingFlightIntent): FlightSegment {
  const date = intent === 'departure' ? bookingDayDate(trip, trip.days.length - 1) : trip.startDate;
  return {id: makeId('flight'), fromPlaceId: '', toPlaceId: '', departure: {date, time: null, timezone: trip.timezone}, arrival: {date, time: null, timezone: trip.timezone}, airportBufferMinutes: 120, arrivalBufferMinutes: 60, ...initial};
}
function newStay(trip: Trip, date?: string): AccommodationBooking {
  const start = date || trip.startDate, next = new Date(`${start}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const end = date ? next.toISOString().slice(0, 10) : bookingDayDate(trip, Math.max(1, trip.days.length - 1));
  return {id: makeId('stay'), placeId: '', checkInDate: start, checkOutDate: end, timezone: trip.timezone, checkInTime: '15:00', checkOutTime: '11:00'};
}
function existingFlightIntent(trip: Trip, id?: string): BookingFlightIntent | undefined {
  if (!id) return;
  for (const day of trip.days) {const boundaries = appliedFlightBoundaries(trip, day.id); if (boundaries.arrival?.id === id) return 'arrival'; if (boundaries.departure?.id === id) return 'departure';}
}
function existingTransferMode(trip: Trip, id?: string, intent?: BookingFlightIntent): 'walk' | 'transit' | 'drive' {
  if (!id || !intent) return 'transit';
  const day = trip.days.find(day => appliedFlightBoundaries(trip, day.id)[intent]?.id === id);
  const mode = intent === 'arrival' && day?.items.length ? day.items[0].mode : day?.endMode;
  return mode && mode !== 'flight' ? mode : 'transit';
}
function offsetLabel(offset: number) {return `UTC${offset < 0 ? '−' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;}
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'This change could not be saved. Please try again.';

/** Content for the shared Modal. Editors and place search are pages within the same dialog. */
export default function FlightsStaysPanel({trip, places, onSaveFlight, onDeleteFlight, onSaveStay, onDeleteStay, onRememberPlace, onApplyStay, onLinkFlight, onUnlinkFlight, onExtendTrip, initialKind, initialFlightDraft, initialIntent, initialFlightId, initialStayId, initialStayDate, initialTarget, onNotFlying, onClose, onBusyChange, showPrivate = true}: FlightsStaysPanelProps) {
  const id = useId(), mounted = useRef(true), callbacks = useRef({onBusyChange}); callbacks.current = {onBusyChange};
  const [page, setPage] = useState<Page>(initialTarget ? 'choose-flight' : initialStayId || initialKind === 'stay' ? 'stay' : initialFlightId || initialKind === 'flight' || initialIntent ? 'flight' : 'list');
  const [flight, setFlight] = useState<FlightSegment>(() => structuredClone(trip.flights?.find(item => item.id === initialFlightId) ?? newFlight(trip, initialFlightDraft, initialIntent)));
  const [stay, setStay] = useState<AccommodationBooking>(() => structuredClone(trip.stays?.find(item => item.id === initialStayId) ?? newStay(trip, initialStayDate)));
  const [intent, setIntent] = useState<BookingFlightIntent | undefined>(initialIntent ?? existingFlightIntent(trip, initialFlightId ?? initialFlightDraft?.id));
  const [applyFlight, setApplyFlight] = useState(Boolean(initialIntent ?? existingFlightIntent(trip, initialFlightId ?? initialFlightDraft?.id))), [applyStayOnSave, setApplyStayOnSave] = useState(true);
  const [extendDates, setExtendDates] = useState(false), [transferMode, setTransferMode] = useState<'walk' | 'transit' | 'drive'>(() => existingTransferMode(trip, initialFlightId ?? initialFlightDraft?.id, initialIntent ?? existingFlightIntent(trip, initialFlightId ?? initialFlightDraft?.id)));
  const [locationField, setLocationField] = useState<LocationField>('fromPlaceId');
  const [remembered, setRemembered] = useState<Record<string, Place>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{kind: 'flight' | 'stay'; id: string} | null>(null);
  const [selectedDays, setSelectedDays] = useState<string[]>([]), [target, setTarget] = useState(initialTarget);
  const [linkTarget, setLinkTarget] = useState('');
  const [tab, setTab] = useState<'all' | 'flights' | 'stays'>(initialTarget ? 'flights' : 'all');
  const shownPlaces = {...places, ...remembered};
  const flights = [...(trip.flights ?? [])].sort((a, b) => `${a.departure.date}${a.departure.time || ''}`.localeCompare(`${b.departure.date}${b.departure.time || ''}`));
  const stays = [...(trip.stays ?? [])].sort((a, b) => a.checkInDate.localeCompare(b.checkInDate));
  const editingFlight = !!trip.flights?.some(item => item.id === flight.id), editingStay = !!trip.stays?.some(item => item.id === stay.id);
  const suggestions = accommodationSuggestions(trip);
  const staySuggestions = suggestions.filter(item => item.startStayId === stay.id || item.endStayId === stay.id);
  const targetDay = target ? trip.days.find(day => day.id === target.dayId) : undefined;
  const targetPosition = targetDay && target ? target.targetId === `end:${targetDay.id}` ? targetDay.items.length : targetDay.items.findIndex(item => `activity:${item.aid}` === target.targetId) : -1;
  const targetExists = !!targetDay && targetPosition >= 0;
  const targetFrom = targetDay && targetPosition >= 0 ? targetPosition > 0 ? targetDay.items[targetPosition - 1].placeId : targetDay.startPlaceId || 'hotel' : undefined;
  const targetTo = targetDay && targetPosition >= 0 ? targetDay.items[targetPosition]?.placeId || targetDay.endPlaceId || 'hotel' : undefined;
  const linkDescription = 'Keeps your day’s start, end and stops. Adds airport connections where needed.';
  const timing = flightTiming(flight);
  const lastTripDate = bookingDayDate(trip, trip.days.length - 1);
  const outsideTrip = (item: FlightSegment) => [item.departure.date, item.arrival.date].some(date => date < trip.startDate || date > lastTripDate);
  const isLinked = (flightId: string) => trip.days.some(day => day.endFlightId === flightId || day.items.some(item => item.flightId === flightId));
  const targetDate = targetDay ? bookingDayDate(trip, trip.days.indexOf(targetDay)) : undefined;
  const saveTarget = !targetExists || outsideTrip(flight) || targetDate !== flight.departure.date ? undefined : target;
  const samePlace = (a: string, b?: string) => a === b || !!b && !!shownPlaces[a]?.googlePlaceId && shownPlaces[a].googlePlaceId === shownPlaces[b]?.googlePlaceId;
  const routeMatch = (item: FlightSegment) => Number(samePlace(item.fromPlaceId, targetFrom)) + Number(samePlace(item.toPlaceId, targetTo));
  const dayFlights = flights.filter(item => item.departure.date === targetDate).sort((a, b) => routeMatch(b) - routeMatch(a));
  const matchingFlights = dayFlights.filter(item => routeMatch(item) > 0), otherFlights = dayFlights.filter(item => routeMatch(item) === 0);
  const departureDayIndex = trip.days.findIndex((_, index) => bookingDayDate(trip, index) === flight.departure.date);
  const departureDay = trip.days[departureDayIndex];
  const boundary = intent ? flightDayBoundary(trip, flight, intent) : null;
  const boundaryOutside = !!boundary && (boundary.date < trip.startDate || boundary.date > lastTripDate);
  const overnightDays = Math.round((Date.parse(`${flight.arrival.date}T12:00:00Z`) - Date.parse(`${flight.departure.date}T12:00:00Z`)) / 86400000);
  const stayNights = Math.round((Date.parse(`${stay.checkOutDate}T12:00:00Z`) - Date.parse(`${stay.checkInDate}T12:00:00Z`)) / 86400000);
  const stayOutside = stay.checkInDate < trip.startDate || stay.checkOutDate > lastTripDate;
  const proposedStayTrip = {...trip, stays: [...(trip.stays ?? []).filter(item => item.id !== stay.id), stay]};
  let stayPreviewIssue = '';
  if (extendDates && isStay(stay)) {try {extendTripRange(proposedStayTrip, stay.checkInDate, stay.checkOutDate);} catch (reason) {stayPreviewIssue = errorMessage(reason);}}
  const proposedStaySuggestions = accommodationSuggestions(proposedStayTrip);
  const proposedStayDays = proposedStaySuggestions.filter(item => item.startStayId === stay.id || item.endStayId === stay.id);
  const stayOverlap = proposedStaySuggestions.some(item => {
    const date = bookingDayDate(proposedStayTrip, item.dayIndex);
    return date >= stay.checkInDate && date <= stay.checkOutDate && item.warnings.some(warning => warning.startsWith('Overlapping stays'));
  });
  const clockTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const canApplyFlight = !!boundary?.ready && (!boundaryOutside || extendDates);
  const applyingFlight = !!intent && applyFlight && canApplyFlight;

  useEffect(() => {mounted.current = true; return () => {mounted.current = false; callbacks.current.onBusyChange?.(false);};}, []);
  useEffect(() => {callbacks.current.onBusyChange?.(busy);}, [busy]);
  function go(next: Page) {setPage(next); setError(''); setDeleteTarget(null);}
  function back() {go(target ? 'choose-flight' : 'list');}
  function finishLink() {if (onClose) onClose(); else {setTarget(undefined); go('list');}}
  function cancelLink() {if (onClose) onClose(); else {setTarget(undefined); go('list');}}
  async function action(fn: () => Promise<void>, message: string, after?: () => void) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try {await fn(); if (mounted.current) {setNotice(message); after?.();}}
    catch (reason) {if (mounted.current) setError(errorMessage(reason));}
    finally {if (mounted.current) setBusy(false);}
  }
  function startFlight(nextIntent?: BookingFlightIntent) {
    const draft = newFlight(trip, target ? initialFlightDraft : undefined, nextIntent);
    if (target) {
      const isStayPlace = (placeId: string) => placeId === 'hotel' || stays.some(item => samePlace(item.placeId, placeId));
      // A stay is the onward destination, not the arrival airport to put on a flight.
      if (isStayPlace(draft.fromPlaceId)) draft.fromPlaceId = '';
      if (isStayPlace(draft.toPlaceId)) draft.toPlaceId = '';
    }
    setFlight(draft); setIntent(nextIntent); setApplyFlight(Boolean(nextIntent)); setTransferMode('transit'); setExtendDates(false); go('flight');
  }
  function showLink(item: FlightSegment) {const day = trip.days.find((_, index) => bookingDayDate(trip, index) === item.departure.date); setFlight(item); setLinkTarget(day ? `end:${day.id}` : ''); go('link');}
  function startStay() {setStay(newStay(trip)); setApplyStayOnSave(true); setExtendDates(false); go('stay');}
  function updateMoment(which: 'departure' | 'arrival', update: Partial<FlightMoment>, resetOffset = false) {
    setFlight(current => ({...current, [which]: {...current[which], ...(resetOffset ? {offsetMinutes: undefined} : {}), ...update}}));
  }
  function pick(field: LocationField) {setLocationField(field); go('location');}
  async function choosePlace(place: Place) {
    await action(() => onRememberPlace(place), '', () => {
      setRemembered(current => ({...current, [place.id]: place}));
      if (locationField === 'stay') {setStay(current => ({...current, placeId: place.id})); go('stay');}
      else {setFlight(current => ({...current, [locationField]: place.id})); go('flight');}
    });
  }
  async function saveFlight(event: FormEvent) {
    event.preventDefault();
    if (target && !saveTarget) {setError(!targetExists ? 'This position changed. Close this picker and choose Flight again.' : outsideTrip(flight) ? 'Include both flight dates in your trip before using this flight here.' : `Choose a flight departing on ${bookingDate(targetDate!)} to use it here.`); return;}
    if (!flight.fromPlaceId || !flight.toPlaceId) {setError('Choose a departure airport and an arrival airport.'); return;}
    if (flight.fromPlaceId === flight.toPlaceId) {setError('Choose different departure and arrival airports.'); return;}
    if (!isFlight(flight)) {setError('Check the flight’s dates, time zones and details.'); return;}
    if (timing.status === 'invalid' || timing.status === 'ambiguous') {setError(timing.issues.join(' ') || 'Confirm the flight times and time zones.'); return;}
    await action(() => onSaveFlight(flight, saveTarget, {intent, applyToDay: applyingFlight, extendTrip: extendDates, transferMode}), saveTarget || applyingFlight ? 'Flight saved. Your day has been updated.' : 'Flight saved with your trip bookings.', () => {if (saveTarget) finishLink(); else back();});
  }
  async function saveStay(event: FormEvent) {
    event.preventDefault();
    if (!stay.placeId) {setError('Choose your accommodation location.'); return;}
    if (!isStay(stay)) {setError('Check your accommodation details. Check-out must be after check-in, with a valid time zone and website address.'); return;}
    await action(() => onSaveStay(stay, {applyToDays: applyStayOnSave, extendTrip: extendDates}), applyStayOnSave ? 'Stay saved. Your day start and end points have been updated where available.' : 'Stay saved with your trip bookings.', back);
  }
  function showApply(item: AccommodationBooking) {setStay(item); setSelectedDays(suggestions.filter(suggestion => suggestion.startStayId === item.id || suggestion.endStayId === item.id).map(suggestion => suggestion.dayId)); go('apply');}
  function placeButton(field: LocationField, value: string, label: string) {
    return <div className="dt-booking-location-field"><span>{label}</span><button type="button" className={`dt-booking-place-button ${value ? 'has-place' : ''}`} onClick={() => pick(field)} disabled={busy}><MapPin size={18} aria-hidden="true"/><span><strong>{value ? bookingPlaceName(shownPlaces[value]) : field === 'stay' ? 'Find your accommodation' : 'Choose an airport'}</strong><small>{value ? shownPlaces[value]?.area || 'Review the exact location before travelling' : 'Search Google Maps or add it yourself'}</small></span><Search size={16} aria-hidden="true"/></button></div>;
  }
  function momentFields(which: 'departure' | 'arrival') {
    const moment = flight[which], result = resolveFlightMoment(moment), label = which === 'departure' ? 'Departure' : 'Arrival';
    return <fieldset className="dt-booking-moment"><legend>{label} · local time</legend>
      {placeButton(which === 'departure' ? 'fromPlaceId' : 'toPlaceId', which === 'departure' ? flight.fromPlaceId : flight.toPlaceId, `${label} airport`)}
      <div className="dt-booking-form-grid"><label>Date<input type="date" required value={moment.date} onInput={event => updateMoment(which, {date: event.currentTarget.value}, true)}/></label><label>Time <span className="dt-booking-optional">optional</span><input type="time" value={moment.time ?? ''} onInput={event => updateMoment(which, {time: event.currentTarget.value || null}, true)}/></label></div>
      <details className="dt-booking-zone"><summary><span>{moment.timezone.replaceAll('_', ' ')}</span><span>Change time zone</span></summary><label>Airport time zone<input required value={moment.timezone} list={`${id}-zones`} placeholder="e.g. Europe/Dublin" maxLength={100} onChange={event => updateMoment(which, {timezone: event.currentTarget.value}, true)}/></label><p className="dt-booking-small">Use this airport’s local time zone, as shown on your booking.</p></details>
      {result.candidates.length > 1 && <label className="dt-booking-offset">This time occurs twice. Which UTC offset is on your booking?<select required value={moment.offsetMinutes ?? ''} onChange={event => updateMoment(which, {offsetMinutes: event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value)})}><option value="">Choose UTC offset</option>{result.candidates.map(candidate => <option key={candidate.timestamp} value={candidate.offsetMinutes}>{offsetLabel(candidate.offsetMinutes)}</option>)}</select></label>}
      {result.status === 'invalid' && <p className="dt-booking-field-error" role="alert">{result.reason || 'This local date and time is not valid.'}</p>}
    </fieldset>;
  }
  const feedback = <>{error && <div className="dt-booking-feedback is-error" role="alert"><AlertCircle size={17} aria-hidden="true"/><span>{error}</span></div>}{notice && <div className="dt-booking-feedback is-success" role="status"><CheckCircle2 size={17} aria-hidden="true"/><span>{notice}</span></div>}</>;
  const backButton = (next: Page = target ? 'choose-flight' : 'list', text = target ? 'Choose a flight' : 'All flights & stays') => <button type="button" className="dt-booking-link dt-booking-back" disabled={busy} onClick={() => go(next)}><ArrowLeft size={15} aria-hidden="true"/>{text}</button>;
  const flightChoice = (item: FlightSegment) => {
    const linkedDay = trip.days.find(day => day.endFlightId === item.id || day.items.some(activity => activity.flightId === item.id));
    return <FlightCard key={item.id} flight={item} places={shownPlaces} compact>
      {linkedDay ? <span className="dt-booking-boundary-label"><CheckCircle2 size={14} aria-hidden="true"/>Already used on {linkedDay.label}</span> : outsideTrip(item) ? <span className="dt-booking-choice-note">Include the arrival date in your trip before using this flight.</span> : <button type="button" className="dt-booking-button is-primary" disabled={busy || !onLinkFlight || !targetExists} onClick={() => {if (target && onLinkFlight) void action(() => onLinkFlight(item.id, target.dayId, target.targetId), 'Flight linked to your itinerary.', finishLink);}}><Link2 size={15} aria-hidden="true"/>Use this flight</button>}
    </FlightCard>;
  };
  return <div className="dt-bookings" aria-busy={busy}>
    <datalist id={`${id}-zones`}>{[...new Set([trip.timezone, ...zones])].map(zone => <option key={zone} value={zone}/>)}</datalist>
    {page === 'choose-flight' && <section className="dt-flight-chooser" aria-label="Choose a flight for this journey">
      <div className="dt-booking-editor-title"><span className="dt-booking-symbol"><Plane size={21} aria-hidden="true"/></span><div><p className="dt-booking-kicker">{targetDay?.label || 'Your day'}{targetDate && ` · ${bookingDate(targetDate)}`}</p><h3>Choose a flight</h3></div></div>
      {targetExists ? <div className="dt-flight-choice-context"><strong>{bookingPlaceName(shownPlaces[targetFrom!])}<ArrowRight size={15} aria-hidden="true"/>{bookingPlaceName(shownPlaces[targetTo!])}</strong><p>{linkDescription}</p></div> : <p className="dt-booking-feedback is-error" role="alert">This position changed. Close this picker and choose Flight again.</p>}
      {feedback}
      {targetExists && <>
        {!!dayFlights.length && <p className="dt-booking-choice-heading">{matchingFlights.length ? 'Suggested saved flights' : 'Saved flights departing this day'}</p>}
        <div className="dt-booking-list">{(matchingFlights.length ? matchingFlights : dayFlights).map(flightChoice)}</div>
        {!!matchingFlights.length && !!otherFlights.length && <details className="dt-flight-other-choices"><summary>Other flights on this day<ChevronDown size={14} aria-hidden="true"/></summary><div className="dt-booking-list">{otherFlights.map(flightChoice)}</div></details>}
        {!dayFlights.length && <p className="dt-booking-small dt-flight-choice-empty">No saved flights depart on this day. Add the details from your booking.</p>}
        <button type="button" className="dt-booking-button dt-flight-choice-add" disabled={busy} onClick={() => startFlight()}><Plus size={16} aria-hidden="true"/>Add a flight</button>
      </>}
      <button type="button" className="dt-booking-link dt-booking-done" disabled={busy} onClick={cancelLink}>Cancel<ArrowRight size={15} aria-hidden="true"/></button>
    </section>}
    {page === 'list' && <>
      <div className="dt-booking-intro"><p className="dt-booking-kicker">The foundations of your trip</p><p>Add how you’ll arrive, where you’ll stay and how you’ll head home. Your bookings help shape each day, with plenty of room for stops in between.</p></div>
      {target && <div className="dt-booking-target"><Link2 size={18} aria-hidden="true"/><div><strong>Choose a flight for {targetDay?.label || 'this day'}</strong><p>{linkDescription} Confirm that the selected locations are your airports.</p><button type="button" className="dt-booking-link" onClick={() => {setTarget(undefined); setTab('all');}}>Cancel linking</button></div></div>}
      <div className={`dt-booking-add ${target ? '' : 'is-journey'}`}>
        <button type="button" className="dt-booking-button" onClick={() => startFlight(target ? undefined : 'arrival')} disabled={busy}><Plane size={18} aria-hidden="true"/><span>{target ? 'Add flight' : 'Arrival flight'}</span><Plus size={15} aria-hidden="true"/></button>
        {!target && <button type="button" className="dt-booking-button" onClick={startStay} disabled={busy}><BedDouble size={18} aria-hidden="true"/><span>Add a stay</span><Plus size={15} aria-hidden="true"/></button>}
        {!target && <button type="button" className="dt-booking-button" onClick={() => startFlight('departure')} disabled={busy}><Plane size={18} aria-hidden="true"/><span>Departure flight</span><Plus size={15} aria-hidden="true"/></button>}
      </div>{!target && <button type="button" className="dt-booking-link dt-booking-another" onClick={() => startFlight()} disabled={busy}>Add another flight or connection<Plus size={14} aria-hidden="true"/></button>}
      {feedback}
      {notice && onClose && <button type="button" className="dt-booking-button is-primary dt-booking-return" disabled={busy} onClick={onClose}>Back to planning<ArrowRight size={15} aria-hidden="true"/></button>}
      {(flights.length > 0 || stays.length > 0) && <div className="dt-booking-filters" role="group" aria-label="Show bookings">{([['all', 'All', flights.length + stays.length], ['flights', 'Flights', flights.length], ['stays', 'Stays', stays.length]] as const).map(([key, label, count]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}<span>{count}</span></button>)}</div>}
      <div className="dt-booking-list">{tab !== 'stays' && flights.map(item => <div key={item.id}><FlightCard flight={item} places={shownPlaces} previousFlight={previousFlightConnection(item, flights)} showPrivate={showPrivate} onEdit={() => {setFlight(structuredClone(item)); setIntent(existingFlightIntent(trip, item.id)); setApplyFlight(Boolean(existingFlightIntent(trip, item.id))); setTransferMode(existingTransferMode(trip, item.id, existingFlightIntent(trip, item.id))); setExtendDates(false); go('flight');}}>{target && onLinkFlight && !outsideTrip(item) && item.departure.date === targetDate && <button type="button" className="dt-booking-button is-primary" disabled={busy} onClick={() => void action(() => onLinkFlight(item.id, target.dayId, target.targetId), 'Flight linked to your itinerary.', () => setTarget(undefined))}><Link2 size={15} aria-hidden="true"/>Use this flight</button>}{onLinkFlight && !isLinked(item.id) && !existingFlightIntent(trip, item.id) && !outsideTrip(item) && (!target || item.departure.date !== targetDate) && <button type="button" className="dt-booking-link" disabled={busy} onClick={() => showLink(item)}><Link2 size={15} aria-hidden="true"/>Add to departure day</button>}{existingFlightIntent(trip, item.id) && <span className="dt-booking-boundary-label"><CheckCircle2 size={14} aria-hidden="true"/>{existingFlightIntent(trip, item.id) === 'arrival' ? 'Sets day start' : 'Sets day end'}</span>}{onUnlinkFlight && isLinked(item.id) && <button type="button" className="dt-booking-link" disabled={busy} onClick={() => void action(() => onUnlinkFlight(item.id), 'Flight unlinked. Airport stops stay in your itinerary.')}><Unlink size={14} aria-hidden="true"/>Unlink from itinerary</button>}{outsideTrip(item) && !existingFlightIntent(trip, item.id) && <div className="dt-booking-outside"><span>This flight is outside your trip dates. It is kept as a booking.</span>{onExtendTrip && <button type="button" className="dt-booking-link" disabled={busy} onClick={() => void action(() => onExtendTrip([item.departure.date, item.arrival.date].sort()[0], [item.departure.date, item.arrival.date].sort()[1]), 'Trip dates extended to include this flight.')}>Extend trip to include flight<ArrowRight size={14} aria-hidden="true"/></button>}</div>}<button type="button" className="dt-booking-link is-danger" disabled={busy} onClick={() => setDeleteTarget({kind: 'flight', id: item.id})}><Trash2 size={14} aria-hidden="true"/>Delete</button></FlightCard>{deleteTarget?.kind === 'flight' && deleteTarget.id === item.id && <div className="dt-booking-delete"><p>Delete this flight and its flight links? Airport stops stay in the itinerary.</p><button type="button" className="dt-booking-button is-danger" disabled={busy} onClick={() => void action(() => onDeleteFlight(item.id), 'Flight deleted.', () => setDeleteTarget(null))}>Delete flight</button><button type="button" className="dt-booking-link" disabled={busy} onClick={() => setDeleteTarget(null)}>Keep flight</button></div>}</div>)}{tab !== 'flights' && stays.map(item => <div key={item.id}><StayCard stay={item} places={shownPlaces} showPrivate={showPrivate} onEdit={() => {setStay(structuredClone(item)); setApplyStayOnSave(true); setExtendDates(false); go('stay');}}>{onApplyStay && <button type="button" className="dt-booking-link" disabled={busy} onClick={() => showApply(item)}><CheckCircle2 size={15} aria-hidden="true"/>Apply to itinerary</button>}<button type="button" className="dt-booking-link is-danger" disabled={busy} onClick={() => setDeleteTarget({kind: 'stay', id: item.id})}><Trash2 size={14} aria-hidden="true"/>Delete</button></StayCard>{deleteTarget?.kind === 'stay' && deleteTarget.id === item.id && <div className="dt-booking-delete"><p>Delete this accommodation booking? Your existing day start and end points stay in place.</p><button type="button" className="dt-booking-button is-danger" disabled={busy} onClick={() => void action(() => onDeleteStay(item.id), 'Accommodation deleted.', () => setDeleteTarget(null))}>Delete accommodation</button><button type="button" className="dt-booking-link" disabled={busy} onClick={() => setDeleteTarget(null)}>Keep accommodation</button></div>}</div>)}</div>
      {(tab === 'all' ? !flights.length && !stays.length : tab === 'flights' ? !flights.length : !stays.length) && <div className="dt-booking-empty"><span><Plane size={24} aria-hidden="true"/><BedDouble size={24} aria-hidden="true"/></span><h3>A little organisation, a lot more ease.</h3><p>{tab === 'flights' ? 'Add your first flight, with local departure and arrival times.' : tab === 'stays' ? 'Add your first stay, then use it as a start or end point for your days.' : 'Add your flights and accommodation. Their details will be close at hand in Today.'}</p></div>}
      {suggestions.some(item => item.warnings.length > 0) && stays.length > 0 && <details className="dt-booking-review"><summary><AlertCircle size={15} aria-hidden="true"/>Review accommodation coverage<ChevronDown size={14} aria-hidden="true"/></summary><ul>{suggestions.flatMap(item => item.warnings.map((warning, i) => <li key={`${item.dayId}-${i}`}><strong>{trip.days[item.dayIndex]?.label}:</strong> {warning}</li>))}</ul></details>}
      <p className="dt-booking-footnote"><LockKeyhole size={13} aria-hidden="true"/>References, contacts and private notes stay private to the trip owner.</p>
    </>}
    {page === 'flight' && <>{backButton()}<div className="dt-booking-editor-title"><span className="dt-booking-symbol"><Plane size={20} aria-hidden="true"/></span><div><p className="dt-booking-kicker">{target ? `Flight for ${targetDay?.label || 'this day'}` : 'A booking for your whole trip'}</p><h3>{editingFlight ? 'Edit flight' : intent === 'arrival' ? 'How are you arriving?' : intent === 'departure' ? 'How are you heading home?' : 'Add a flight'}</h3></div></div>
      <form className="dt-booking-form" onSubmit={event => void saveFlight(event)}><fieldset disabled={busy} className="dt-booking-fields">
      {!target && <div className="dt-booking-intent" role="group" aria-label="Use this flight for">{([['arrival', 'Arriving'], ['departure', 'Heading home'], ['', 'Another flight']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={(intent || '') === value} onClick={() => {setIntent(value || undefined); setApplyFlight(Boolean(value)); setExtendDates(false);}}>{label}</button>)}</div>}
      <label>Flight number <span className="dt-booking-optional">optional</span><input value={flight.flightNumber || ''} maxLength={40} onChange={event => setFlight({...flight, flightNumber: event.currentTarget.value})} placeholder="e.g. EI 154" autoCapitalize="characters"/><span className="dt-booking-small">Copy the airports and local times from your booking.</span></label>
      <div className="dt-booking-form-grid is-moments">{momentFields('departure')}{momentFields('arrival')}</div>
      <div className={`dt-booking-timing ${timing.status === 'invalid' || timing.status === 'ambiguous' ? 'is-warning' : ''}`} role="status"><Plane size={17} aria-hidden="true"/><span>{timing.durationMinutes !== null ? `${Math.floor(timing.durationMinutes / 60)}h ${timing.durationMinutes % 60}m flight · Both times are local.` : timing.issues[0] || 'You can save the booking while a time is still to confirm.'}{overnightDays > 0 && <strong className="dt-booking-day-offset">+{overnightDays} {overnightDays === 1 ? 'day' : 'days'} on arrival</strong>}{overnightDays < 0 && <strong className="dt-booking-day-offset">{overnightDays} {overnightDays === -1 ? 'day' : 'days'} on arrival</strong>}</span></div>
      <details className="dt-booking-extra"><summary><Plane size={15} aria-hidden="true"/>Airport time &amp; extra details<ChevronDown size={14} aria-hidden="true"/></summary>
        <div className="dt-booking-form-grid"><label>Arrive before departure <span className="dt-booking-optional">minutes</span><input type="number" min={0} max={1440} step={5} value={flight.airportBufferMinutes ?? 120} onChange={event => setFlight({...flight, airportBufferMinutes: Number(event.currentTarget.value)})}/></label><label>Allow after landing <span className="dt-booking-optional">minutes</span><input type="number" min={0} max={1440} step={5} value={flight.arrivalBufferMinutes ?? 60} onChange={event => setFlight({...flight, arrivalBufferMinutes: Number(event.currentTarget.value)})}/></label></div>
        <p className="dt-booking-small">Allow for check-in and security before departure, and immigration and bags after landing.</p>
        <label>Airline <span className="dt-booking-optional">optional</span><input value={flight.airline || ''} maxLength={160} onChange={event => setFlight({...flight, airline: event.currentTarget.value})} placeholder="e.g. Aer Lingus"/></label>
        <div className="dt-booking-form-grid">{(['departure', 'arrival'] as const).map(which => <label key={which}>{which === 'departure' ? 'Departure' : 'Arrival'} terminal <span className="dt-booking-optional">optional</span><input value={flight[`${which}Terminal`] || ''} maxLength={80} onChange={event => setFlight({...flight, [`${which}Terminal`]: event.currentTarget.value})} placeholder="To confirm"/></label>)}</div>
        {flights.some(item => item.id !== flight.id) && <label>Part of a connecting journey <span className="dt-booking-optional">optional</span><select value={flight.groupId || ''} onChange={event => setFlight({...flight, groupId: event.currentTarget.value || undefined})}><option value="">This is a separate flight</option>{[...new Map(flights.filter(item => item.id !== flight.id && (item.groupId || item.id) !== flight.id).map(item => [item.groupId || item.id, item])).entries()].map(([groupId, item]) => <option key={groupId} value={groupId}>Connect with {item.flightNumber || bookingPlaceName(shownPlaces[item.fromPlaceId])} · {bookingDate(item.departure.date)}</option>)}</select></label>}
      </details>
      {showPrivate && <details className="dt-booking-extra"><summary><LockKeyhole size={15} aria-hidden="true"/>Private booking details<ChevronDown size={14} aria-hidden="true"/></summary><label>Booking reference<input value={flight.bookingReference || ''} maxLength={160} onChange={event => setFlight({...flight, bookingReference: event.currentTarget.value})} autoComplete="off" placeholder="Optional"/></label><div className="dt-booking-form-grid">{(['departure', 'arrival'] as const).map(which => <label key={which}>{which === 'departure' ? 'Departure' : 'Arrival'} gate <span className="dt-booking-optional">optional</span><input value={flight[`${which}Gate`] || ''} maxLength={40} onChange={event => setFlight({...flight, [`${which}Gate`]: event.currentTarget.value})} placeholder="To confirm"/></label>)}</div><label>Private notes<textarea rows={3} value={flight.privateNotes || ''} maxLength={4000} onChange={event => setFlight({...flight, privateNotes: event.currentTarget.value})} placeholder="Baggage, seats, check-in reminders…"/></label><p className="dt-booking-small">Visible only to the trip owner when collaborating.</p></details>}
      {boundary && <section className="dt-booking-plan-preview" aria-label="Preview changes to your day"><div className="dt-booking-preview-heading"><CheckCircle2 size={19} aria-hidden="true"/><h4>How this shapes your day</h4></div>
        {boundary.minutes !== null && <p className="dt-booking-preview-lead">{intent === 'arrival' ? 'Ready to leave the airport at ' : 'Be at the airport by '}<strong>{clockTime(boundary.minutes)}</strong><span> · {bookingDate(boundary.date)} · {boundary.timezone.replaceAll('_', ' ')}</span></p>}
        <p>{intent === 'arrival' ? `${flight.arrival.time || 'Landing time to confirm'} landing + ${flight.arrivalBufferMinutes ?? 60} min for immigration and bags. Your activities begin after this.` : `${flight.airportBufferMinutes ?? 120} min at the airport before your ${flight.departure.time || 'scheduled'} flight. Your day will end at the departure airport.`}</p>
        {boundary.issues.map((issue, index) => <p className="is-warning" key={index}><AlertCircle size={14} aria-hidden="true"/>{issue}</p>)}
        {boundaryOutside && <label className="dt-booking-check"><input type="checkbox" checked={extendDates} onChange={event => setExtendDates(event.currentTarget.checked)}/><span>Include {bookingDate(boundary.date)} in my trip<small>This travel day is outside your current trip dates.</small></span></label>}
        <label className="dt-booking-check"><input type="checkbox" checked={applyFlight && canApplyFlight} disabled={!canApplyFlight} onChange={event => setApplyFlight(event.currentTarget.checked)}/><span>{intent === 'arrival' ? 'Start this day from the arrival airport' : 'End this day at the departure airport'}<small>{canApplyFlight ? 'Existing stops stay in your plan. You can adjust them after saving.' : 'Confirm the times and include the travel day to use it in your plan.'}</small></span></label>
        {applyingFlight && <label className="dt-booking-transfer">Airport transfer<select value={transferMode} onChange={event => setTransferMode(event.currentTarget.value as typeof transferMode)}><option value="transit">Public transport</option><option value="drive">Taxi / drive</option><option value="walk">Walk</option></select><span className="dt-booking-small">Travel time is calculated in your day plan once the locations are mapped.</span></label>}
      </section>}
      {saveTarget && <p className="dt-booking-target is-compact"><Link2 size={16} aria-hidden="true"/>{linkDescription}</p>}{target && !saveTarget && <div className="dt-booking-target is-compact"><AlertCircle size={16} aria-hidden="true"/><div><strong>{!targetExists ? 'This position changed.' : outsideTrip(flight) ? 'This flight is outside your trip dates.' : 'This flight departs on a different day.'}</strong><p>{!targetExists ? 'Close this picker and choose Flight again.' : outsideTrip(flight) ? 'Include both flight dates in your trip, then choose this journey again.' : `Use a flight departing on ${bookingDate(targetDate!)} for this position.`}</p></div></div>}{!target && !intent && outsideTrip(flight) && <div className="dt-booking-target is-compact"><AlertCircle size={16} aria-hidden="true"/><div><strong>This flight is outside your trip dates.</strong><p>It can stay with your trip bookings. Extend the trip later if you want to add this journey to a day.</p></div></div>}
      {feedback}<div className="dt-booking-form-footer"><button type="button" className="dt-booking-button" onClick={back}>Cancel</button><button type="submit" className="dt-booking-button is-primary" disabled={!!target && !saveTarget}>{busy ? <LoaderCircle size={16} className="dt-booking-spin" aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}{target ? 'Save & use flight' : applyingFlight ? 'Save & update day' : outsideTrip(flight) || intent ? 'Save booking only' : 'Save flight'}</button></div>
      {intent && onNotFlying && !editingFlight && <button type="button" className="dt-booking-link dt-booking-not-flying" onClick={() => onNotFlying(intent)}>Not flying? Choose a start or end place<ArrowRight size={14} aria-hidden="true"/></button>}
    </fieldset></form></>}
    {page === 'stay' && <>{backButton()}<div className="dt-booking-editor-title"><span className="dt-booking-symbol is-stay"><BedDouble size={21} aria-hidden="true"/></span><div><p className="dt-booking-kicker">A home base for your days</p><h3>{editingStay ? 'Edit your stay' : 'Where are you staying?'}</h3></div></div><form className="dt-booking-form" onSubmit={event => void saveStay(event)}><fieldset disabled={busy} className="dt-booking-fields">{placeButton('stay', stay.placeId, 'Hotel, apartment or other stay')}
      <div className="dt-booking-form-grid"><label>Check-in date<input type="date" required value={stay.checkInDate} onInput={event => setStay({...stay, checkInDate: event.currentTarget.value})}/></label><label>Check-out date<input type="date" required value={stay.checkOutDate} min={stay.checkInDate} onInput={event => setStay({...stay, checkOutDate: event.currentTarget.value})}/></label></div>
      {stayNights > 0 && <p className="dt-booking-night-count"><BedDouble size={16} aria-hidden="true"/><strong>{stayNights} {stayNights === 1 ? 'night' : 'nights'}</strong><span> · check-out day is not an occupied night</span></p>}
      <div className="dt-booking-form-grid"><label>Check-in from <span className="dt-booking-optional">local time</span><input type="time" value={stay.checkInTime || ''} onInput={event => setStay({...stay, checkInTime: event.currentTarget.value || undefined})}/></label><label>Check-out by <span className="dt-booking-optional">local time</span><input type="time" value={stay.checkOutTime || ''} onInput={event => setStay({...stay, checkOutTime: event.currentTarget.value || undefined})}/></label></div><p className="dt-booking-small">Check these times against your booking. Leave them blank if you’re still deciding.</p>
      <details className="dt-booking-zone"><summary><span>{stay.timezone.replaceAll('_', ' ')}</span><span>Change time zone</span></summary><label>Property time zone<input required value={stay.timezone} list={`${id}-zones`} maxLength={100} onChange={event => setStay({...stay, timezone: event.currentTarget.value})} placeholder="e.g. Europe/Paris"/></label></details>
      {showPrivate && <details className="dt-booking-extra"><summary><LockKeyhole size={15} aria-hidden="true"/>Private booking details<ChevronDown size={14} aria-hidden="true"/></summary><label>Booking reference<input value={stay.bookingReference || ''} maxLength={160} onChange={event => setStay({...stay, bookingReference: event.currentTarget.value})} autoComplete="off" placeholder="Optional"/></label><label>Contact<input value={stay.contact || ''} maxLength={240} onChange={event => setStay({...stay, contact: event.currentTarget.value})} placeholder="Phone number, email or host details"/></label><label>Booking website<input type="url" value={stay.bookingUrl || ''} maxLength={2000} onChange={event => setStay({...stay, bookingUrl: event.currentTarget.value || undefined})} placeholder="https://…"/></label><label>Private notes<textarea rows={3} value={stay.privateNotes || ''} maxLength={4000} onChange={event => setStay({...stay, privateNotes: event.currentTarget.value})} placeholder="Arrival instructions, luggage storage, room details…"/></label><p className="dt-booking-small">Visible only to the trip owner when collaborating.</p></details>}
      {stay.placeId && stayNights > 0 && <section className="dt-booking-plan-preview" aria-label="Preview stay in your itinerary"><div className="dt-booking-preview-heading"><BedDouble size={19} aria-hidden="true"/><h4>Your days, joined up</h4></div><p>Use <strong>{bookingPlaceName(shownPlaces[stay.placeId])}</strong> as your home base for these nights.</p>
        {stayOutside && <label className="dt-booking-check"><input type="checkbox" checked={extendDates} onChange={event => setExtendDates(event.currentTarget.checked)}/><span>Extend my trip to cover this stay<small>{bookingDate(stay.checkInDate)} – {bookingDate(stay.checkOutDate)}</small></span></label>}
        <label className="dt-booking-check"><input type="checkbox" checked={applyStayOnSave} onChange={event => setApplyStayOnSave(event.currentTarget.checked)}/><span>Use this stay for day start and end points<small>Your selected airports and other custom endpoints stay as they are.</small></span></label>
        {applyStayOnSave && proposedStayDays.length > 0 && <details className="dt-booking-preview-days"><summary>Preview {proposedStayDays.length} {proposedStayDays.length === 1 ? 'day' : 'days'}<ChevronDown size={14} aria-hidden="true"/></summary><ul>{proposedStayDays.map(day => <li key={day.dayId}><strong>{proposedStayTrip.days[day.dayIndex]?.label}</strong><span>{day.startStayId === stay.id && day.endStayId === stay.id ? 'Start and end here' : day.startStayId === stay.id ? 'Start here' : 'End here'}</span></li>)}</ul></details>}
        {stayPreviewIssue && <p className="is-warning">{stayPreviewIssue}</p>}
        {stayOverlap && <p className="is-warning">Another stay covers some of these nights. Your current endpoints will be kept where bookings overlap.</p>}
        {applyStayOnSave && !proposedStayDays.length && <p className="is-warning">{stayOutside && !extendDates ? 'Include these dates to use the stay in your days.' : 'Your current day endpoints will be kept. You can choose this stay in a day’s settings.'}</p>}
      </section>}{feedback}<div className="dt-booking-form-footer"><button type="button" className="dt-booking-button" onClick={back}>Cancel</button><button type="submit" className="dt-booking-button is-primary">{busy ? <LoaderCircle size={16} className="dt-booking-spin" aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}{applyStayOnSave ? 'Save & update days' : 'Save stay'}</button></div>
    </fieldset></form></>}
    {page === 'location' && <>{backButton(locationField === 'stay' ? 'stay' : 'flight', 'Back to booking')}<div className="dt-booking-search"><DiscoveryPanel destination={trip.destination} purpose={locationField === 'stay' ? 'hotel' : 'endpoint'} initialQuery={locationField === 'stay' ? '' : 'Airport'} onPreview={() => {}} onSave={() => {}} onAdd={() => {}} statusOf={() => ''} onChoose={place => {if (!busy) void choosePlace(place);}} onCustom={() => go('custom')}/></div><p className="dt-booking-small">{locationField === 'stay' ? 'Choose the property itself for useful directions.' : 'Choose your departure or arrival airport, including the terminal if known.'}</p>{feedback}{busy && <p className="dt-booking-feedback" role="status"><LoaderCircle size={17} className="dt-booking-spin" aria-hidden="true"/>Saving this location…</p>}</>}
    {page === 'custom' && <>{backButton('location', 'Back to place search')}<h3>Add a location yourself</h3><p className="dt-booking-small">Save the name and address now. Choose a mapped location later to enable directions.</p><form className="dt-booking-form" onSubmit={event => {event.preventDefault(); const form = new FormData(event.currentTarget), name = String(form.get('name')).trim(); if (!name) return; void choosePlace({id: makeId('custom'), name, userLabel: name, cat: 'custom', area: String(form.get('area')).trim(), typical: '', blurb: '', x: 50, y: 50});}}><fieldset disabled={busy} className="dt-booking-fields"><label>{locationField === 'stay' ? 'Property name' : 'Airport name'}<input name="name" required maxLength={160} autoFocus placeholder={locationField === 'stay' ? 'e.g. Our Kyoto apartment' : 'e.g. Dublin Airport Terminal 2'}/></label><label>Address or city<input name="area" maxLength={240} placeholder={trip.destination}/></label>{feedback}<button type="submit" className="dt-booking-button is-primary">{busy ? <LoaderCircle size={16} className="dt-booking-spin" aria-hidden="true"/> : <Plus size={16} aria-hidden="true"/>}Use this location</button></fieldset></form></>}
    {page === 'link' && <>{backButton()}<div className="dt-booking-editor-title"><span className="dt-booking-symbol"><Plane size={21} aria-hidden="true"/></span><div><p className="dt-booking-kicker">Make room for the journey</p><h3>Add flight to {departureDay?.label || 'your itinerary'}</h3></div></div><FlightCard flight={flight} places={shownPlaces} compact/>{departureDay ? <><p className="dt-booking-small">This flight departs on {bookingDate(flight.departure.date)}. Choose where its airport transfers fit on {departureDay.label}.</p><form className="dt-booking-form" onSubmit={event => {event.preventDefault(); if (onLinkFlight) void action(() => onLinkFlight(flight.id, departureDay.id, linkTarget), 'Flight linked to its departure day.', () => {setTarget(undefined); back();});}}><fieldset className="dt-booking-fields" disabled={busy}><label>Position in {departureDay.label}<select value={linkTarget} onChange={event => setLinkTarget(event.currentTarget.value)}>{departureDay.items.map(item => <option value={`activity:${item.aid}`} key={item.aid}>Before {bookingPlaceName(shownPlaces[item.placeId])}</option>)}<option value={`end:${departureDay.id}`}>{departureDay.items.length ? 'At the end of the day' : 'Airport-to-airport travel day'}</option></select></label><p className="dt-booking-target is-compact"><Link2 size={16} aria-hidden="true"/>{!departureDay.items.length ? 'Uses these airports as the day’s start and end.' : linkTarget.startsWith('end:') ? 'Adds the departure airport and ends at the arrival airport.' : 'Adds airport transfers before this stop. Flight times stay fixed.'}</p>{feedback}<div className="dt-booking-form-footer"><button type="button" className="dt-booking-button" onClick={back}>Cancel</button><button type="submit" className="dt-booking-button is-primary" disabled={!onLinkFlight || !linkTarget}><Link2 size={16} aria-hidden="true"/>Use flight on {departureDay.label}</button></div></fieldset></form></> : <p className="dt-booking-feedback is-error">The departure date is outside this trip. Extend the trip dates before linking the flight.</p>}</>}
    {page === 'apply' && <>{backButton()}<div className="dt-booking-editor-title"><span className="dt-booking-symbol is-stay"><BedDouble size={21} aria-hidden="true"/></span><div><p className="dt-booking-kicker">Make your days join up</p><h3>Apply {bookingPlaceName(shownPlaces[stay.placeId])}</h3></div></div><p className="dt-booking-small">Review the day endpoints below. Manually selected airports and other overrides stay as you set them.</p><div className="dt-booking-apply-list">{staySuggestions.map(suggestion => <label key={suggestion.dayId}><input type="checkbox" checked={selectedDays.includes(suggestion.dayId)} disabled={busy} onChange={event => setSelectedDays(current => event.currentTarget.checked ? [...current, suggestion.dayId] : current.filter(item => item !== suggestion.dayId))}/><span><strong>{trip.days[suggestion.dayIndex]?.label} · {bookingDate(bookingDayDate(trip, suggestion.dayIndex))}</strong>{suggestion.startStayId === stay.id && suggestion.startPlaceId && <small>Start: {bookingPlaceName(shownPlaces[suggestion.startPlaceId])}</small>}{suggestion.endStayId === stay.id && suggestion.endPlaceId && <small>End: {bookingPlaceName(shownPlaces[suggestion.endPlaceId])}</small>}{suggestion.warnings.map((warning, i) => <small className="is-warning" key={i}>{warning}</small>)}</span></label>)}</div>{!staySuggestions.length && <div className="dt-booking-empty is-small"><MapPin size={23} aria-hidden="true"/><p>No eligible day endpoints for this stay. Check its dates and your existing day start and end locations.</p></div>}{feedback}<div className="dt-booking-form-footer"><button type="button" className="dt-booking-button" disabled={busy} onClick={back}>Cancel</button><button type="button" className="dt-booking-button is-primary" disabled={busy || !selectedDays.length || !onApplyStay} onClick={() => void action(() => onApplyStay!(stay.id, selectedDays), 'Accommodation applied to the selected day endpoints.', back)}>{busy ? <LoaderCircle size={16} className="dt-booking-spin" aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}Apply to {selectedDays.length} {selectedDays.length === 1 ? 'day' : 'days'}</button></div></>}
    {page === 'list' && onClose && <button type="button" className="dt-booking-link dt-booking-done" disabled={busy} onClick={onClose}>Back to my trip<ArrowRight size={15} aria-hidden="true"/></button>}
  </div>;
}
