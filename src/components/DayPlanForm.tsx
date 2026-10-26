import {useState, type FormEvent} from 'react';
import {Clock, MapPin, House, ArrowRight} from 'lucide-react';
import {formatTime, type Place} from '../model';

export interface DayPlanValues { startTime: number; finishBy: number | null; startPlace: Place }
export default function DayPlanForm({value,onChange,onSave,onChooseStart,hotel,timezone}: {
  value:DayPlanValues; onChange:(value:DayPlanValues)=>void; onSave:()=>void;
  onChooseStart:()=>void; hotel:Place; timezone:string;
}) {
  const [error,setError]=useState('');
  const parse=(time:string)=>{const [h,m]=time.split(':').map(Number);return h*60+m;};
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!Number.isInteger(value.startTime)||value.startTime<0||value.startTime>1439){setError('Choose a valid start time.');return;}
    if(value.finishBy!==null&&(!Number.isInteger(value.finishBy)||value.finishBy<=value.startTime||value.finishBy>1439)){setError('Choose a finish time after your start, or leave it blank.');return;}
    setError('');onSave();
  }
  return <form className="form-stack day-plan-form" onSubmit={submit}>
    <p className="muted">Set the pace for this day. Your visits and journeys will follow from here.</p>
    <div className="form-row">
      <label>Start the day<input type="time" aria-label="Day start time" required value={formatTime(value.startTime)} onInput={e=>{if(e.currentTarget.value){onChange({...value,startTime:parse(e.currentTarget.value)});setError('');}}}/></label>
      <label>Prefer to finish by<input type="time" aria-label="Preferred finish time" value={value.finishBy===null?'':formatTime(value.finishBy)} onInput={e=>{onChange({...value,finishBy:e.currentTarget.value?parse(e.currentTarget.value):null});setError('');}}/></label>
    </div>
    <p className="subtle-note"><Clock size={14}/>The finish time is a goal, so your visits won’t be cut short. Leave it blank for an open-ended day.</p>
    <div className="day-plan-location"><div className="day-plan-location-label"><MapPin size={16}/><span>Start from</span></div><strong>{value.startPlace.name}</strong><p>{value.startPlace.area||'Choose an exact location for journey estimates.'}</p><div className="button-row"><button type="button" className="button small" onClick={onChooseStart}>Choose a place</button>{value.startPlace.id!=='hotel'&&<button type="button" className="text-button" onClick={()=>onChange({...value,startPlace:hotel})}>Use my stay</button>}</div></div>
    <div className="day-plan-return"><House size={16}/><span>Return to <strong>{hotel.name}</strong></span></div>
    <p className="subtle-note">Times are local to {timezone.replaceAll('_',' ')}. This changes only the selected day.</p>
    {error&&<p className="day-plan-error" role="alert">{error}</p>}
    <button className="button primary full" type="submit">Save day plan<ArrowRight size={16}/></button>
  </form>;
}
