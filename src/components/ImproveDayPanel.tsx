import {useId} from 'react';
import {ArrowDown, ArrowRight, Check, CheckCircle2, Clock3, Footprints, Info, LoaderCircle, LockKeyhole, Map, MapPin, RefreshCw, Route, ShieldCheck, X} from 'lucide-react';
import {dayStartTime, formatDuration, formatTime, type Day, type Place} from '../model';
import type {ImproveCandidate} from '../improveDay';
import type {ImproveState} from '../useImproveDay';

export type ImproveFixAction = 'day-plan' | 'locations' | 'modes';
export interface ImproveDayPanelProps {
  day: Day;
  places: Record<string, Place>;
  locks: string[];
  onLocksChange: (locks: string[]) => void;
  state: ImproveState;
  preview: 'current' | 'suggested';
  onPreviewChange: (preview: 'current' | 'suggested') => void;
  onRun: () => void;
  onClose: () => void;
  onApply: () => void;
  onFix?: (action: ImproveFixAction) => void;
  onShowMap?: () => void;
}

const phaseLabels = {
  checking: ['Checking your places', 'Getting the opening hours available for your visit date.'],
  comparing: ['Comparing routes', 'Looking for less travel while keeping your bookings in place.'],
  verifying: ['Checking the whole day', 'Verifying the journeys, visit times and return before making a suggestion.'],
} as const;
const fixLabels: Record<ImproveFixAction, string> = {'day-plan': 'Review day plan', locations: 'Find mapped locations', modes: 'Review transport'};
const plural = (count: number, singular: string, many = `${singular}s`) => `${count} ${count === 1 ? singular : many}`;

function ComparisonMetrics({current, suggested, day}: {current: ImproveCandidate; suggested: ImproveCandidate; day: Day}) {
  const before = current.evaluation, after = suggested.evaluation;
  const currentBookings = before.schedule.rows.filter(row => row.late > 0).length;
  const suggestedBookings = after.schedule.rows.filter(row => row.late > 0).length;
  const hoursConflicts = (candidate: ImproveCandidate) => Object.values(candidate.evaluation.checks).filter(check => check.status === 'closed' || check.status === 'short').length;
  const rows = [
    {label: 'Travel time', current: formatDuration(before.schedule.travel), suggested: formatDuration(after.schedule.travel), better: after.schedule.travel < before.schedule.travel},
    {label: 'Back at your stay', current: formatTime(before.schedule.finish), suggested: formatTime(after.schedule.finish), better: after.schedule.finish < before.schedule.finish},
    {label: 'Late bookings', current: String(currentBookings), suggested: String(suggestedBookings), better: suggestedBookings < currentBookings},
    {label: 'Hours conflicts', current: String(hoursConflicts(current)), suggested: String(hoursConflicts(suggested)), better: hoursConflicts(suggested) < hoursConflicts(current)},
    {label: 'Hours checked', current: `${day.items.length - before.unknownHours}/${day.items.length}`, suggested: `${day.items.length - after.unknownHours}/${day.items.length}`, better: false},
  ];
  if (before.schedule.wait || after.schedule.wait) rows.push({label: 'Waiting for bookings', current: formatDuration(before.schedule.wait), suggested: formatDuration(after.schedule.wait), better: after.schedule.wait < before.schedule.wait});
  if (day.finishBy !== null && day.finishBy !== undefined) {
    const overrun = (finish: number) => finish <= day.finishBy! ? 'On time' : `+${formatDuration(finish - day.finishBy!)}`;
    rows.push({label: `Finish goal · ${formatTime(day.finishBy)}`, current: overrun(before.schedule.finish), suggested: overrun(after.schedule.finish), better: after.schedule.finish < before.schedule.finish && before.schedule.finish > day.finishBy});
  }
  return <div className="improve-metrics-wrap"><table className="improve-metrics">
    <caption className="improve-sr-only">Compare the current and suggested day</caption>
    <thead><tr><th scope="col"><span className="improve-sr-only">Measure</span></th><th scope="col">Current</th><th scope="col">Suggested</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.current}</td><td className={row.better ? 'is-better' : ''}>{row.suggested}</td></tr>)}</tbody>
  </table></div>;
}

function StopOrder({candidate, day, places, locks, suggested}: {candidate: ImproveCandidate; day: Day; places: Record<string, Place>; locks: string[]; suggested: boolean}) {
  return <ol className="improve-stop-order" aria-label={suggested ? 'Suggested stop order' : 'Current stop order'}>
    {candidate.evaluation.schedule.rows.map((row, index) => {
      const oldPosition = day.items.findIndex(item => item.aid === row.it.aid);
      const moved = suggested && oldPosition !== index;
      const check = candidate.evaluation.checks[row.it.aid];
      const booked = row.it.fixed !== null;
      return <li key={row.it.aid} className={moved ? 'is-moved' : ''}>
        <span className="improve-order-number">{index + 1}</span>
        <div className="improve-order-copy"><strong>{places[row.it.placeId]?.name ?? row.pl.name}</strong>
          <span className="improve-order-meta"><time>{formatTime(row.start)}–{formatTime(row.end)}</time>{moved && <span className="improve-position-change" aria-label={`Moved from stop ${oldPosition + 1} to stop ${index + 1}`}>{oldPosition + 1}<ArrowRight size={10}/>{index + 1}</span>}</span>
          {(booked || locks.includes(row.it.aid)) && <span className="improve-lock-badge"><LockKeyhole size={10}/>{booked ? `Booked · ${formatTime(row.it.fixed!)}` : 'Position kept'}</span>}
          {check?.status === 'unknown' && <span className="improve-stop-note">Hours to confirm</span>}
          {(check?.status === 'closed' || check?.status === 'short') && <span className="improve-stop-note is-warning">{check.label}</span>}
          {row.late > 0 && <span className="improve-stop-note is-warning">{formatDuration(row.late)} late for booking</span>}
        </div>
        {moved && <span className="improve-move-dot" aria-hidden="true"/>}
      </li>;
    })}
  </ol>;
}

export default function ImproveDayPanel({day, places, locks, onLocksChange, state, preview, onPreviewChange, onRun, onClose, onApply, onFix, onShowMap}: ImproveDayPanelProps) {
  const headingId = useId();
  const busy = state.phase === 'checking' || state.phase === 'comparing' || state.phase === 'verifying';
  const proposal = state.phase === 'proposal' ? state.proposal : undefined;
  const activeCandidate = proposal && (preview === 'suggested' ? proposal.suggested : proposal.current);
  const bookings = day.items.filter(item => item.fixed !== null).length;
  const action = state.action;
  const canFix = state.phase === 'ineligible' && action && onFix;
  const canRun = !busy && state.phase !== 'ineligible';
  const activePhase = busy ? (['checking', 'comparing', 'verifying'] as const).indexOf(state.phase as keyof typeof phaseLabels) : -1;
  const saving = proposal ? proposal.current.evaluation.schedule.travel - proposal.suggested.evaluation.schedule.travel : 0;
  const unknownNames = proposal ? proposal.suggested.evaluation.schedule.rows.filter(row => proposal.suggested.evaluation.checks[row.it.aid]?.status === 'unknown').map(row => places[row.it.placeId]?.name ?? row.pl.name) : [];
  const currentMode = day.endMode === 'walk' ? 'Walking' : day.endMode === 'drive' ? 'Driving' : 'Public transport';

  const lockControls = <>
    <p className="improve-section-help">Keep any stop in its current position. These choices apply only to this comparison.</p>
    <ul className="improve-lock-list">{day.items.map((item, index) => {
      const booked = item.fixed !== null;
      const place = places[item.placeId];
      return <li key={item.aid}>
        <label className={booked ? 'is-booked' : ''}>
          <span className="improve-lock-index">{index + 1}</span>
          <span className="improve-lock-copy"><strong>{place?.name ?? 'Place to locate'}</strong><small>{booked ? `Booked at ${formatTime(item.fixed!)}` : formatDuration(item.duration)}</small></span>
          {booked ? <span className="improve-booked-icon" title="Booked stops keep their time and position"><LockKeyhole size={15}/><span className="improve-sr-only">Booking kept</span></span> : <input type="checkbox" checked={locks.includes(item.aid)} disabled={busy} onChange={event => onLocksChange(event.target.checked ? [...locks, item.aid] : locks.filter(id => id !== item.aid))} aria-label={`Keep ${place?.name ?? `stop ${index + 1}`} in position`}/>}
        </label>
      </li>;
    })}</ul>
    <p className="improve-section-help improve-anchor-note"><LockKeyhole size={12}/>Visits stay on the same side of a booking or a stop whose position you keep.</p>
  </>;

  return <section className="improve-panel" aria-labelledby={headingId}>
    <header className="improve-panel-header"><div><span className="improve-eyebrow"><Route size={13}/>A smoother day</span><h2 id={headingId}>Improve this day</h2></div><button className="icon-button" aria-label="Close day improvement" onClick={onClose}><X size={18}/></button></header>
    <div className="improve-panel-body" aria-busy={busy}>
      <div className="improve-day-context"><span>{day.label}</span><span>{plural(day.items.length, 'stop')}</span><span>From {formatTime(dayStartTime(day))}</span></div>

      {busy && <div className="improve-progress" role="status" aria-live="polite">
        <span className="improve-status-symbol"><LoaderCircle size={26} className="spin"/></span>
        <h3>{phaseLabels[state.phase as keyof typeof phaseLabels][0]}</h3><p>{phaseLabels[state.phase as keyof typeof phaseLabels][1]}</p>
        <ol className="improve-steps">{(['checking', 'comparing', 'verifying'] as const).map((phase, index) => <li key={phase} className={index < activePhase ? 'is-done' : index === activePhase ? 'is-active' : ''} aria-current={index === activePhase ? 'step' : undefined}><span>{index < activePhase ? <Check size={12}/> : index + 1}</span>{['Check places', 'Compare routes', 'Check the schedule'][index]}</li>)}</ol>
        <p className="improve-progress-reassurance"><ShieldCheck size={14}/>Your current plan is unchanged.</p>
      </div>}

      {!busy && !proposal && <>
        {state.phase === 'idle' && <div className="improve-intro"><span className="improve-status-symbol"><Route size={26}/></span><h3>Less backtracking.<br/>More time to explore.</h3><p>Find a better order for the places already in your day, using Google Maps travel times.</p><div className="improve-preserve"><ShieldCheck size={16}/><span>Your visits, notes and booked times stay yours. Review the suggestion before anything changes.</span></div></div>}
        {state.phase === 'ineligible' && <div className="improve-result-message"><span className="improve-status-symbol is-neutral"><Info size={25}/></span><h3>A quick check first</h3><p>{state.message || 'Make sure this day has mapped places and at least two flexible stops to compare.'}</p></div>}
        {state.phase === 'none' && <div className="improve-result-message"><span className="improve-status-symbol"><CheckCircle2 size={27}/></span><h3>Keep the day you have</h3><p>{state.message || 'No verified order saved at least 5 minutes of travel while fitting the day’s constraints.'}</p><p className="improve-result-caption">Your current plan is unchanged.</p></div>}
        {state.phase === 'error' && <div className="improve-result-message" role="alert"><span className="improve-status-symbol is-neutral"><RefreshCw size={25}/></span><h3>Couldn’t finish this comparison</h3><p>{state.message || 'Route information is unavailable at the moment. Try the comparison again.'}</p><p className="improve-result-caption">Your current plan is unchanged.</p></div>}
        {state.phase === 'stale' && <div className="improve-result-message" role="status"><span className="improve-status-symbol is-neutral"><RefreshCw size={25}/></span><h3>Your day has changed</h3><p>{state.message || 'Compare again to check the latest places, times and positions before applying a suggestion.'}</p></div>}
        {!!day.items.length && <div className="improve-lock-section"><h4>Keep stops in position <span>Optional</span></h4>{lockControls}</div>}
        <div className="improve-scope"><Info size={14}/><p>Compare up to 8 stops, with walking or driving for every journey. Bookings keep their time and position. A suggestion needs to save at least 5 minutes of travel.</p></div>
      </>}

      {proposal && <>
        <div className="improve-success" role="status"><span className="improve-success-eyebrow"><CheckCircle2 size={14}/>A better route is ready</span><h3>About <strong>{formatDuration(saving)}</strong><br/>less travel</h3><p>The same places and visit lengths.{bookings ? bookings === 1 ? ' Your booking stays in place.' : ` All ${bookings} bookings kept in place.` : ' A smoother order for your day.'}</p></div>
        <ComparisonMetrics current={proposal.current} suggested={proposal.suggested} day={day}/>
        <div className="improve-preview-heading"><h4>Preview the route</h4><span>{currentMode}</span></div>
        <div className="improve-preview-switch" role="group" aria-label="Preview route"><button aria-pressed={preview === 'current'} onClick={() => onPreviewChange('current')}>Current</button><button aria-pressed={preview === 'suggested'} onClick={() => onPreviewChange('suggested')}>Suggested <span>{plural(proposal.suggested.moved, 'move')}</span></button></div>
        <p className="improve-preview-help">The timeline and map show the {preview} order.</p>
        {onShowMap && <button className="button small full improve-view-map" onClick={onShowMap}><Map size={15}/>View {preview} route on map<ArrowRight size={14}/></button>}
        {activeCandidate && <StopOrder candidate={activeCandidate} day={day} places={places} locks={locks} suggested={preview === 'suggested'}/>}
        <div className="improve-route-end"><MapPin size={13}/><span>Return to {places.hotel?.name ?? 'your stay'}</span><time>{activeCandidate && formatTime(activeCandidate.evaluation.schedule.finish)}</time></div>
        <div className="improve-assurances"><p><ShieldCheck size={14}/>No late bookings or known opening-hours conflicts in the suggested order.</p>{proposal.suggested.evaluation.unknownHours > 0 && <p className="is-warning"><Info size={14}/><span>Hours still need confirming for {unknownNames.join(', ')}.</span></p>}{proposal.suggested.evaluation.regularHours > 0 && <p><Clock3 size={14}/><span>{plural(proposal.suggested.evaluation.regularHours, 'stop')} checked against usual opening hours. Date-specific changes may apply.</span></p>}</div>
        {!!proposal.hoursErrors && <p className="improve-provider-note">Some opening-hours details could not load. Review the places marked “Hours to confirm”.</p>}
        {!proposal.warning && day.endMode === 'walk' && <p className="improve-provider-note"><Footprints size={13}/>Walking directions may not include every pavement or pedestrian path. Check conditions along the route.</p>}
        {proposal.warning && <p className="improve-provider-note">{proposal.warning}</p>}
        {!proposal.warning && day.endMode === 'drive' && <p className="improve-provider-note">Driving estimates use typical routes without live traffic.</p>}
        <details className="improve-adjust"><summary>Adjust kept positions<ArrowDown size={13}/></summary>{lockControls}</details>
        <p className="improve-data-credit">Route and place information from Google Maps</p>
      </>}
    </div>
    <footer className="improve-panel-footer">
      {proposal && <p>Apply changes only the order. You can undo it.</p>}
      <div><button className="button" onClick={onClose}>{busy ? 'Cancel comparison' : 'Keep current'}</button>
        {proposal ? <button className="button primary" onClick={onApply} disabled={state.canApply === false}><Check size={15}/>Apply suggestion</button> : !busy && (canFix ? <button className="button primary" onClick={() => onFix(action)}>{fixLabels[action]}<ArrowRight size={14}/></button> : <button className="button primary" onClick={onRun} disabled={!canRun}>{state.phase === 'idle' ? <Route size={15}/> : <RefreshCw size={14}/>} {state.phase === 'idle' || state.phase === 'ineligible' ? 'Compare routes' : 'Compare again'}</button>)}
      </div>
    </footer>
  </section>;
}
