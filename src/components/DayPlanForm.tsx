import {useState, type FormEvent} from 'react';
import {Clock, MapPin, Flag, ArrowRight} from 'lucide-react';
import {formatTime, isTimezone, type Place} from '../model';

export interface DayPlanValues { timezone?:string; startTime: number; finishBy: number | null; startPlace: Place; endPlace: Place }
export default function DayPlanForm({value,onChange,onSave,onChooseStart,onChooseEnd,hotel,timezone}: {
  value:DayPlanValues; onChange:(value:DayPlanValues)=>void; onSave:()=>void;
  onChooseStart:()=>void; onChooseEnd:()=>void; hotel:Place; timezone:string;
}) {
  const [error,setError]=useState('');
  const parse=(time:string)=>{const [h,m]=time.split(':').map(Number);return h*60+m;};
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!Number.isInteger(value.startTime)||value.startTime<0||value.startTime>1439){setError('Choose a valid start time.');return;}
    if(value.finishBy!==null&&(!Number.isInteger(value.finishBy)||value.finishBy<=value.startTime||value.finishBy>1439)){setError('Choose a finish time after your start, or leave it blank.');return;}
    if(!isTimezone(value.timezone||timezone)){setError('Enter a valid time zone, such as Europe/Dublin.');return;}setError('');onSave();
  }
  return <form className="form-stack day-plan-form" onSubmit={submit}>
    <p className="muted">Start at the airport, finish at your stay—or head to your next destination. Set the places and times for this day.</p>
    <div className="day-plan-endpoints">
      {(['start','end'] as const).map(endpoint=>{
        const place=endpoint==='start'?value.startPlace:value.endPlace;
        return <div className="day-plan-location" key={endpoint}>
          <div className="day-plan-location-label">{endpoint==='start'?<MapPin size={16}/>:<Flag size={16}/>}<span>{endpoint==='start'?'Start from':'End at'}</span></div>
          <strong>{place.userLabel||place.name}</strong><p>{place.area||'Choose an exact location for journey estimates.'}</p>
          <div className="button-row"><button type="button" className="button small" onClick={endpoint==='start'?onChooseStart:onChooseEnd}>{endpoint==='start'?'Choose start':'Choose end'}</button>{place.id!=='hotel'&&<button type="button" className="text-button" onClick={()=>onChange({...value,[endpoint==='start'?'startPlace':'endPlace']:hotel})}>Use my stay</button>}</div>
        </div>;
      })}
    </div>
    <div className="form-row">
      <label>Start the day<input type="time" aria-label="Day start time" required value={formatTime(value.startTime)} onInput={e=>{if(e.currentTarget.value){onChange({...value,startTime:parse(e.currentTarget.value)});setError('');}}}/></label>
      <label>Prefer to finish by<input type="time" aria-label="Preferred finish time" value={value.finishBy===null?'':formatTime(value.finishBy)} onInput={e=>{onChange({...value,finishBy:e.currentTarget.value?parse(e.currentTarget.value):null});setError('');}}/></label>
    </div>
    <p className="subtle-note"><Clock size={14}/>The finish goal includes travel to your end point; it won’t cut visits short.</p>
    <label>Day time zone<input aria-label="Day time zone" value={value.timezone||timezone} onChange={e=>onChange({...value,timezone:e.target.value})} placeholder="Europe/Dublin"/></label>
    <p className="day-plan-airport-note">Add scheduled flights in Flights & stays. Changing a flight day’s start or end keeps the flight and adds a ground transfer. Flight cards show each airport’s local time; the timeline uses this day’s time zone.</p>
    <p className="subtle-note">Times are local to {(value.timezone||timezone).replaceAll('_',' ')}. This changes only the selected day.</p>
    {error&&<p className="day-plan-error" role="alert">{error}</p>}
    <button className="button primary full" type="submit">Save day plan<ArrowRight size={16}/></button>
  </form>;
}
