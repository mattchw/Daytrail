import {useState, type FormEvent} from 'react';
import {BedDouble, Check, ChevronDown, Clock, Flag, MapPin, PlaneLanding, PlaneTakeoff, Search} from 'lucide-react';
import {dayEndPlace, dayHasFlight, dayStartPlace, dayStartTime, dayTimezone, formatTime, isTimezone, type Place, type Trip} from '../model';
import {appliedFlightBoundaries} from '../bookings/journey';
import {listEndpointChoices, type DayEndpointChoice, type EndpointSide} from '../bookings/endpoints';
import './day-endpoints.css';

export interface EndpointDraft {
  dayId:string; endpoint:EndpointSide; choice:DayEndpointChoice; place:Place;
  startTime:number; finishBy:number|null; timezone:string;
}
export function createEndpointDraft(trip:Trip, dayIndex:number, endpoint:EndpointSide, places:Record<string,Place>):EndpointDraft {
  const day=trip.days[dayIndex],boundaries=appliedFlightBoundaries(trip,day.id);
  const place=endpoint==='start'?dayStartPlace(day,places):dayEndPlace(day,places);
  const flight=endpoint==='start'?boundaries.arrival:boundaries.departure;
  const matchingStays=listEndpointChoices(trip,day.id,endpoint).filter(option=>option.kind==='stay'&&option.placeId===place.id);
  const stayId=(endpoint==='start'?day.startStayId:day.endStayId)||(matchingStays.length===1?matchingStays[0].id:undefined);
  const choice:DayEndpointChoice=flight?{kind:'flight',id:flight.id}:stayId?{kind:'stay',id:stayId}:{kind:'place',placeId:place.id};
  return {dayId:day.id,endpoint,choice,place,startTime:dayStartTime(day),finishBy:day.finishBy??null,timezone:dayTimezone(trip,day)};
}
const choiceKey=(choice:DayEndpointChoice)=>choice.kind+':'+(choice.kind==='place'?choice.placeId:choice.id);
const placeName=(place:Place|undefined)=>place?.userLabel||place?.name||'Location to confirm';

/** One endpoint at a time, with the trip's existing bookings as the first choices. */
export default function DayEndpointPicker({trip,places,value,onChange,onSearch,onSave}:{trip:Trip;places:Record<string,Place>;value:EndpointDraft;onChange:(value:EndpointDraft)=>void;onSearch:()=>void;onSave:()=>Promise<boolean>}) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const isStart=value.endpoint==='start',day=trip.days.find(day=>day.id===value.dayId);
  const options=listEndpointChoices(trip,value.dayId,value.endpoint).filter(option=>option.kind!=='flight'||!day||!dayHasFlight(day)),selected=options.find(option=>choiceKey(option.choice)===choiceKey(value.choice));
  const currentPlace=day?(isStart?dayStartPlace(day,places):dayEndPlace(day,places)):value.place;
  const manualPlace=value.choice.kind==='place'?value.place:currentPlace;
  const showManual=value.choice.kind==='place'||!options.some(option=>option.placeId===currentPlace.id);
  const flight=value.choice.kind==='flight'?trip.flights?.find(flight=>flight.id===(value.choice as {kind:'flight';id:string}).id):undefined;
  const change=(next:EndpointDraft)=>{setError('');onChange(next);};
  function choose(choice:DayEndpointChoice,place:Place){
    // A flight deadline belongs to its airport, not to a newly selected hotel.
    const oldFlight=value.endpoint==='end'?appliedFlightBoundaries(trip,value.dayId).departure:null;
    const oldGoal=options.find(option=>option.kind==='flight'&&option.id===oldFlight?.id)?.time;
    change({...value,choice,place,finishBy:!isStart&&oldGoal!=null&&value.finishBy===oldGoal&&choice.kind!=='flight'?null:value.finishBy});
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(busy)return;
    if(!day){setError('This day has changed. Close this window and choose it again.');return;}
    if(value.choice.kind!=='flight'){
      if(!isTimezone(value.timezone)){setError('Enter a valid time zone, such as Europe/Dublin.');return;}
      if(isStart&&(!Number.isInteger(value.startTime)||value.startTime<0||value.startTime>1439)){setError('Choose a valid start time.');return;}
      if(value.finishBy!==null&&value.finishBy<=(isStart?value.startTime:dayStartTime(day))){setError('The finish time must be after the start.');return;}
    }else if(!selected||selected.disabled){setError(selected?.issue||'This flight no longer matches this day.');return;}
    setBusy(true);try{if(!await onSave())setError('This change could not be saved. Check the message below and try again.');}finally{setBusy(false);}
  }
  const parse=(time:string)=>{const [h,m]=time.split(':').map(Number);return h*60+m;};
  return <form className="endpoint-picker form-stack" onSubmit={submit}>
    <p className="muted">{isStart?'Where will you head out from?':'Where will you finish the day?'} Choose from your bookings or find another place.</p>
    <fieldset className="endpoint-choices"><legend>From your bookings</legend>
      {options.length?options.map(option=>{
        const bookedFlight=option.kind==='flight'?trip.flights?.find(flight=>flight.id===option.id):null;
        const stay=option.kind==='stay'?trip.stays?.find(stay=>stay.id===option.id):null;
        const Icon=option.kind==='stay'?BedDouble:isStart?PlaneLanding:PlaneTakeoff;
        return <label key={choiceKey(option.choice)} className={`endpoint-choice ${option.disabled?'is-disabled':''}`}>
          <input type="radio" name="endpoint-place" checked={choiceKey(value.choice)===choiceKey(option.choice)} disabled={option.disabled||busy} onChange={()=>choose(option.choice,places[option.placeId]||value.place)}/><Icon size={19} aria-hidden="true"/>
          <span><strong>{placeName(places[option.placeId])}</strong><small>{bookedFlight?`${bookedFlight.flightNumber||'Flight'} · ${isStart?'Arrival':'Departure'} ${bookedFlight[isStart?'arrival':'departure'].time||'time to confirm'}`:isStart?`Your stay · ${stay?.checkOutDate===option.date?'Check out'+(stay?.checkOutTime?' by '+stay.checkOutTime:''):'Previous night'}`:`Your stay tonight${stay?.checkInDate===option.date&&stay.checkInTime?' · Check in from '+stay.checkInTime:''}`}</small>{option.issue&&<em>{option.issue}</em>}</span>
        </label>;
      }):<p className="endpoint-empty">No bookings match this {isStart?'morning':'evening'} yet. You can add flights and stays in the Bookings bar.</p>}
    </fieldset>
    {showManual&&<label className="endpoint-choice"><input type="radio" name="endpoint-place" checked={value.choice.kind==='place'} disabled={busy} onChange={()=>choose({kind:'place',placeId:manualPlace.id},manualPlace)}/><MapPin size={18}/><span><strong>{placeName(manualPlace)}</strong><small>{manualPlace.id===currentPlace.id?'Current place':'Selected place'}</small></span></label>}
    <button type="button" className="button endpoint-search" disabled={busy} onClick={onSearch}><Search size={16}/>Search another place</button>
    {flight&&selected?<div className="endpoint-flight-time"><Clock size={17}/><div><strong>{isStart?'Ready to leave the airport':'Be at the airport'}{selected.time!==null?' at '+formatTime(selected.time):''}</strong><p>{isStart?`Includes ${flight.arrivalBufferMinutes??60} min for immigration and bags.`:`Includes ${flight.airportBufferMinutes??120} min before departure.`} Edit the flight in Bookings to change this.</p><small>{selected.timezone.replaceAll('_',' ')}</small></div></div>:<>
      <label>{isStart?'Start time':'Prefer to finish by (optional)'}<input type="time" aria-label={isStart?'Day start time':'Preferred finish time'} required={isStart} disabled={busy} value={isStart?formatTime(value.startTime):value.finishBy===null?'':formatTime(value.finishBy)} onInput={e=>change({...value,...(isStart?{startTime:e.currentTarget.value?parse(e.currentTarget.value):NaN}:{finishBy:e.currentTarget.value?parse(e.currentTarget.value):null})})}/></label>
      <details className="endpoint-settings"><summary>Time zone <span>{value.timezone.replaceAll('_',' ')}</span></summary><label>Day time zone<input value={value.timezone} disabled={busy} onChange={e=>change({...value,timezone:e.target.value})} placeholder="Europe/Dublin"/></label><p className="subtle-note">Applies to the timeline for this day. Flights keep each airport’s local time.</p></details>
    </>}
    <p className="subtle-note">Only {day?.label||'this day'}’s {isStart?'start':'end'} will change. Your stops stay in place.</p>
    {error&&<p className="day-plan-error" role="alert">{error}</p>}
    <button type="submit" className="button primary full" disabled={busy||!!selected?.disabled}>{busy?'Saving…':isStart?'Save start':'Save end'}<Check size={16}/></button>
  </form>;
}

export function DayEndpointRow({endpoint,place,detail,onChange}:{endpoint:EndpointSide;place:Place;detail:string;onChange?:()=>void}){
  const Icon=endpoint==='start'?MapPin:Flag;
  return <div className={`day-endpoint-row ${endpoint==='start'?'base-marker':'return-marker'}`}><span className="day-endpoint-icon"><Icon size={16}/></span><div><small>{endpoint==='start'?'Start from':'End at'}</small><strong>{placeName(place)}</strong><p>{detail}</p></div>{onChange&&<button className="button" aria-label={endpoint==='start'?'Choose day start':'Choose day end'} onClick={onChange}>Change<ChevronDown size={13}/></button>}</div>;
}
