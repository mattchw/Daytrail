import {useEffect, useId, useMemo, useRef, useState, type ReactNode} from 'react';
import {AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ClipboardList, Copy, Clock, Cloud, Flag, Footprints, HardDrive, Info, ListChecks, LoaderCircle, Map as MapIcon, MapPin, Navigation, Pencil, Plane, PlaneLanding, RotateCcw, SkipForward, Sun, WifiOff, X} from 'lucide-react';
import {dayEndPlace, dayStartPlace, dayStartTime, dayTimezone, formatDuration, formatTime, type Place, type Trip, type Journey, type schedule as ScheduleFunction} from '../model';
import type {VisitHoursCheck} from '../visitHours';
import {getWeekdayHoursLabel, type OpeningInfo} from '../openingHours';
import {nextTravelTarget, targetState, todayTravelDay, travelDateLabel, travelDayDate, travelDirectionsURL, travelPlaceName, travelTargets, tripLocalDate, type TravelMark, type TravelTarget} from '../travel/model';
import FlightCard, {previousFlightConnection} from './FlightCard';
import BookingEssentials from './BookingEssentials';
import {flightsForDay} from '../bookings/model';
import {buildTodayProjection, buildTodayFixes, type TodayFix} from '../today/model';
import {useTodayRuntime} from '../today/useTodayRuntime';
import type {TodayPersistence} from '../today/persistence';
import {useTodayRoutes} from '../today/useTodayRoutes';
import TodayNowCard, {todayClock} from './TodayNowCard';
import TodayBookingSheet from './TodayBookingSheet';
import {useDayWeather} from '../weather/useDayWeather';
import {visitExposure,weatherLocation,weatherVisits} from '../weather/model';
import {TodayWeatherStrip} from './DayComfort';
import {useConnectivity} from '../offline/connectivity';
import './travel-mode.css';

export type TravelProgressStatus = 'loading' | 'local' | 'saving' | 'syncing' | 'saved' | 'offline' | 'auth' | 'conflict' | 'failed' | 'setup';
export interface TravelProgressConflict {targetId: string; local: TravelMark; remote: TravelMark | null; rejected?: boolean}
export interface TravelModeProps {
  trip: Trip;
  places: Record<string, Place>;
  dayIndex: number;
  onDayChange: (index: number) => void;
  onEditPlan: () => void;
  onBack: () => void;
  marks: Record<string, TravelMark>;
  onSetState: (targetId: string, state: TravelMark) => Promise<void>;
  progressStatus?: TravelProgressStatus;
  /** False while durable progress storage is opening; the itinerary stays readable. */
  ready?: boolean;
  error?: string | null;
  pendingCount?: number;
  onRetry?: () => void;
  conflicts?: TravelProgressConflict[];
  onResolveConflict?: (targetId: string, choice: 'local' | 'remote') => Promise<void>;
  map: ReactNode;
  schedule: ReturnType<typeof ScheduleFunction>;
  /** Planned-visit checks keyed by activity aid, not place ID. */
  hours?: Record<string, VisitHoursCheck>;
  loading?: boolean;
  readOnly?: boolean;
  showPrivate?: boolean;
  canEditPlan?: boolean;
  onChooseLocation?: (placeId: string) => void;
  onActiveTargetChange?: (target: TravelTarget | null) => void;
  onMapActiveChange?: (active: boolean) => void;
  onManageBookings?: () => void;
  onStartFromFlight?: (flightId: string) => void;
  progressOwnerId?: string | null;
  hoursByPlace?: Record<string, OpeningInfo | undefined>;
  progressScope?: 'guest' | 'account';
  verifiedRoutes?: Record<string, Journey>;
  onApplyTodayFix?: (fix: TodayFix) => Promise<void>;
  onUndoPlan?: () => Promise<void>;
  canUndoPlan?: boolean;
  onOffline?: () => void;
  todayPersistence?: TodayPersistence;
}

const modeNames = {walk: 'Walk', drive: 'Drive', transit: 'Transit', flight: 'Flight'};
const markNames: Record<TravelMark, string> = {planned: 'Planned', done: 'Done', skipped: 'Skipped'};
const progressLabels: Record<TravelProgressStatus, string> = {
  loading: 'Opening progress…', local: 'Progress on this device', saving: 'Saving progress on this device…',
  syncing: 'Syncing progress…', saved: 'Progress saved to your account', offline: 'Offline · progress on this device',
  auth: 'Sign in to sync progress', conflict: 'Progress changed elsewhere', failed: 'Progress needs attention',
  setup: 'Progress sync unavailable',
};

/** A travel view of the existing plan. Only explicit actions change progress. */
export default function TravelMode({trip, places, dayIndex, onDayChange, onEditPlan, onBack, marks, onSetState,
  progressStatus = 'local', ready = true, error, pendingCount = 0, onRetry, conflicts = [], onResolveConflict,
  map, schedule, hours = {}, loading = false, readOnly = false, showPrivate = !readOnly, canEditPlan = !readOnly, onChooseLocation, onActiveTargetChange, onMapActiveChange, onManageBookings, onStartFromFlight, hoursByPlace, progressOwnerId = null, progressScope = 'guest', verifiedRoutes, onApplyTodayFix, onUndoPlan, canUndoPlan = false,onOffline,todayPersistence}: TravelModeProps) {
  const id = useId(), day = trip.days[Math.max(0, Math.min(dayIndex, trip.days.length - 1))];
  const online=useConnectivity();
  const timezone = dayTimezone(trip, day);
  const [tab, setTab] = useState<'today' | 'map' | 'essentials'>('today');
  const [preferred, setPreferred] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [observedDate, setObservedDate] = useState(() => tripLocalDate(timezone));
  const [busy, setBusy] = useState<string | null>(null), [actionError, setActionError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [copiedAddress,setCopiedAddress] = useState<string|null>(null);
  const [bookingActivityId,setBookingActivityId] = useState<string|null>(null);
  const [fixOpen, setFixOpen] = useState(false), [fixedPlan, setFixedPlan] = useState(false);
  const fixesDialog = useRef<HTMLDialogElement>(null);
  const [undo, setUndo] = useState<{targetId: string; placeId: string; from: TravelMark; to: TravelMark; label: string} | null>(null);
  const mounted = useRef(true), view = useRef(day.id), nextHeading = useRef<HTMLHeadingElement>(null);
  view.current = day.id;
  const callbacks = useRef({onActiveTargetChange, onMapActiveChange}); callbacks.current = {onActiveTargetChange, onMapActiveChange};
  const targets = useMemo(() => travelTargets(day, trip), [day, trip]);
  const next = nextTravelTarget(targets, marks, preferred);
  const first = nextTravelTarget(targets, marks);
  const startPlace = dayStartPlace(day, places), endPlace = dayEndPlace(day, places);
  const firstLegMode = day.items[0]?.mode ?? day.endMode;
  const hasFlightDetails = flightsForDay(trip, dayIndex).length > 0;
  const selectedDate = travelDayDate(trip.startDate, dayIndex), localDate = tripLocalDate(timezone, now);
  const todayIndex = todayTravelDay(trip, now), isToday = selectedDate === localDate;
  const newDay = observedDate !== localDate && todayIndex !== null && todayIndex !== dayIndex;
  const completed = targets.filter(target => target.kind === 'activity' && targetState(marks, target.id) === 'done').length;
  const landed = targets.filter(target => target.kind === 'flight' && targetState(marks, target.id) === 'done').length;
  const skipped = targets.filter(target => target.kind === 'activity' && targetState(marks, target.id) === 'skipped').length;
  const activeRow = next?.activity ? schedule.rows.find(row => row.it.aid === next.activity!.aid) : undefined;
  const activePlace = next ? places[next.placeId] : undefined;
  const activeDirections = next ? travelDirectionsURL(activePlace, next.mode) : null;
  const activeHours = next?.activity ? hours[next.activity.aid] : undefined;
  const endTarget = targets.find(target => target.kind === 'end');
  const endDone = endTarget && targetState(marks, endTarget.id) === 'done';
  const status = progressStatus === 'saved' && pendingCount > 0 ? 'syncing' : progressStatus;
  const StatusIcon = status === 'offline' ? WifiOff : status === 'local' ? HardDrive : status === 'saved' ? Cloud
    : ['loading', 'saving', 'syncing'].includes(status) ? LoaderCircle : AlertCircle;
  const runtimeState = useTodayRuntime({ownerId:progressOwnerId,scope:progressScope,trip,dayIndex,places,marks,hoursByPlace,onSetState,enabled:!readOnly && ready,persistence:todayPersistence});
  const baseTodayOptions = {trip,dayIndex,places,schedule,marks,now,runtime:runtimeState.runtime,verifiedRoutes,hoursByPlace};
  const baseProjection = buildTodayProjection(baseTodayOptions);
  const todayRoutes = useTodayRoutes(baseTodayOptions,runtimeState.ready&&baseProjection.canAct&&!readOnly,fixOpen,JSON.stringify([progressOwnerId,progressScope]));
  const todayOptions = {...baseTodayOptions,verifiedRoutes:{...verifiedRoutes,...todayRoutes.routes}};
  const projection = buildTodayProjection(todayOptions);
  const fixes = fixOpen ? buildTodayFixes(todayOptions) : [];
  const visibleFixes = fixes.filter(fix=>fix.action.kind==='leave-now'||Boolean(canEditPlan&&onApplyTodayFix));
  const hoursProblem = projection.problem;
  const longerProjection = fixOpen&&projection.current&&runtimeState.runtime?buildTodayProjection({...todayOptions,runtime:{...runtimeState.runtime,leaveAt:Math.max(now,projection.leaveAt??now)+15*60000}}):null;
  const longerEffect = longerProjection?.booking?longerProjection.booking.slackMinutes==null?'Arrival time still needs a route estimate':longerProjection.booking.slackMinutes<0?`${formatDuration(Math.abs(longerProjection.booking.slackMinutes))} late for ${longerProjection.booking.name} at ${todayClock(longerProjection.booking.time,timezone,projection.date)}`:`${formatDuration(longerProjection.booking.slackMinutes)} spare for ${longerProjection.booking.name} at ${todayClock(longerProjection.booking.time,timezone,projection.date)}`:longerProjection?.finish!=null?`Finish ≈ ${todayClock(longerProjection.finish,timezone,projection.date)}`:'The rest of the day updates after this visit.';
  const liveView = projection.canAct && !preferred;
  const plannedWeatherLocations=new Map(weatherVisits(trip,dayIndex,places,schedule).map(visit=>[visit.id,visit.location]));
  const liveWeatherVisits=liveView?projection.rows.filter(row=>row.target.activity&&row.mark!=='done'&&row.mark!=='skipped'&&(row.end===null||row.end>now)).map(row=>({id:row.target.activity!.aid,placeId:row.target.placeId,name:row.name,startMs:row.start===null?null:Math.max(now,row.start),endMs:row.end,approx:row.approx,exposure:visitExposure(row.target.activity!,row.place),location:plannedWeatherLocations.get(row.target.activity!.aid)??weatherLocation(row.place,projection.timezone)})):undefined;
  const dayWeather=useDayWeather({trip,dayIndex,places,schedule,visits:liveWeatherVisits,date:liveView?localDate??undefined:undefined,now,enabled:tab==='today'});
  const locked = !ready || readOnly || !!busy || runtimeState.busy;

  useEffect(() => {
    const dialog = fixesDialog.current;
    if (fixOpen && dialog && !dialog.open) dialog.showModal();
    else if (!fixOpen && dialog?.open) dialog.close();
  }, [fixOpen]);
  async function runTodayAction(action: 'leave' | 'arrive' | 'stay' | 'undo') {
    if (locked || !runtimeState.ready) return;
    const dayId = day.id; setBusy(`today:${action}`); setActionError('');
    try {
      if(action === 'leave') await runtimeState.leaveNow(projection);
      else if(action === 'arrive') await runtimeState.arrived(projection);
      else if(action === 'stay') await runtimeState.stayLonger(projection,15);
      else await runtimeState.undo();
      if(mounted.current && view.current===dayId){setNow(Date.now());setUndo(null);setFixedPlan(false);setAnnouncement(action==='leave'?'On your way. The rest of your day has updated.':action==='arrive'?projection.next?.target.kind==='flight'?'Landing recorded. Your airport arrival buffer is included.':projection.next?.target.kind==='end'?'You’ve arrived at your final stop.':'Arrival recorded. Your visit starts now.':action==='stay'?'Staying 15 minutes longer. The rest of your day has updated.':'Today change undone.');}
    } catch(reason) {if(mounted.current && view.current===dayId)setActionError(reason instanceof Error?reason.message:'This change could not be saved. Try again.');}
    finally {if(mounted.current)setBusy(null);}
  }
  async function applyTodayFix(fix: TodayFix) {
    if(locked) return;
    if(fix.stateSignature!==projection.stateSignature){setActionError('Your progress changed. Review these refreshed options before applying a fix.');return;}
    if(fix.action.kind==='leave-now'){setFixOpen(false);await runTodayAction('leave');return;}
    if(!onApplyTodayFix || !canEditPlan) return;
    const dayId=day.id;setBusy(`fix:${fix.id}`);setActionError('');
    try {await onApplyTodayFix(fix);if(mounted.current&&view.current===dayId){setFixOpen(false);setFixedPlan(true);setAnnouncement(`${fix.label}. Your day has updated.`);}}
    catch(reason){if(mounted.current&&view.current===dayId)setActionError(reason instanceof Error?reason.message:'Your day changed. Review it before trying again.');}
    finally {if(mounted.current)setBusy(null);}
  }
  async function undoTodayPlan() {
    if(!onUndoPlan || locked) return;
    setBusy('undo:plan');setActionError('');
    try {await onUndoPlan();setFixedPlan(false);setAnnouncement('Plan change undone.');}
    catch(reason){setActionError(reason instanceof Error?reason.message:'This change could not be undone.');}
    finally {if(mounted.current)setBusy(null);}
  }

  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {
    const update = () => {if(document.visibilityState==='visible')setNow(Date.now());};
    const timer = window.setInterval(update, 30_000);
    const visible = () => {if (document.visibilityState === 'visible') update();};
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', visible);
    return () => {window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', visible);};
  }, []);
  useEffect(() => {setPreferred(null); setUndo(null); setActionError(''); setAnnouncement(''); setFixOpen(false);setFixedPlan(false);setBookingActivityId(null);}, [day.id]);
  useEffect(() => {setObservedDate(tripLocalDate(timezone));}, [trip.id, timezone]);
  useEffect(() => {callbacks.current.onActiveTargetChange?.(next);}, [next?.id, next?.placeId, day.id]);
  useEffect(() => {callbacks.current.onMapActiveChange?.(tab === 'map');}, [tab]);
  useEffect(() => () => {callbacks.current.onMapActiveChange?.(false);}, []);

  async function setProgress(target: TravelTarget, state: TravelMark, rememberUndo = true) {
    if (locked) return;
    const dayId = day.id, before = targetState(marks, target.id), label = target.kind === 'flight' ? target.flight?.flightNumber || 'Flight' : travelPlaceName(places[target.placeId]);
    setBusy(target.id); setActionError('');
    try {
      await onSetState(target.id, state);
      if (!mounted.current || view.current !== dayId) return;
      if (rememberUndo && before !== state) setUndo({targetId: target.id, placeId: target.placeId, from: before, to: state, label});
      else if (!rememberUndo) setUndo(null);
      setAnnouncement(`${label} ${state === 'planned' ? 'returned to the plan' : state === 'done' && target.kind === 'flight' ? 'marked landed' : state === 'done' && target.kind === 'end' ? 'marked arrived' : `marked ${state}`}.`);
      if (target.id === next?.id) {
        setPreferred(null);
        requestAnimationFrame(() => {if (mounted.current && view.current === dayId) nextHeading.current?.focus({preventScroll: true});});
      }
    } catch (reason) {if (mounted.current && view.current === dayId) setActionError(reason instanceof Error ? reason.message : 'Progress could not be saved. Please try again.');}
    finally {if (mounted.current) setBusy(null);}
  }
  function undoProgress() {
    if (!undo) return;
    const target = targets.find(item => item.id === undo.targetId);
    if (!target || target.placeId !== undo.placeId || targetState(marks, undo.targetId) !== undo.to) {setUndo(null); setActionError('This stop changed elsewhere. Review its current progress below.'); return;}
    void setProgress(target, undo.from, false);
  }
  async function resolveConflict(targetId: string, choice: 'local' | 'remote') {
    if (!onResolveConflict || locked) return;
    const dayId = day.id;
    setBusy(`conflict:${targetId}`); setActionError('');
    try {await onResolveConflict(targetId, choice);}
    catch (reason) {if (mounted.current && view.current === dayId) setActionError(reason instanceof Error ? reason.message : 'This progress could not be resolved. Try again.');}
    finally {if (mounted.current) setBusy(null);}
  }
  useEffect(()=>{
    const handleUndo=(event:KeyboardEvent)=>{
      if(!(event.metaKey||event.ctrlKey)||event.altKey||event.shiftKey||event.key.toLowerCase()!=='z'||locked||readOnly)return;
      const target=event.target instanceof HTMLElement?event.target:null;
      if(target?.isContentEditable||target?.closest('input,textarea,select'))return;
      if(undo){event.preventDefault();undoProgress();}
      else if(fixedPlan&&canUndoPlan&&onUndoPlan){event.preventDefault();void undoTodayPlan();}
      else if(runtimeState.canUndo){event.preventDefault();void runTodayAction('undo');}
    };
    window.addEventListener('keydown',handleUndo);
    return()=>window.removeEventListener('keydown',handleUndo);
  });
  function makeNext(target: TravelTarget) {
    setPreferred(target.id);
    setAnnouncement(`${travelPlaceName(places[target.placeId])} is your next stop. Your itinerary order is unchanged.`);
    requestAnimationFrame(() => nextHeading.current?.focus({preventScroll: false}));
  }
  function directions(place: Place | undefined, mode: TravelTarget['mode'], label = 'Directions') {
    if (mode === 'flight') return <span className="dt-travel-flight-direction-note"><Plane size={14} aria-hidden="true"/>See the scheduled flight details above.</span>;
    const href = travelDirectionsURL(place, mode);
    return href ? <a className="dt-travel-button" href={href} target="_blank" rel="noopener noreferrer"><Navigation size={16} aria-hidden="true"/>{label}<span className="dt-travel-sr"> in Google Maps, opens another app or tab</span></a>
      : <div className="dt-travel-unlocated"><span>Exact location needed</span>{canEditPlan && onChooseLocation && place && <button className="dt-travel-link" onClick={() => onChooseLocation(place.id)}>Choose location<ArrowRight size={14} aria-hidden="true"/></button>}</div>;
  }
  function driverAddress(place:Place|undefined) {
    if(!place)return null;
    const addresses=[...new Set([place.offlineDetails?.address?.trim()||place.area?.trim(),place.offlineDetails?.localAddress?.trim()].filter((value):value is string=>!!value))];
    return <div className="dt-today-driver-address"><span><MapPin size={14} aria-hidden="true"/>Address for your driver</span>{addresses.length?addresses.map((address,index)=><p key={index} lang={address===place.offlineDetails?.localAddress?'und':undefined}>{address}</p>):<p>No address saved yet.</p>}{addresses.length>0&&<button className="dt-travel-link" onClick={async()=>{try{await navigator.clipboard.writeText([travelPlaceName(place),...addresses].join('\n'));setCopiedAddress(place.id);setAnnouncement('Address copied.');}catch{setActionError('The address could not be copied. You can select and copy it above.');}}}>{copiedAddress===place.id?<Check size={14} aria-hidden="true"/>:<Copy size={14} aria-hidden="true"/>}{copiedAddress===place.id?'Address copied':'Copy address'}</button>}</div>;
  }
  function placeCredits(place: Place | undefined) {
    if (!place?.googlePlaceId && !place?.attributions?.length) return null;
    const mapsURL = place.googlePlaceId ? `https://www.google.com/maps/search/?${new URLSearchParams({api: '1', query: travelPlaceName(place), query_place_id: place.googlePlaceId})}` : null;
    return <div className="dt-travel-place-credits">{mapsURL && <a href={mapsURL} target="_blank" rel="noopener noreferrer">Google Maps</a>}{place.attributions?.map((credit, index) => {
      let href: string | null = null;
      try {if (credit.providerURI) {const url = new URL(credit.providerURI); if (url.protocol === 'https:') href = url.href;}} catch {/* Keep the provider name visible when its link is invalid. */}
      return <span key={`${credit.provider}-${index}`}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{credit.provider}</a> : credit.provider}</span>;
    })}</div>;
  }
  function flightCard(target: TravelTarget, compact = false) {
    const flight = target.flight;
    if (!flight) return null;
    const departurePlace = places[flight.fromPlaceId];
    const departureDay = selectedDate === flight.departure.date;
    return <section className={`dt-travel-next dt-travel-next-flight ${compact ? 'is-compact' : ''}`} aria-labelledby={`${id}-next-heading`}>
      <div className="dt-travel-next-eyebrow"><span><span className="dt-travel-live-dot"/>Up next · your flight</span><Plane size={18} aria-hidden="true"/></div>
      <h2 id={`${id}-next-heading`} tabIndex={-1} ref={nextHeading}>Fly to {travelPlaceName(places[flight.toPlaceId])}</h2>
      <FlightCard flight={flight} places={places} previousFlight={previousFlightConnection(flight, trip.flights ?? [])} showPrivate={showPrivate} compact={compact}/>
      <div className="dt-travel-next-actions">{!readOnly && <button className="dt-travel-button is-primary" disabled={locked} onClick={() => liveView&&projection.next?.target.id===target.id?void runTodayAction('arrive'):void setProgress(target, 'done')}>{busy === target.id ? <LoaderCircle size={18} className="dt-travel-spin" aria-hidden="true"/> : <PlaneLanding size={18} aria-hidden="true"/>}Mark landed</button>}{departureDay && directions(departurePlace, 'transit', 'Directions to departure airport')}</div>
      <p className="dt-travel-next-footnote">{readOnly ? 'Read-only flight details · progress is not recorded.' : 'Mark landed after you arrive. Reaching the departure airport does not complete this flight.'}</p>
      {onManageBookings && canEditPlan && !readOnly && <button className="dt-travel-link" onClick={onManageBookings}>Flight details<ArrowRight size={14} aria-hidden="true"/></button>}
      {preferred && target.id !== first?.id && <button className="dt-travel-link dt-travel-follow-order" onClick={() => setPreferred(null)}>Follow itinerary order<ArrowRight size={14} aria-hidden="true"/></button>}
    </section>;
  }
  function nextCard(compact = false) {
    if(liveView && (projection.phase==='visit' || projection.next?.target.kind !== 'flight')) return <TodayNowCard projection={projection} startPlace={places[projection.originPlaceId]??startPlace} disabled={locked||!runtimeState.ready} hoursLabel={getWeekdayHoursLabel(hoursByPlace?.[(projection.current??projection.next)?.target.placeId??''],selectedDate??'')} readOnly={readOnly} compact={compact} onLeave={()=>void runTodayAction('leave')} onArrive={()=>void runTodayAction('arrive')} onStay={()=>void runTodayAction('stay')}/>;
    if (!next) return <section className="dt-travel-next dt-travel-finished" aria-labelledby={`${id}-next-heading`}>
      <span className="dt-travel-finished-icon">{targets.length ? <CheckCircle2 size={30} aria-hidden="true"/> : <Sun size={30} aria-hidden="true"/>}</span>
      <p className="dt-travel-kicker">{targets.length ? 'A little time to take it all in' : 'Make this day yours'}</p>
      <h2 id={`${id}-next-heading`} tabIndex={-1} ref={nextHeading}>{targets.length ? endDone ? 'You’ve reached your last stop.' : 'Your day’s progress is complete.' : 'An open day, full of possibility.'}</h2>
      <p>{targets.length ? `${completed} ${completed === 1 ? 'stop' : 'stops'} done${landed ? ` · ${landed} ${landed === 1 ? 'flight' : 'flights'} landed` : ''}${skipped ? ` · ${skipped} skipped` : ''}. You can return any stop to planned below.` : 'There are no stops or transfers planned. Add a place when you’re ready.'}</p>
      {!readOnly && <button className="dt-travel-button" onClick={onEditPlan}><Pencil size={16} aria-hidden="true"/>Open day planner</button>}
    </section>;
    if (next.kind === 'flight') return flightCard(next, compact);
    const name = travelPlaceName(activePlace), leg = next.kind === 'end' ? schedule.endLeg : activeRow?.leg;
    const itemIndex = next.activity ? day.items.findIndex(item => item.aid === next.activity!.aid) : day.items.length;
    const from = itemIndex > 0 ? places[day.items[itemIndex - 1].placeId] : startPlace;
    const note = next.activity?.note || (next.kind === 'end' ? activePlace?.userNotes : '');
    return <section className={`dt-travel-next ${compact ? 'is-compact' : ''}`} aria-labelledby={`${id}-next-heading`}>
      <div className="dt-travel-next-eyebrow"><span><span className="dt-travel-live-dot"/>{next.kind === 'end' ? 'Your final destination' : 'Up next'}</span><span>{next.kind === 'end' ? <Flag size={17} aria-hidden="true"/> : `Stop ${itemIndex + 1} of ${day.items.length}`}</span></div>
      <h2 id={`${id}-next-heading`} tabIndex={-1} ref={nextHeading}>{next.kind === 'end' ? 'Head to ' : ''}{name}</h2>
      {activePlace?.area && <p className="dt-travel-place-area"><MapPin size={14} aria-hidden="true"/><span>{activePlace.area}</span></p>}
      <div className="dt-travel-time-tags">
        {next.activity?.fixed != null && <span className="is-booked"><Clock size={14} aria-hidden="true"/>Booked {formatTime(next.activity.fixed)}</span>}
        {activeRow && <span>Planned {activeRow.approx && activeRow.it.fixed === null ? '≈ ' : ''}{formatTime(activeRow.start)}–{formatTime(activeRow.end)}</span>}
        {next.kind === 'end' && <span>{schedule.finishApprox ? 'Arrival time to confirm' : `Planned arrival ${formatTime(schedule.finish)}`}</span>}
        {next.kind === 'end' && day.finishBy != null && <span>Arrival goal {formatTime(day.finishBy)}</span>}
      </div>
      <div className="dt-travel-next-actions">{activeDirections ? <a className="dt-travel-button is-primary" href={activeDirections} target="_blank" rel="noopener noreferrer"><Navigation size={18} aria-hidden="true"/>Directions<ArrowRight size={16} aria-hidden="true"/><span className="dt-travel-sr"> to {name} in Google Maps, opens another app or tab</span></a> : <div className="dt-travel-location-needed"><MapPin size={18} aria-hidden="true"/><span>Choose an exact location for directions.</span>{canEditPlan && onChooseLocation && <button className="dt-travel-button" onClick={() => onChooseLocation(next.placeId)}>Choose location</button>}</div>}
        {!readOnly && <div className="dt-travel-progress-actions"><button className="dt-travel-button is-done" disabled={locked} onClick={() => void setProgress(next, 'done')}>{busy === next.id ? <LoaderCircle size={18} className="dt-travel-spin" aria-hidden="true"/> : <Check size={18} aria-hidden="true"/>}{next.kind === 'end' ? 'Arrived' : 'Done'}</button>{next.kind === 'activity' && <button className="dt-travel-button is-quiet" disabled={locked} onClick={() => void setProgress(next, 'skipped')}><SkipForward size={16} aria-hidden="true"/>Skip for now</button>}</div>}
      </div>
      {!compact && note && <div className="dt-travel-note"><ClipboardList size={17} aria-hidden="true"/><p>{note}</p></div>}
      <div className="dt-travel-journey"><Footprints size={17} aria-hidden="true"/><div><strong>{modeNames[next.mode]}{leg?.min != null ? ` · ${formatDuration(leg.min)}` : ' · estimate unavailable'}</strong><span>Planned journey from {travelPlaceName(from)}. Google Maps checks your current route.</span></div></div>
      {activeHours && activeHours.status !== 'fits' && <details className={`dt-travel-hours ${activeHours.status === 'unknown' ? '' : 'is-warning'}`}><summary><Info size={15} aria-hidden="true"/>{activeHours.label}<ChevronDown size={14} aria-hidden="true"/></summary><p>{activeHours.detail}</p></details>}
      {preferred && next.id !== first?.id && <button className="dt-travel-link dt-travel-follow-order" onClick={() => setPreferred(null)}>Follow itinerary order<ArrowRight size={14} aria-hidden="true"/></button>}
      {placeCredits(activePlace)}
      <p className="dt-travel-next-footnote">{readOnly ? 'Read-only snapshot · your progress is not recorded.' : 'You set the pace. Stops only advance when you choose.'}</p>
    </section>;
  }
  function todayStatus() {
    if(!liveView || projection.phase==='complete') return null;
    const booking=projection.booking, late=booking?.lateMinutes, problem=Boolean(late&&late>0||hoursProblem?.severity==='red');
    const bookingLabel=booking?`${booking.name} at ${todayClock(booking.time,timezone,projection.date)}`:'';
    const text=hoursProblem?`${hoursProblem.name}: ${hoursProblem.label}`:booking?late!=null&&late>0?`You’ll be ${formatDuration(Math.ceil(late))} late for ${bookingLabel}`:booking.slackMinutes==null?`Timing to confirm for ${bookingLabel}`:`On track for ${bookingLabel} · ${formatDuration(Math.max(0,Math.floor(booking.slackMinutes)))} spare`:projection.unknown?'Some journeys still need a travel estimate.':projection.finish==null?'Your day will update as you go.':`On track · finish ≈ ${todayClock(projection.finish,timezone,projection.date)}`;
    return <div className={`dt-today-status ${problem?'is-late':projection.unknown||hoursProblem?.severity==='amber'?'is-uncertain':''}`} role="status"><span>{problem?<AlertCircle size={18} aria-hidden="true"/>:<CheckCircle2 size={18} aria-hidden="true"/>}<strong>{text}</strong></span>{!readOnly && <button className="dt-travel-button" disabled={locked} onClick={()=>setFixOpen(true)}>{problem?'Fix it':'Running late?'}</button>}</div>;
  }
  function fullDay() {
    return <section className="dt-travel-day-list" aria-labelledby={`${id}-day-heading`}>
      <div className="dt-travel-section-title"><div><p className="dt-travel-kicker">One good stop at a time</p><h2 id={`${id}-day-heading`}>Rest of the day</h2></div><span>{day.items.length} {day.items.length === 1 ? 'stop' : 'stops'}</span></div>
      <div className="dt-travel-start"><span><MapPin size={16} aria-hidden="true"/></span><div><small>Start · {formatTime(dayStartTime(day))}</small><strong>{travelPlaceName(startPlace)}</strong></div></div>
      <ol className="dt-travel-stops">{(liveView?projection.rows.map(row=>row.target):targets).map((target) => {
        const state = targetState(marks, target.id), place = places[target.placeId];
        const liveRow = liveView ? projection.rows.find(item=>item.target.id===target.id) : undefined;
        const rowHours=liveRow?.hours??(target.activity?hours[target.activity.aid]:undefined);
        const rowHoursLabel=getWeekdayHoursLabel(hoursByPlace?.[target.placeId],liveRow?.start!=null?tripLocalDate(timezone,liveRow.start)??selectedDate??'':selectedDate??'');
        const row = target.activity ? schedule.rows.find(item => item.it.aid === target.activity!.aid) : undefined;
        if (target.kind === 'flight' && target.flight) return <li key={target.id} className={`${next?.id === target.id ? 'is-next' : ''} is-${state} dt-travel-flight-stop`}>
          <span className="dt-travel-stop-number" aria-hidden="true">{state === 'done' ? <Check size={16}/> : <Plane size={15}/>}</span>
          <div className="dt-travel-stop-copy"><div className="dt-travel-stop-label"><strong>{target.flight.flightNumber || 'Flight'} · {travelPlaceName(places[target.flight.toPlaceId])}</strong><span>{state !== 'planned' ? state === 'done' ? 'Landed' : markNames[state] : next?.id === target.id ? 'Up next' : 'Scheduled'}</span></div><p>{target.flight.departure.time || 'Time to confirm'} {target.flight.departure.timezone.replaceAll('_', ' ')} → {target.flight.arrival.time || 'Time to confirm'} {target.flight.arrival.timezone.replaceAll('_', ' ')}</p><details className="dt-travel-stop-note"><summary>Flight details<ChevronDown size={13} aria-hidden="true"/></summary><FlightCard flight={target.flight} places={places} previousFlight={previousFlightConnection(target.flight, trip.flights ?? [])} showPrivate={showPrivate} compact/></details>{!readOnly && <div className="dt-travel-stop-actions">{state !== 'planned' ? <button className="dt-travel-link" disabled={locked} onClick={() => void setProgress(target, 'planned')}><RotateCcw size={14} aria-hidden="true"/>Mark as planned</button> : !liveView && target.id !== next?.id ? <button className="dt-travel-link" disabled={locked} onClick={() => makeNext(target)}>Make next<ArrowRight size={14} aria-hidden="true"/></button> : null}</div>}</div>
        </li>;
        return <li key={target.id} className={`${projection.current?.target.id===target.id?'is-current':next?.id === target.id ? 'is-next' : ''} is-${state}`}>
          <span className="dt-travel-stop-time">{state === 'done'?<Check size={18} aria-label="Done"/>:state==='skipped'?<SkipForward size={17} aria-label="Skipped"/>:liveView?liveRow?.start!=null?todayClock(liveRow.start,timezone,projection.date):liveRow?.arrival!=null?todayClock(liveRow.arrival,timezone,projection.date):<span aria-label="Time to confirm">—</span>:row?formatTime(row.start):<Flag size={16} aria-hidden="true"/>}{liveRow?.delayMinutes!=null&&Math.abs(liveRow.delayMinutes)>=1&&state==='planned'&&<small className={liveRow.delayMinutes>0?'is-later':'is-earlier'}>{liveRow.delayMinutes>0?'+':'−'}{formatDuration(Math.abs(Math.round(liveRow.delayMinutes)))}</small>}</span>
          <div className="dt-travel-stop-copy"><div className="dt-travel-stop-label"><strong>{travelPlaceName(place)}</strong><span>{state !== 'planned' ? markNames[state] : projection.current?.target.id===target.id?'You are here':next?.id === target.id ? 'Up next' : target.kind === 'end' ? 'End point' : 'Planned'}</span></div>
            <p>{target.activity?.fixed != null ? `Booked ${formatTime(target.activity.fixed)}` : row ? `Planned ${row.approx ? '≈ ' : ''}${formatTime(row.start)}` : day.finishBy != null ? `Arrival goal ${formatTime(day.finishBy)}` : 'Your final destination'}{target.activity && ` · ${formatDuration(target.activity.duration)}`}</p>
            {target.kind==='activity' && state==='planned' && <div className={`dt-today-row-hours is-${rowHours?.status??'unknown'}`}><Clock size={13} aria-hidden="true"/><span>{rowHoursLabel}</span></div>}{rowHours&&['closed','short'].includes(rowHours.status)&&state==='planned'&&<p className={rowHours.status==='closed'?'dt-today-row-late':'dt-today-row-short'}>{rowHours.label}</p>}
            {liveRow?.lateMinutes!=null&&liveRow.lateMinutes>0&&state==='planned'&&<p className="dt-today-row-late">Arrives {todayClock(liveRow.arrival,timezone,projection.date)} · {formatDuration(Math.ceil(liveRow.lateMinutes))} late</p>}
            {target.activity?.fixed!=null && <button className="dt-travel-link" onClick={()=>setBookingActivityId(target.activity!.aid)}>Show booking<ArrowRight size={13} aria-hidden="true"/></button>}
            {target.activity?.note && <details className="dt-travel-stop-note"><summary>View note<ChevronDown size={13} aria-hidden="true"/></summary><p>{target.activity.note}</p></details>}
            {!readOnly && <div className="dt-travel-stop-actions">{state !== 'planned' ? <button className="dt-travel-link" disabled={locked} onClick={() => void setProgress(target, 'planned')}><RotateCcw size={14} aria-hidden="true"/>Mark as planned</button> : !liveView && target.kind === 'activity' && target.id !== next?.id ? <button className="dt-travel-link" disabled={locked} onClick={() => makeNext(target)}>Make next<ArrowRight size={14} aria-hidden="true"/></button> : null}</div>}
          </div>
        </li>;
      })}</ol>
      {targets.length === 0 && <p className="dt-travel-muted">No stops yet. Your start and end are the same place.</p>}
      <p className="dt-travel-list-footnote">{liveView?'Times update from your confirmed progress. Live timing is saved on this device; journey estimates can change.':'Preview times follow your saved plan. Live timing starts on this travel day.'}</p>
    </section>;
  }

  return <div className="dt-travel">
    <header className="dt-travel-header"><div className="dt-travel-header-inner"><button className="dt-travel-icon" onClick={onBack} aria-label="Back to my trips"><ArrowLeft size={20} aria-hidden="true"/></button><div className="dt-travel-brand"><span>DAYTRAIL <i/> TODAY</span><strong>{trip.name}</strong></div>{onOffline&&<button className="dt-travel-icon dt-travel-offline" onClick={onOffline} aria-label="Offline access"><HardDrive size={19} aria-hidden="true"/></button>}<button className="dt-travel-button dt-travel-edit" onClick={onEditPlan}><Pencil size={16} aria-hidden="true"/><span>{canEditPlan ? 'Edit plan' : 'View plan'}</span></button></div></header>
    <main className="dt-travel-main">
      <section className="dt-travel-day-heading" aria-label="Today view day"><div><p className="dt-travel-kicker">{isToday ? 'A good day to be out there' : 'A look at your plans'}</p><h1>{day.title || day.label}</h1><p>{travelDateLabel(selectedDate)} <span className={`dt-travel-date-badge ${isToday ? 'is-today' : ''}`}>{isToday ? 'Today' : 'Preview'}</span></p></div><label className="dt-travel-day-select"><span className="dt-travel-sr">Choose day</span><select value={dayIndex} onChange={event => onDayChange(Number(event.target.value))} disabled={!!busy}>{trip.days.map((item, index) => <option value={index} key={item.id}>{item.label} · {travelDateLabel(travelDayDate(trip.startDate, index))}{index === todayIndex ? ' · Today' : ''}</option>)}</select><ChevronDown size={16} aria-hidden="true"/></label></section>
      <div className="dt-travel-context"><span><Clock size={13} aria-hidden="true"/>{timezone.replaceAll('_', ' ')} time</span>{!readOnly && <span className={`dt-travel-save is-${status}`} role="status"><StatusIcon size={13} className={['loading', 'saving', 'syncing'].includes(status) ? 'dt-travel-spin' : undefined} aria-hidden="true"/>{progressLabels[status]}{pendingCount > 0 && <span> · {pendingCount} waiting</span>}</span>}</div>
      {projection.stale && <div className="dt-travel-banner"><Info size={18} aria-hidden="true"/><p>Your itinerary changed since your last check-in. Confirm your next stop to continue with the updated day.</p></div>}
      {newDay && <div className="dt-travel-banner"><Sun size={18} aria-hidden="true"/><div><strong>A new day has started at your destination.</strong><p>Your current day stays open until you’re ready.</p><button className="dt-travel-link" onClick={() => {setObservedDate(localDate); onDayChange(todayIndex!);}}>View today<ArrowRight size={14} aria-hidden="true"/></button><button className="dt-travel-link is-muted" onClick={() => setObservedDate(localDate)}>Stay on this day</button></div></div>}
      {(error || actionError || runtimeState.error) && <div className="dt-travel-banner is-error" role="alert"><AlertCircle size={18} aria-hidden="true"/><div><p>{actionError || error || runtimeState.error}</p>{onRetry && <button className="dt-travel-link" onClick={() => {setActionError(''); onRetry();}}>Retry saving<RotateCcw size={14} aria-hidden="true"/></button>}</div></div>}
      {(!online || status === 'offline') && <div className="dt-travel-connection" role="status"><WifiOff size={16} aria-hidden="true"/><div><strong>{!online?'No connection':'Progress waiting to sync'}</strong><p>You can read this plan{ready&&!readOnly?' and save progress on this device':''}. Maps and fresh journey estimates need a connection.</p>{onOffline&&<button className="dt-travel-link" onClick={onOffline}>Check offline access<ArrowRight size={13} aria-hidden="true"/></button>}</div></div>}
      {!ready && !readOnly && <p className="dt-travel-connection"><LoaderCircle size={16} className="dt-travel-spin" aria-hidden="true"/>Opening saved progress. You can still read your day.</p>}
      {conflicts.length > 0 && <section className="dt-travel-conflicts" aria-label="Review progress changes">{conflicts.map(conflict => <div key={conflict.targetId}><strong>{travelPlaceName(places[targets.find(target => target.id === conflict.targetId)?.placeId ?? ''])} changed elsewhere</strong><p>Your change: {markNames[conflict.local]}. {conflict.remote === null ? conflict.rejected ? 'This change could not sync. You can discard it and keep the saved progress.' : 'Saved status is unavailable. Refresh before choosing a version.' : `Saved change: ${markNames[conflict.remote]}.`}</p>{conflict.remote === null && onRetry && <button className="dt-travel-link" onClick={onRetry}>Refresh progress<RotateCcw size={14} aria-hidden="true"/></button>}{onResolveConflict && <div><button className="dt-travel-button" disabled={locked || conflict.remote === null} onClick={() => void resolveConflict(conflict.targetId, 'local')}>Keep my progress</button><button className="dt-travel-button" disabled={locked || conflict.remote === null && !conflict.rejected} onClick={() => void resolveConflict(conflict.targetId, 'remote')}>{conflict.rejected && conflict.remote === null ? 'Discard this progress change' : 'Use saved progress'}</button></div>}</div>)}</section>}
      <nav className="dt-travel-tabs" aria-label="Today views"><div role="tablist" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const tabs = ['today', 'map', 'essentials'] as const, index = tabs.indexOf(tab);
        const nextTab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
        setTab(nextTab); document.getElementById(`${id}-tab-${nextTab}`)?.focus();
      }}>{([{key: 'today', label: 'Today', Icon: ListChecks}, {key: 'map', label: 'Map', Icon: MapIcon}, {key: 'essentials', label: 'Bookings', Icon: ClipboardList}] as const).map(({key, label, Icon}) => <button key={key} id={`${id}-tab-${key}`} type="button" role="tab" aria-selected={tab === key} aria-controls={`${id}-panel`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}><Icon size={17} aria-hidden="true"/>{label}</button>)}</div></nav>
      {(loading||todayRoutes.loading) && <p className="dt-travel-loading" role="status"><LoaderCircle size={14} className="dt-travel-spin" aria-hidden="true"/>{todayRoutes.loading?'Checking live journey times…':'Updating place details and planned journeys…'}</p>}
      {todayRoutes.error&&<p className="dt-travel-connection"><Info size={15}/>{todayRoutes.error}<button className="dt-travel-link" onClick={todayRoutes.retry}>Retry routes</button></p>}
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className={`dt-travel-panel is-${tab}`}>
        {tab === 'today' && <div className="dt-travel-today"><div className="dt-today-live-column">{nextCard()}{todayStatus()}<TodayWeatherStrip weather={dayWeather}/></div>{fullDay()}</div>}
        {tab === 'map' && <><div className="dt-travel-map-frame">{map}</div><div className="dt-travel-map-summary">{nextCard(true)}</div></>}
        {tab === 'essentials' && <div className="dt-travel-essentials"><BookingEssentials trip={trip} places={places} dayIndex={dayIndex} showPrivate={showPrivate} onManage={canEditPlan ? onManageBookings : undefined} onStartFromFlight={canEditPlan ? onStartFromFlight : undefined}/><section><div className="dt-travel-section-title"><div><p className="dt-travel-kicker">Keep the important things close</p><h2>Start & end points</h2></div><MapPin size={22} aria-hidden="true"/></div><div className="dt-travel-endpoints">{([{label: 'Start from', place: startPlace, time: `${firstLegMode === 'flight' ? 'At airport' : 'Leave at'} ${formatTime(dayStartTime(day))}`, mode: firstLegMode}, {label: 'End at', place: endPlace, time: day.finishBy != null ? `Arrival goal ${formatTime(day.finishBy)}` : 'Your final destination', mode: day.endMode}]).map(endpoint => <article key={endpoint.label}><p className="dt-travel-kicker">{endpoint.label}</p><h3>{travelPlaceName(endpoint.place)}</h3><p>{endpoint.time}</p>{driverAddress(endpoint.place)}{endpoint.place.userNotes && <p className="dt-travel-preserve">{endpoint.place.userNotes}</p>}{directions(endpoint.place, endpoint.mode)}{placeCredits(endpoint.place)}</article>)}</div><p className="dt-travel-essential-note">{hasFlightDetails ? 'Follow the airport arrival goal and post-landing buffer on each flight card. Your arrival-day start is when you are ready to leave the airport. Ground-transfer arrival goals are the times you plan to reach those locations.' : 'For an airport start, use the time you expect to leave after baggage collection. An airport finish goal is your planned terminal arrival, including your own buffer before the flight.'}</p></section>
          <section><div className="dt-travel-section-title"><div><p className="dt-travel-kicker">Times to remember</p><h2>Bookings & notes</h2></div><ClipboardList size={22} aria-hidden="true"/></div>{day.items.filter(item => item.fixed !== null || item.note.trim()).length ? <ul className="dt-travel-bookings">{day.items.filter(item => item.fixed !== null || item.note.trim()).map(item => <li key={item.aid}>{item.fixed !== null && <span className="dt-travel-booked"><Clock size={14} aria-hidden="true"/>Booked {formatTime(item.fixed)}</span>}<h3>{travelPlaceName(places[item.placeId])}</h3>{driverAddress(places[item.placeId])}{item.note && <p>{item.note}</p>}{directions(places[item.placeId], item.mode)}{placeCredits(places[item.placeId])}</li>)}</ul> : <p className="dt-travel-muted">No activity bookings or notes for this day. Add them in the day planner.</p>}</section>
        </div>}
      </div>
      {!readOnly && !undo && (runtimeState.canUndo || fixedPlan&&canUndoPlan) && <div className="dt-travel-undo"><span><CheckCircle2 size={16} aria-hidden="true"/>{fixedPlan?'Your plan has updated':'Your day has updated'}</span><button className="dt-travel-link" disabled={locked} onClick={()=>fixedPlan?void undoTodayPlan():void runTodayAction('undo')}><RotateCcw size={15} aria-hidden="true"/>Undo</button></div>}
      {undo && !readOnly && <div className="dt-travel-undo"><span><CheckCircle2 size={16} aria-hidden="true"/>{undo.label} · {markNames[undo.to]}</span><button className="dt-travel-link" onClick={undoProgress} disabled={locked}><RotateCcw size={15} aria-hidden="true"/>Undo</button></div>}
      <TodayBookingSheet activity={day.items.find(item=>item.aid===bookingActivityId)??null} place={places[day.items.find(item=>item.aid===bookingActivityId)?.placeId??'']} date={selectedDate} timezone={timezone} onClose={()=>setBookingActivityId(null)} onEditPlan={canEditPlan?()=>{setBookingActivityId(null);onEditPlan();}:undefined}/>
      <dialog ref={fixesDialog} className="dt-today-fixes" aria-labelledby={`${id}-fix-title`} onCancel={()=>setFixOpen(false)} onClick={event=>{if(event.target===event.currentTarget)setFixOpen(false);}}><div className="dt-today-sheet-handle"/><header><h2 id={`${id}-fix-title`}>{projection.booking?.lateMinutes||hoursProblem? 'Get back on track':'A little more time?'}</h2><button className="dt-travel-icon" aria-label="Close timing options" onClick={()=>setFixOpen(false)}><X size={18}/></button></header><p>Choose what works for you. Each option shows its effect before you apply it.</p>{actionError&&<p role="alert" className="dt-today-row-late">{actionError}</p>}<ul>{visibleFixes.map(fix=><li key={fix.id}><button className={`dt-today-fix-option ${fix.resolves?'is-solution':''}`} disabled={locked} onClick={()=>void applyTodayFix(fix)}><span><strong>{fix.label}</strong><span>{fix.detail}</span><b>{fix.outcome}</b></span><span>Apply<ArrowRight size={14}/></span></button></li>)}</ul>{!visibleFixes.length&&<p className="dt-travel-muted">{projection.booking?.lateMinutes||hoursProblem?'No safe quick fix is available with the current journey estimates. Review the day in your planner.':'Your day has room to breathe. You can stay longer at your current stop.'}</p>}{projection.phase==='visit'&&<button className="dt-today-stay-preview" disabled={locked} onClick={()=>{setFixOpen(false);void runTodayAction('stay');}}><strong>Stay 15 min longer</strong><span>{longerEffect}</span></button>}{canEditPlan&&<button className="dt-travel-link" onClick={()=>{setFixOpen(false);onEditPlan();}}>Open day planner<ArrowRight size={14}/></button>}</dialog>
      <p className="dt-travel-sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      <footer className="dt-travel-footer">Find your places. Enjoy your day.<span>DAYTRAIL</span></footer>
    </main>
  </div>;
}
