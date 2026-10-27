import {useEffect,useState} from 'react';
import {Compass,Coffee,ShoppingBag,Moon,ChevronDown,Clock,Minus,Plus,Trash2,Footprints} from 'lucide-react';
import {formatTime,formatDuration,type Activity,type Place,type Trip,type ScheduleRow} from '../model';
import {loadNearbyFreeIdeas,type NearbyFreeIdea} from '../freeTimeIdeas';
import './free-time.css';

export const FREE_TIME_LABELS={explore:'Explore the area',rest:'Rest or café',shopping:'Shopping',nothing:'Nothing planned'};
const icons={explore:Compass,rest:Coffee,shopping:ShoppingBag,nothing:Moon};
type FreeTime=NonNullable<Activity['freeTime']>;
export default function FreeTimeCard({row,onEdit}:{row:ScheduleRow;onEdit?:()=>void}){
  const block=row.freeTime;if(!block)return null;
  const Icon=icons[block.kind];
  const content=<><span className="free-time-icon"><Icon size={18}/></span><span className="free-time-summary"><strong>Free time · {FREE_TIME_LABELS[block.kind]}</strong><span><b>{block.approx?'≈ ':''}{formatTime(block.start)}–{formatTime(block.end)}</b> · {formatDuration(block.duration)}</span><span>near {row.pl.userLabel||row.pl.name}</span>{block.untilBooking&&block.bookingName&&<small>Until {block.bookingName}</small>}</span>{onEdit&&<ChevronDown size={16}/>}</>;
  return <article className={'free-time-card'+(block.warning?' has-warning':'')} data-free-time-id={block.id} aria-label={'Free time near '+(row.pl.userLabel||row.pl.name)}>
    {onEdit?<button className="free-time-open" onClick={onEdit} aria-label={'Edit free time near '+(row.pl.userLabel||row.pl.name)}>{content}</button>:<div className="free-time-open">{content}</div>}
    {block.warning&&<p className="free-time-warning"><Clock size={13}/>{block.warning}</p>}
  </article>;
}

export function FreeTimeEditor({row,trip,places,nextBooking,online,onSave,onRemove,onVisit,busy=false}:{
  row:ScheduleRow;trip:Trip;places:Record<string,Place>;nextBooking?:string;online:boolean;
  onSave:(value:FreeTime)=>Promise<void>;onRemove:()=>Promise<void>;onVisit:(place:Place)=>Promise<void>;busy?:boolean;
}){
  const value=row.it.freeTime!;
  const [draft,setDraft]=useState(value),[nearby,setNearby]=useState<NearbyFreeIdea[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const key=JSON.stringify([trip.id,trip.ideas,row.pl.id,Object.values(places).map(p=>[p.id,p.lat,p.lng]),online]);
  useEffect(()=>{let active=true;setNearby([]);setError('');
    if(!online)return;
    setLoading(true);void loadNearbyFreeIdeas(trip,row.pl,places,()=>active).then(result=>{if(active)setNearby(result);}).catch(()=>{if(active)setError('Walking times could not be checked. Your Ideas are still saved.');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[key]);
  const changed=JSON.stringify(draft)!==JSON.stringify(value);
  const run=async(work:()=>Promise<void>)=>{setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'This change could not be saved.');}};
  return <div className="free-time-editor">
    <p className="free-time-location">A little breathing room near <strong>{row.pl.userLabel||row.pl.name}</strong>. Your next journey starts here.</p>
    <fieldset disabled={busy}><legend>How would you like to spend it?</legend><div className="free-time-kinds">{(Object.keys(FREE_TIME_LABELS) as FreeTime['kind'][]).map(kind=>{const Icon=icons[kind];return <button type="button" key={kind} aria-pressed={draft.kind===kind} onClick={()=>setDraft({...draft,kind})}><Icon size={17}/>{FREE_TIME_LABELS[kind]}</button>;})}</div></fieldset>
    <div className="free-time-length"><span>Length</span><div className="stepper"><button aria-label="15 minutes less free time" disabled={busy||!draft.untilBooking&&draft.duration<=15} onClick={()=>setDraft({...draft,untilBooking:false,duration:Math.max(15,Math.min(720,Math.ceil((draft.untilBooking?row.freeTime?.duration??draft.duration:draft.duration)/15)*15-15))})}><Minus size={16}/></button><b>{draft.untilBooking?'Automatic':formatDuration(draft.duration)}</b><button aria-label="15 minutes more free time" disabled={busy||!draft.untilBooking&&draft.duration>=720} onClick={()=>setDraft({...draft,untilBooking:false,duration:Math.min(720,Math.max(15,Math.floor((draft.untilBooking?row.freeTime?.duration??draft.duration:draft.duration)/15)*15+15))})}><Plus size={16}/></button></div></div>
    <button className="free-time-until" aria-pressed={draft.untilBooking} disabled={busy||!nextBooking&&!draft.untilBooking} onClick={()=>setDraft({...draft,untilBooking:!draft.untilBooking})}><Clock size={16}/>{nextBooking?'Until '+nextBooking:'Until the next booking'}</button>
    <p className="free-time-hint">{draft.untilBooking?'Grows or shrinks around your remaining visits and travel to the booking.':nextBooking?'Choose “Until” to use the time available before your next booking.':'Add a fixed booking later in the day to use automatic free time.'}</p>
    {(draft.kind==='explore'||draft.kind==='shopping')&&<p className="free-time-hint"><Footprints size={14}/>Walking estimate: about 1.5 km per hour.</p>}
    <button className="button primary full" disabled={busy||!changed} onClick={()=>void run(()=>onSave(draft))}>{busy?'Saving…':'Save free time'}</button>
    {online&&trip.ideas.length>0&&<section className="free-time-nearby" aria-label="Nearby from your Ideas"><h3>Use this time for a visit</h3><p>From your saved Ideas. We’ll check the visit and onward journey before replacing this block.</p>{loading?<p role="status">Checking nearby walks…</p>:nearby.length?nearby.map(idea=><button className="button" key={idea.place.id} disabled={busy||changed} onClick={()=>void run(()=>onVisit(idea.place))}>Visit {idea.place.userLabel||idea.place.name}<span>{formatDuration(idea.minutes)} walk</span></button>):<p>No saved Ideas with a confirmed walk of 20 minutes or less.</p>}{changed&&<p>Save your settings first to check a nearby visit.</p>}</section>}
    {error&&<p className="notice warning" role="alert">{error}</p>}
    <button className="text-button danger" disabled={busy} onClick={()=>void run(onRemove)}><Trash2 size={15}/>Remove free time</button>
  </div>;
}
