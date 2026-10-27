import {useId,useRef,useState} from 'react';
import {CloudSun,CloudRain,Footprints,Utensils,ChevronDown,RefreshCw,X,Info} from 'lucide-react';
import {formatTime,type Pace} from '../model';
import type {PacingAssessment} from '../pacing/model';
import type {DayWeatherResult} from '../weather/useDayWeather';
import {summarizeWeather,weatherDescription} from '../weather/model';
import './day-comfort.css';

const hash=(text:string)=>{let result=2166136261;for(let i=0;i<text.length;i++)result=Math.imul(result^text.charCodeAt(i),16777619);return (result>>>0).toString(36);};
export const comfortNoticeKey=(assessment:PacingAssessment,kind:'meal'|'taxi')=>`comfort:${kind}:${hash(JSON.stringify(kind==='meal'?[assessment.gaps.map(gap=>[gap.id,gap.date,gap.window,Math.floor(gap.start/15),Math.floor(gap.end/15)])]:[assessment.pace,assessment.limitMeters,Math.floor(assessment.walking.knownMeters/500),[...assessment.walking.unknownLegIds].sort(),[...assessment.walking.unknownVisitIds].sort(),[...assessment.walking.estimatedVisitIds].sort()]))}`;
export const weatherNoticeKey=(weather:DayWeatherResult)=>`comfort:rain:${hash(JSON.stringify([weather.date,weather.visits.map(visit=>[visit.id,visit.startMs===null?null:Math.floor(visit.startMs/900000),visit.endMs===null?null:Math.floor(visit.endMs/900000),visit.exposure]),weather.risks.map(risk=>[risk.activityId,risk.status,risk.probability===null?null:Math.floor(risk.probability/10)])]))}`;
export const weatherStatusLabel=(weather:DayWeatherResult)=>weather.status==='too-early'?'Forecast available 10 days before':weather.status==='past'?'Past day · no live forecast':weather.status==='no-location'?'Choose a place for weather':weather.status==='loading'?'Checking forecast…':weather.status==='offline'?(weather.forecast?'Offline · saved forecast':'Offline · forecast unavailable'):weather.status==='stale'?'Forecast needs a refresh':'Weather unavailable';
const distance=(meters:number)=>`${(meters/1000).toLocaleString('en',{maximumFractionDigits:1})} km`;
function forecastText(weather:DayWeatherResult){const summary=weather.summary;return summary?`${summary.label}${summary.high!==null&&summary.low!==null?` · ${summary.high}° / ${summary.low}°`:''}${summary.probability!==null?` · ${summary.probability}% rain`:''}`:weatherStatusLabel(weather);}
export function WeatherSummary({weather}:{weather:DayWeatherResult}){
  const Icon=weather.rainVisits.length?CloudRain:CloudSun;
  return <details className="comfort-weather-details"><summary className={`comfort-chip ${weather.rainVisits.length?'comfort-chip-rain':''}`}><Icon size={14} aria-hidden="true"/><span>{forecastText(weather)}{weather.forecast&&['offline','stale'].includes(weather.status)?' · saved':''}</span><ChevronDown size={12} aria-hidden="true"/></summary><div className="comfort-weather-detail"><strong>Weather near your stops</strong>{weather.summary&&weather.locations.length===1&&<span>Near {weather.locations[0].label}</span>}{weather.locations.length>1&&weather.locations.map(location=>{const forecast=weather.forecasts[location.key],summary=forecast?summarizeWeather(forecast,weather.date,location.timezone):null;return <span key={location.key}>{location.label}: {summary?`${summary.label}${summary.high!==null?` · ${summary.high}°`:''}${summary.probability!==null?` · ${summary.probability}% rain`:''}`:'Forecast unavailable'}</span>;})}<p>{weather.status==='too-early'?'A useful forecast will appear when this day is within the next 10 days.':weather.status==='no-location'?'Add an exact location to one of your stops to see its forecast.':weather.status==='past'?'This day has passed. Historical weather is not shown.':'Forecasts can change. Conditions apply to the area around each place.'}</p>{weather.partial&&weather.locations.length>0&&<p>Some stops do not have a location or complete forecast yet.</p>}{weather.forecast&&<small>{['stale','offline'].includes(weather.status)?'Saved forecast · ':''}Checked {new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:weather.timezone}).format(weather.forecast.checkedAt)} · {weather.timezone}</small>}<div><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather by Open-Meteo</a>{['unavailable','stale','offline'].includes(weather.status)&&<button type="button" onClick={weather.retry}><RefreshCw size={13}/>Refresh</button>}</div></div></details>;
}
export interface DayComfortProps {
  assessment:PacingAssessment;weather:DayWeatherResult;readOnly?:boolean;online?:boolean;compact?:boolean;
  onPaceChange?:(pace:Pace)=>void;onIndoorIdeas?:()=>void;
  onPreview?:(kind:'meal'|'taxi'|'rain',activityId?:string)=>void;
  onDismiss?:(key:string)=>void;isDismissed?:(key:string)=>boolean;
}
export default function DayComfort({assessment,weather,readOnly=false,online=true,compact=false,onPaceChange,onIndoorIdeas,onPreview,onDismiss,isDismissed=()=>false}:DayComfortProps){
  const [sheetOpen,setSheetOpen]=useState(false);
  const dialogRef=useRef<HTMLDialogElement>(null),openerRef=useRef<HTMLButtonElement|null>(null),summaryRef=useRef<HTMLButtonElement>(null),sheetId=useId(),titleId=useId(),paceId=useId();
  const openSheet=(opener:HTMLButtonElement)=>{openerRef.current=opener;dialogRef.current?.showModal();setSheetOpen(true);};
  const closeSheet=()=>{dialogRef.current?.close();setSheetOpen(false);(openerRef.current?.isConnected?openerRef.current:summaryRef.current)?.focus({preventScroll:true});};
  const runAction=(action:()=>void)=>{closeSheet();action();};
  const {walking,gaps}=assessment,unknown=walking.unknownLegIds.length+walking.unknownVisitIds.length;
  const meals=assessment.meals.filter(meal=>meal.kind==='meal').map(meal=>`${meal.start%1440<960?'Lunch':'Dinner'} ${formatTime(meal.start)}`).join(' · ');
  const paceName=assessment.pace[0].toUpperCase()+assessment.pace.slice(1),walkKey=comfortNoticeKey(assessment,'taxi'),mealKey=comfortNoticeKey(assessment,'meal'),rainKey=weatherNoticeKey(weather);
  const notices=[];
  if(weather.rainVisits.length&&!isDismissed(rainKey))notices.push({key:rainKey,kind:'rain',title:`Rain may affect ${weather.rainVisits.length===1?weather.rainVisits[0].name:`${weather.rainVisits.length} outdoor visits`}`,body:`${weather.rainVisits.map(visit=>visit.name).join(', ')} ${weather.rainVisits.length===1?'overlaps':'overlap'} hours with at least a 50% chance of rain.`,action:'Show indoor ideas',dismiss:'Keep plan',run:onIndoorIdeas});
  if(walking.exceedsLimit&&!isDismissed(walkKey))notices.push({key:walkKey,kind:'taxi',title:`${unknown?'At least ':''}${distance(walking.knownMeters)} on foot`,body:`Your ${paceName.toLowerCase()} preference is ${distance(assessment.limitMeters)} a day. Review a shorter walk before changing the plan.`,action:'Review a driving option',dismiss:'Keep walking',run:!readOnly&&onPreview?()=>onPreview('taxi'):undefined});
  if(gaps.length&&!isDismissed(mealKey))notices.push({key:mealKey,kind:'meal',title:`A little room for ${gaps[0].window}`,body:`There is a gap of at least four hours without a planned meal around ${gaps[0].window}. Snacks do not count as a meal.`,action:'Find a meal stop',dismiss:'I’ve got it covered',run:!readOnly&&onPreview?()=>onPreview('meal'):undefined});
  const details=<>
    <div className="comfort-chips">
      <WeatherSummary weather={weather}/>
      <span className={`comfort-chip ${walking.exceedsLimit?'comfort-chip-warning':''}`} title={unknown?'Some walking distances still need confirmation.':'Known walking distances, including any labelled visit estimates.'}><Footprints size={14} aria-hidden="true"/>{unknown?'At least ':walking.estimatedVisitIds.length?'≈ ':''}{distance(walking.knownMeters)} on foot{walking.estimatedVisitIds.length>0?' · includes estimates':''}</span>
      <span className={`comfort-chip ${gaps.length?'comfort-chip-warning':''}`}><Utensils size={13} aria-hidden="true"/>{!assessment.timingComplete?'Meal timing to confirm':gaps.length?`${gaps[0].window==='lunch'?'Lunch':'Dinner'} to plan`:meals||'No long meal gaps'}</span>
    </div>
    {!online&&notices.length>0&&<p className="subtle-note">Connect to check route changes. Your saved Ideas are still available.</p>}
    {notices.map(notice=><article className={`comfort-notice comfort-notice-${notice.kind}`} key={notice.key}><strong>{notice.title}</strong><p>{notice.body}</p><div>{notice.run&&<button type="button" className="comfort-action" onClick={()=>runAction(notice.run!)}>{notice.action}</button>}{notice.kind==='rain'&&!readOnly&&onPreview&&<button type="button" className="comfort-action" onClick={()=>runAction(()=>onPreview('rain',weather.rainVisits[0]?.activityId))}>Review another day</button>}{onDismiss&&<button type="button" className="comfort-keep" onClick={()=>onDismiss(notice.key)}>{notice.dismiss}</button>}</div></article>)}
    <fieldset className="comfort-pace-choices" disabled={readOnly||!onPaceChange}><legend>Comfortable walking distance each day</legend>{(['relaxed','moderate','active'] as const).map((pace,index)=><label key={pace}><input type="radio" name={paceId} value={pace} checked={assessment.pace===pace} onChange={()=>onPaceChange?.(pace)}/>{pace[0].toUpperCase()+pace.slice(1)}<small>{[8,12,16][index]} km</small></label>)}<p>A planning preference, including walking at stops when known.</p></fieldset>
  </>;
  const Icon=weather.rainVisits.length?CloudRain:CloudSun;
  const weatherLabel=weather.summary?`${weather.summary.label}${weather.summary.high===null?'':` ${weather.summary.high}°`}${['offline','stale'].includes(weather.status)?' · saved':''}`:weatherStatusLabel(weather);
  const clearReminderLabel=assessment.timingComplete?'No reminders · View details':'Updating reminders…';
  const walkingLabel=`${unknown?'≥ ':walking.estimatedVisitIds.length?'≈ ':''}${distance(walking.knownMeters)}`;
  return <section className={`day-comfort day-comfort-summary${compact?' day-comfort-compact':''}`} aria-label="Pacing and weather">
    <button ref={summaryRef} type="button" className="comfort-summary" onClick={event=>openSheet(event.currentTarget)} aria-haspopup="dialog" aria-controls={sheetId} aria-expanded={sheetOpen} aria-label={`${weatherLabel}. ${unknown?'At least ':walking.estimatedVisitIds.length?'Approximately ':''}${distance(walking.knownMeters)} on foot. ${paceName} pace. Open weather and pacing details.`}>
      <Icon size={16} aria-hidden="true"/><span className="comfort-summary-weather">{weatherLabel}</span><span className="comfort-summary-divider" aria-hidden="true">·</span><span className="comfort-summary-walk"><Footprints size={14} aria-hidden="true"/>{walkingLabel}</span><span className="comfort-summary-divider" aria-hidden="true">·</span><span>{paceName}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>
    <button type="button" className={`comfort-summary-notice ${notices.length?(notices[0].kind==='rain'?'comfort-summary-notice-rain':''):'comfort-summary-notice-clear'}`} onClick={event=>openSheet(event.currentTarget)} aria-haspopup="dialog" aria-controls={sheetId} aria-expanded={sheetOpen} title={notices.length?notices.map(notice=>notice.title).join(' · '):clearReminderLabel}><Info size={15} aria-hidden="true"/><span>{notices.length?<><strong>{notices.length} {notices.length===1?'reminder':'reminders'} · </strong>{notices[0].title}</>:clearReminderLabel}</span><ChevronDown size={14} aria-hidden="true"/></button>
    <dialog ref={dialogRef} id={sheetId} className="comfort-sheet" aria-labelledby={titleId} onClose={()=>setSheetOpen(false)} onCancel={event=>{event.preventDefault();closeSheet();}} onClick={event=>{if(event.target!==event.currentTarget)return;const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeSheet();}}>
      <div className="comfort-sheet-header"><div><h2 id={titleId}>Weather & pace</h2><p>A little room for a comfortable day</p></div><button type="button" className="comfort-sheet-close" onClick={closeSheet} aria-label="Close weather and pacing details" autoFocus><X size={20} aria-hidden="true"/></button></div>
      <div className="comfort-sheet-body">{details}</div>
    </dialog>
  </section>;
}
export function todayWeatherTitle(weather:DayWeatherResult){
  if(weather.status!=='ready')return weatherStatusLabel(weather);
  const next=weather.visits.find(visit=>visit.startMs!==null&&visit.location),forecast=next?.location?weather.forecasts[next.location.key]:undefined;
  const hour=forecast?.hours.find(hour=>hour.time<=next!.startMs!&&hour.time+3600000>next!.startMs!);
  return hour?`${weatherDescription(hour.code)}${hour.temperature===null?'':` · ${Math.round(hour.temperature)}°`}${hour.rainProbability===null?'':` · ${hour.rainProbability}% rain`}`:'Forecast for your remaining stops unavailable';
}
export function TodayWeatherStrip({weather}:{weather:DayWeatherResult}){
  const first=weather.rainVisits[0],Icon=first?CloudRain:CloudSun;
  return <aside className={`today-weather-strip ${first?'is-rain':''}`} aria-label="Weather for the rest of your day"><Icon size={21} aria-hidden="true"/><div><strong>{todayWeatherTitle(weather)}</strong><p>{first?`${first.name} has an outdoor section during forecast rain. Keep a rain layer handy, or review indoor ideas in your plan.`:weather.forecast&&weather.status==='ready'?weather.visits.some(visit=>visit.exposure==='unknown')?'Check conditions before heading out. Some stops’ indoor or outdoor settings are unconfirmed.':'Keep an eye on conditions as your day unfolds.':weatherStatusLabel(weather)}</p>{weather.forecast&&<small>{weather.status==='offline'||weather.status==='stale'?'Saved · ':''}Near {weather.locations[0]?.label} · checked {new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:weather.timezone}).format(weather.forecast.checkedAt)} · <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></small>}</div></aside>;
}
