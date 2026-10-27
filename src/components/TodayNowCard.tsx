import {ArrowRight, Check, CheckCircle2, Clock, MapPin, Navigation, Plus, Sun} from 'lucide-react';
import type {Place} from '../model';
import {formatDuration,formatTime} from '../model';
import {travelDirectionsURL, travelPlaceName, tripLocalDate} from '../travel/model';
import type {TodayProjection, TodayRow} from '../today/model';

export function todayClock(value: number | null | undefined, timezone: string, date?: string) {
  if (value == null || !Number.isFinite(value)) return 'Time to confirm';
  try {
    const clock=new Intl.DateTimeFormat('en-GB', {timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(value);
    const localDate=tripLocalDate(timezone,value);
    const offset=date&&localDate?Math.round((Date.parse(`${localDate}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`))/86_400_000):0;
    return clock+(Number.isFinite(offset)&&offset!==0?` ${offset>0?'+':'−'}${Math.abs(offset)}d`:'');
  } catch { return 'Time to confirm'; }
}
export function todayJourney(row: TodayRow | null) {
  if (!row) return '';
  if(row.target.kind==='free')return `${formatDuration(row.freeMinutes??row.target.freeTime?.duration??0)} · no extra travel`;
  const mode = {walk:'Walk',drive:'Drive',transit:'Transit',flight:'Flight'}[row.mode];
  return `${mode} · ${row.leg.min == null ? 'travel time to confirm' : formatDuration(row.leg.min)}`;
}
export interface TodayNowCardProps {
  projection: TodayProjection;
  startPlace: Place;
  disabled?: boolean;
  readOnly?: boolean;
  compact?: boolean;
  hoursLabel?: string;
  onLeave: () => void;
  onArrive: () => void;
  onStay: () => void;
}
/** The traveller confirms their location; the clock never guesses it. */
export default function TodayNowCard({projection:p,startPlace,disabled=false,readOnly=false,compact=false,hoursLabel,onLeave,onArrive,onStay}:TodayNowCardProps) {
  const atFree=p.current?.target.kind==='free';
  const at = p.phase === 'visit', travelling = p.phase === 'travel', complete = p.phase === 'complete';
  const row = p.current ?? p.next;
  const next = p.next;
  const currentName = complete ? 'Your day is complete.' : at || travelling ? row?.name || travelPlaceName(startPlace) : travelPlaceName(startPlace);
  const remaining = p.leaveInMinutes;
  const airportBuffer=p.phase==='start'&&p.leaveAt!=null&&p.leaveAt>p.now;
  const waiting = at&&row?.start!=null&&row.start>p.now;
  const waitMinutes=waiting?Math.ceil((row!.start!-p.now)/60000):0;
  const countdown = airportBuffer?`Ready in ${formatDuration(Math.ceil(remaining??0))}`:waiting?`${row?.target.activity?.fixed!=null?'Starts':'Opens'} in ${formatDuration(waitMinutes)}`:at && remaining !== null ? remaining > 0 ? `Leave in ${formatDuration(Math.ceil(remaining))}` : remaining < 0 ? `Leave now · ${formatDuration(Math.ceil(-remaining))} over` : 'Time to leave' : null;
  const duration = row?.target.activity?.duration ?? 0;
  const pct = at && row?.start != null && p.leaveAt != null ? Math.max(0,Math.min(100,(p.now-row.start)/Math.max(60_000,p.leaveAt-row.start)*100)) : 0;
  const destination = travelling ? row : next;
  const href = destination&&destination.target.kind!=='free' ? travelDirectionsURL(destination.place,destination.mode) : null;
  if(atFree&&row)return <section className={`dt-today-now dt-today-free-now ${compact?'is-compact':''}`} aria-label="Right now"><div className="dt-today-now-top"><div><span className="dt-today-eyebrow">{row.name}</span><h2>Near {travelPlaceName(row.place)}</h2><p>{row.freeBookingName?`Head off at ${todayClock(p.leaveAt,p.timezone,p.date)} to reach ${row.freeBookingName} on time.`:`Take a little time for yourself. Head on when you’re ready.`}</p></div><span className={`dt-today-countdown ${(remaining??0)<=10?'is-soon':''}`}><Clock size={13} aria-hidden="true"/>{(remaining??0)>0?`${formatDuration(remaining!)} left`:'Time to head on'}</span></div>{row.freeWarning&&<p className="dt-today-small">{row.freeWarning}</p>}{destination&&<div className="dt-today-next-place"><span className="dt-today-eyebrow">Next</span><strong>{destination.name}</strong><p>{todayJourney(destination)} · {destination.arrival==null?'arrival to confirm':`arrive ≈ ${todayClock(destination.arrival,p.timezone,p.date)}`}</p></div>}{!readOnly&&<div className="dt-today-now-actions"><button className="dt-travel-button is-primary" disabled={disabled||!p.canAct} onClick={onLeave}>Done — head on<ArrowRight size={17} aria-hidden="true"/></button></div>}{href&&<a className="dt-today-directions" href={href} target="_blank" rel="noopener noreferrer"><Navigation size={15} aria-hidden="true"/>Directions to {destination?.name}<span className="dt-travel-sr"> in Google Maps, opens another app or tab</span></a>}{readOnly&&<p className="dt-today-small">Read-only snapshot · progress is not recorded.</p>}{!p.canAct&&!readOnly&&<p className="dt-today-small">This is a preview. Live timing starts on this travel day.</p>}</section>;
  return <section className={`dt-today-now ${compact?'is-compact':''}`} aria-label="Right now">
    <div className="dt-today-now-top"><div><span className="dt-today-eyebrow">{complete?'Day complete':travelling?'On the way':at?'Now':airportBuffer?'After your flight':'Start your day'}</span><h2>{currentName}</h2><p>{complete?'A little time to take it all in.':at?`Arrived ${todayClock(row?.arrival??row?.start,p.timezone,p.date)} · ${waiting?`waiting until ${todayClock(row?.start,p.timezone,p.date)} · `:''}${duration ? `${formatDuration(duration)} planned visit`:'You set the pace'}`:travelling?todayJourney(row):airportBuffer?`Allow time for immigration and bags · ready to leave ${todayClock(p.leaveAt,p.timezone,p.date)}`:'Confirm when you leave to follow the day from here.'}</p></div>{countdown && <span className={`dt-today-countdown ${remaining!==null&&remaining<=0?'is-over':remaining!==null&&remaining<=10?'is-soon':''}`}><Clock size={13} aria-hidden="true"/>{countdown}</span>}{complete && <CheckCircle2 size={28} aria-hidden="true"/>}</div>
    {(at || travelling) && (hoursLabel||row?.hours) && <p className="dt-today-small"><Clock size={13} aria-hidden="true"/>{hoursLabel||row?.hours?.label}</p>}
    {waiting&&<p className="dt-today-small">Your visit starts at {todayClock(row?.start,p.timezone,p.date)}. Leave at {todayClock(p.leaveAt,p.timezone,p.date)} after your planned visit.</p>}
    {at && <div className="dt-today-progress" role="progressbar" aria-label="Time spent at this stop" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><span className={remaining!==null&&remaining<0?'is-over':''} style={{width:`${pct}%`}}/></div>}
    {!complete && destination && !travelling && <div className="dt-today-next-place"><span className="dt-today-eyebrow">Next</span><strong>{destination.name}</strong><p>{todayJourney(destination)} · {destination.arrival==null?'arrival to confirm':`arrive ≈ ${todayClock(destination.arrival,p.timezone,p.date)}`}{destination.target.activity?.fixed!=null?` · booked ${p.booking?.targetId===destination.target.id?todayClock(p.booking.time,p.timezone,p.date):formatTime(destination.target.activity.fixed)}`:''}</p></div>}
    {travelling && row && <div className="dt-today-next-place"><span className="dt-today-eyebrow">Estimated arrival</span><strong>{todayClock(row.arrival,p.timezone,p.date)}</strong><p>{row.approx?'Some journey times still need confirming.':'Keep this day open. Your next visit starts when you confirm you’ve arrived.'}</p></div>}
    {!readOnly && !complete && <div className="dt-today-now-actions">{travelling ? <><button className="dt-travel-button is-primary" disabled={disabled||!p.canAct} onClick={onArrive}><Check size={17} aria-hidden="true"/>I’ve arrived</button>{href && <a className="dt-travel-button" href={href} target="_blank" rel="noopener noreferrer"><Navigation size={16} aria-hidden="true"/>Directions<span className="dt-travel-sr"> in Google Maps, opens another app or tab</span></a>}</> : <><button className="dt-travel-button is-primary" disabled={disabled||!p.canAct||!next} onClick={onLeave}>{next?.target.kind==='free'?'Start free time':at||airportBuffer?'Leaving now':'Start my day'}<ArrowRight size={17} aria-hidden="true"/></button>{at && <button className="dt-travel-button" disabled={disabled||!p.canAct} onClick={onStay}><Plus size={15} aria-hidden="true"/>Stay 15 min longer</button>}</>}</div>}
    {!travelling && href && <a className="dt-today-directions" href={href} target="_blank" rel="noopener noreferrer"><Navigation size={15} aria-hidden="true"/>Directions to {destination?.name}<span className="dt-travel-sr"> in Google Maps, opens another app or tab</span></a>}
    {!complete && !href && destination?.target.kind!=='free' && destination?.mode!=='flight' && <p className="dt-today-small"><MapPin size={14} aria-hidden="true"/>Add an exact location in the planner for directions.</p>}
    {readOnly && <p className="dt-today-small">Read-only snapshot · progress is not recorded.</p>}
    {!p.canAct && !readOnly && <p className="dt-today-small"><Sun size={14} aria-hidden="true"/>This is a preview. Live timing starts on this travel day.</p>}
  </section>;
}
