import {useRef} from 'react';
import {useDraggable, useDroppable} from '@dnd-kit/core';
import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {ArrowRight, ArrowRightLeft, Bookmark, CalendarDays, Clock3, Compass, GripVertical, LockKeyhole, MapPin, Plus, RefreshCw, Route, TriangleAlert} from 'lucide-react';
import {CATEGORIES, MAX_TRIP_DAYS, dayEndPlace, dayStartPlace, dayStartTime, formatDuration, formatTime, hasEndJourney, type Activity, type Day, type Place, type Trip} from '../model';
import type {DayOverviewSummary} from '../useTripOverview';
import {tripDayDate} from '../useLiveRoutes';
import './overview.css';
import PlaceHours from './PlaceHours';
import {visitDateForHours} from '../hoursPlanning';
import BookingEssentials from './BookingEssentials';
import {flightsForDay,staysForDay} from '../bookings/model';

export type TripOverviewProps = {
  trip: Trip;
  places: Record<string, Place>;
  summaries: Record<string, DayOverviewSummary>;
  loading: boolean;
  placesError?: string | null;
  readOnly: boolean;
  showPrivate?: boolean;
  onOpenDay: (dayIndex: number) => void;
  onBookings?:()=>void;
  onTravelDay?: (dayIndex: number) => void;
  onMove: (aid: string, dayIndex: number) => void;
  onAddIdea: (place: Place) => void;
  onAddDays: () => void;
  onDiscover: (dayIndex: number) => void;
  onRetry: () => void;
};

function PlaceCredits({place}: {place: Place}) {
  if (!place.attributions?.length) return null;
  return <span className="overview-place-credits">{place.attributions.map((credit, index) => <span key={index}>{credit.providerURI ? <a href={credit.providerURI} target="_blank" rel="noreferrer">{credit.provider}</a> : credit.provider}</span>)}</span>;
}

function OverviewStop({activity, place, readOnly, onMove, warning, date}: {date:string;activity: Activity; place: Place; readOnly: boolean; onMove: () => void; warning?: string}) {
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({
    id: 'act:' + activity.aid,
    data: {type: 'activity', aid: activity.aid},
    disabled: readOnly,
  });
  const category = CATEGORIES[place.cat];
  return <li ref={setNodeRef} className={`overview-stop ${isDragging ? 'is-dragging' : ''} ${readOnly ? 'is-readonly' : ''}`} style={{transform: CSS.Transform.toString(transform), transition}}>
    {!readOnly && <button type="button" className="overview-drag" {...attributes} {...listeners} aria-label={`Drag ${place.name} to another day or position`} title="Drag to another day or position"><GripVertical size={15}/></button>}
    <div className="overview-stop-content">
      <strong><i style={{background: category.ink}}/>{place.name}</strong>
      <span className="overview-stop-meta"><span>{activity.departureForFlightId?'Airport buffer':activity.mode==='flight'&&activity.duration===0?'Arrival airport':formatDuration(activity.duration)}</span>{activity.fixed !== null && <span className="overview-booking"><LockKeyhole size={10}/>{formatTime(activity.fixed)}</span>}</span>
      {activity.mode!=='flight'&&!activity.departureForFlightId&&<PlaceHours place={place} date={date}/>}
      {warning && <span className="overview-stop-warning"><TriangleAlert size={11}/>{warning}</span>}
      <PlaceCredits place={place}/>
    </div>
    {!readOnly && <button type="button" className="overview-move" onClick={onMove} aria-label={`Move ${place.name}`} title="Choose a day and position"><ArrowRightLeft size={15}/></button>}
  </li>;
}

function OverviewIdea({place, readOnly, onAdd}: {place: Place; readOnly: boolean; onAdd: () => void}) {
  const {attributes, listeners, setNodeRef, isDragging} = useDraggable({
    id: 'idea:' + place.id,
    data: {type: 'idea', placeId: place.id},
    disabled: readOnly,
  });
  return <li ref={setNodeRef} className={`overview-idea ${isDragging ? 'is-dragging' : ''} ${readOnly ? 'is-readonly' : ''}`}>
    {!readOnly && <button type="button" className="overview-drag" {...attributes} {...listeners} aria-label={`Drag ${place.name} into a day`} title="Drag into a day"><GripVertical size={15}/></button>}
    <div className="overview-idea-content"><strong>{place.name}</strong><span><i style={{background: CATEGORIES[place.cat].ink}}/>{CATEGORIES[place.cat].label}</span><PlaceCredits place={place}/></div>
    {!readOnly && <button type="button" className="overview-idea-add" onClick={onAdd} aria-label={`Choose a day for ${place.name}`} title="Choose a day"><Plus size={17}/></button>}
  </li>;
}

function OverviewDay({day, index, date, places, summary, loading, readOnly, onOpen, onMove, onDiscover, onTravel,trip}: {
  trip:Trip;day: Day; index: number; date: string; places: Record<string, Place>; summary?: DayOverviewSummary; loading: boolean; readOnly: boolean;
  onOpen: () => void; onMove: (aid: string) => void; onDiscover: () => void;
  onTravel?: () => void;
}) {
  const {setNodeRef, isOver} = useDroppable({id: 'day:' + index, data: {type: 'day', dayIdx: index}, disabled: readOnly});
  const hasStops = day.items.length > 0;
  const hasJourney = hasEndJourney(day);
  const startPlace = dayStartPlace(day, places);
  const endPlace = dayEndPlace(day, places);
  const visits = day.items.reduce((total, activity) => total + activity.duration, 0);
  const sc = summary?.sc;
  const bookingIssues = sc?.rows.filter(row => row.late > 0).length ?? 0;
  const finishOver = sc && day.finishBy != null ? Math.max(0, sc.finish - day.finishBy) : 0;
  const isCheckingRoutes = summary?.routeLoading || (!summary && loading);
  const hoursWarnings = summary?.visitIssueCount ?? 0;
  const dateLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});
  return <article ref={setNodeRef} className={`overview-day ${isOver ? 'is-drop-over' : ''} ${!hasJourney ? 'is-empty' : ''}`} aria-labelledby={`overview-day-${day.id}`}>
    <header className="overview-day-header">
      <div className="overview-day-date"><span>{day.label}</span><time dateTime={date}>{dateLabel}</time></div>
      <h3 id={`overview-day-${day.id}`}>{day.title}</h3>
      <p className="overview-day-count">{hasJourney && !hasStops ? 'Direct transfer' : `${day.items.length} ${day.items.length === 1 ? 'stop' : 'stops'}`}{hasStops && <><span>·</span>{formatDuration(visits)} of visits</>}</p>
    </header>
    {onTravel && <button type="button" className="overview-travel-day" onClick={onTravel} aria-label={`Today view for ${day.label}`}><Compass size={15}/>Today view<ArrowRight size={14}/></button>}
    {(flightsForDay(trip,index).length>0||staysForDay(trip,index).length>0)&&<div className="overview-booking-chips">{flightsForDay(trip,index).map(({flight,departure,arrival,continuation})=><span key={flight.id}>✈ {flight.flightNumber||'Flight'} · {continuation?'Continue after arrival':departure?`Departs ${flight.departure.time||'time to confirm'}`:`Arrives ${flight.arrival.time||'time to confirm'}`}{departure&&arrival?' · arrives '+(flight.arrival.time||'time to confirm'):''}</span>)}{staysForDay(trip,index).map(({stay,checkIn,checkOut})=><span key={stay.id}>⌂ {checkOut?'Check-out':checkIn?'Check-in':'Stay'} · {places[stay.placeId]?.userLabel||places[stay.placeId]?.name}</span>)}</div>}
    <div className="overview-endpoints">
      <div><span className="overview-endpoint-marker">S</span><span><small>Start from</small><strong>{startPlace.name}</strong></span></div>
      <div><span className="overview-endpoint-marker is-end">E</span><span><small>End at</small><strong>{endPlace.name}</strong></span></div>
    </div>
    {hasJourney && <div className="overview-timing">
      <div><Clock3 size={14}/><span>Start {formatTime(dayStartTime(day))}<b>·</b>{isCheckingRoutes ? 'Checking timing…' : sc && !sc.finishApprox ? `Arrive ${formatTime(sc.finish)}` : 'Timing incomplete'}</span></div>
      <div><Route size={14}/><span>{sc && (!sc.unknown || sc.travel > 0) ? `${sc.unknown ? 'At least ' : ''}${formatDuration(sc.travel)} travel` : isCheckingRoutes ? 'Checking journeys…' : 'Travel time unavailable'}{day.finishBy != null && <><b>·</b>Goal {formatTime(day.finishBy)}</>}</span></div>
    </div>}
    {(bookingIssues > 0 || hoursWarnings > 0 || finishOver > 0) && <div className="overview-day-alerts">
      {(bookingIssues > 0 || hoursWarnings > 0) && <p><TriangleAlert size={13}/><span>{[bookingIssues > 0 ? `${bookingIssues} booking ${bookingIssues === 1 ? 'conflict' : 'conflicts'}` : '', hoursWarnings > 0 ? `${hoursWarnings} ${hoursWarnings === 1 ? 'hours warning' : 'hours warnings'}` : ''].filter(Boolean).join(' · ')}</span></p>}
      {finishOver > 0 && <p><Clock3 size={13}/><span>{sc?.finishApprox ? 'At least ' : ''}{formatDuration(finishOver)} past finish goal</span></p>}
    </div>}
    {hasStops ? <>
      <SortableContext items={day.items.map(activity => 'act:' + activity.aid)} strategy={verticalListSortingStrategy}>
        <ol className="overview-stops" aria-label={`${day.label} places`}>{day.items.map(activity => {
          const place = places[activity.placeId];
          if (!place) return null;
          const check = summary?.visitChecks?.[activity.aid];
          const warning = check?.status === 'closed' || check?.status === 'short' ? check.label : undefined;
          const row = sc?.rows.find(row => row.it.aid === activity.aid);
          return <OverviewStop key={activity.aid} date={row?visitDateForHours(row,date):date} activity={activity} place={place} readOnly={readOnly} onMove={() => onMove(activity.aid)} warning={warning}/>;
        })}</ol>
      </SortableContext>
      <div className="overview-day-footer">
        <span className="overview-hours-note">{summary?.hoursLoading ? 'Checking opening hours…' : summary ? `Hours checked for ${summary.hoursCheckedCount} of ${day.items.length} stops${summary.hoursRegularCount > 0 ? ' · regular hours' : ''}` : 'Opening hours not checked'}</span>
        <button type="button" className="overview-open-day" onClick={onOpen} aria-label={`Open ${day.label}`}><span>Open day</span><ArrowRight size={15}/></button>
      </div>
    </> : <div className={`overview-empty-day${hasJourney ? ' is-transfer' : ''}`}>
      <span className="overview-empty-icon">{hasJourney ? <Route size={25} strokeWidth={1.5}/> : <Compass size={25} strokeWidth={1.5}/>}</span>
      <h4>{hasJourney ? 'A day for the journey' : 'Leave room for discovery'}</h4>
      <p>{hasJourney ? 'Your direct transfer is included in the day’s route and timing.' : readOnly ? 'No places planned for this day yet.' : 'Drop a saved idea here, or find somewhere new.'}</p>
      {!hasJourney && day.finishBy != null && <span className="overview-empty-goal">Start {formatTime(dayStartTime(day))} · Finish goal {formatTime(day.finishBy)}</span>}
      {!readOnly && <button type="button" className="button" onClick={onDiscover} aria-label={`Discover places for ${day.label}`}><Plus size={15}/>{hasJourney ? 'Add a stop' : 'Discover places'}</button>}
    </div>}
    {!hasStops && <div className="overview-day-footer"><button type="button" className="overview-open-day" onClick={onOpen} aria-label={`Open ${day.label}`}><span>Open day</span><ArrowRight size={15}/></button></div>}
  </article>;
}

export default function TripOverview({trip, places, summaries, loading, placesError, readOnly, showPrivate = !readOnly, onOpenDay, onTravelDay, onBookings, onMove, onAddIdea, onAddDays, onDiscover, onRetry}: TripOverviewProps) {
  const ideasPanel = useRef<HTMLElement>(null);
  const ideasHeading = useRef<HTMLHeadingElement>(null);
  const stopCount = trip.days.reduce((total, day) => total + day.items.length, 0);
  const ideas = trip.ideas.map(id => places[id]).filter((place): place is Place => !!place);
  const errors = trip.days.map(day => summaries[day.id]?.error).filter((error): error is string => !!error);
  const failed = errors.length > 0;
  const needsJourneyEstimates = failed && errors.every(error => /^\d+ journeys? needs? confirmation\.$/.test(error));
  const hasGoogleData = Object.values(places).some(place => !!place.googlePlaceId);
  const canExtend = trip.days.length < MAX_TRIP_DAYS;
  function jumpToIdeas() {
    ideasPanel.current?.scrollIntoView({block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    ideasHeading.current?.focus({preventScroll: true});
  }
  return <section className="trip-overview" aria-labelledby="trip-overview-title">
    <div className="overview-inner">
      <header className="overview-heading">
        <div><p className="overview-eyebrow"><Route size={15}/>THE BIG PICTURE</p><h2 id="trip-overview-title">Your whole trip</h2><p className="overview-intro">A little perspective. A little room to explore.{!readOnly && <span> Move places between days to find your pace.</span>}</p></div>
        {!readOnly && <button type="button" className="button primary overview-add-days" onClick={onAddDays} disabled={!canExtend} title={canExtend ? undefined : `Trips can have up to ${MAX_TRIP_DAYS} days`}><Plus size={17}/>{canExtend ? 'Add days' : `${MAX_TRIP_DAYS}-day limit`}</button>}
      </header>
      <div className="overview-at-a-glance">
        <div className="overview-stats" aria-label="Trip summary"><div><CalendarDays size={17}/><span>Days</span><strong>{trip.days.length}</strong></div><div><MapPin size={17}/><span>Planned stops</span><strong>{stopCount}</strong></div><button type="button" onClick={jumpToIdeas} aria-label={`View ${ideas.length} saved ideas`}><Bookmark size={17}/><span>Saved ideas</span><strong>{ideas.length}</strong></button></div>
        {loading && <span className="overview-progress" role="status"><span/>Checking trip details…</span>}
      </div>
      {(failed || placesError) && <div className="overview-load-notice"><span><TriangleAlert size={15}/>{placesError || (needsJourneyEstimates ? 'Some journeys need an estimate. Open a day to check locations and transport.' : 'Some trip details couldn’t be checked. Your places are still here.')}</span><button type="button" onClick={onRetry}><RefreshCw size={13}/>Retry checks</button></div>}
      <div className="overview-layout">
        <div className="overview-day-grid">{trip.days.map((day, index) => <OverviewDay trip={trip} key={day.id} day={day} index={index} date={tripDayDate(trip.startDate, index)} places={places} summary={summaries[day.id]} loading={loading} readOnly={readOnly} onOpen={() => onOpenDay(index)} onTravel={onTravelDay?()=>onTravelDay(index):undefined} onMove={aid => onMove(aid, index)} onDiscover={() => onDiscover(index)}/>)}
          {!readOnly && canExtend && <button type="button" className="overview-extend" onClick={onAddDays}><span><Plus size={23}/></span><strong>More time to explore?</strong><small>Add days to your trip</small></button>}
        </div>
        <aside ref={ideasPanel} className="overview-ideas" aria-labelledby="overview-ideas-title">
          <header><span className="overview-ideas-symbol"><Bookmark size={18}/></span><div><h3 ref={ideasHeading} id="overview-ideas-title" tabIndex={-1}>Ideas for the journey</h3><p>{ideas.length} {ideas.length === 1 ? 'place' : 'places'} waiting for a day</p></div></header>
          {!readOnly && ideas.length > 0 && <p className="overview-ideas-help">Choose a day with <Plus size={12}/>, or drag a place into your plan.</p>}
          {ideas.length ? <ul className="overview-idea-list">{ideas.map(place => <OverviewIdea key={place.id} place={place} readOnly={readOnly} onAdd={() => onAddIdea(place)}/>)}</ul> : <div className="overview-no-ideas"><Compass size={23} strokeWidth={1.5}/><p>Your next great find belongs here.</p><span>Save places while you explore, then give them a day.</span>{!readOnly && <button type="button" className="text-button" onClick={() => onDiscover(0)}>Discover places<ArrowRight size={13}/></button>}</div>}
          {ideas.length > 0 && !readOnly && <p className="overview-ideas-footnote">No rush. Unscheduled ideas stay saved here.</p>}
        </aside>
      </div>
      <BookingEssentials trip={trip} places={places} showPrivate={showPrivate} compact onManage={onBookings}/>
      <footer className="overview-footnote"><span>Travel estimates can change. Open a day for its full timeline and map.</span>{hasGoogleData && <span className="overview-google-credit">Place and route data from <b>Google Maps</b></span>}</footer>
    </div>
  </section>;
}
