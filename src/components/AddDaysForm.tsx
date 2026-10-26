import {useState, type FormEvent} from 'react';
import {ArrowRight, CalendarPlus} from 'lucide-react';
import {MAX_TRIP_DAYS, type Trip} from '../model';
import {tripDayDate} from '../useLiveRoutes';

export default function AddDaysForm({trip,onAdd}:{trip:Trip;onAdd:(count:number)=>void}){
  const [count,setCount]=useState('1'),[error,setError]=useState('');
  const remaining=MAX_TRIP_DAYS-trip.days.length;
  const amount=Number(count);
  const valid=Number.isInteger(amount)&&amount>0&&amount<=remaining;
  const dateLabel=(index:number)=>new Date(tripDayDate(trip.startDate,index)+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  function submit(event:FormEvent){event.preventDefault();if(!valid){setError(`Choose between 1 and ${remaining} days.`);return;}try{onAdd(amount);}catch(e){setError(e instanceof Error?e.message:'These days could not be added.');}}
  return <form className="form-stack add-days-form" onSubmit={submit}>
    <p className="muted">A little more time to explore. New days will follow Day {trip.days.length}, with room to plan from scratch.</p>
    <label>Days to add<input type="number" min="1" max={remaining} step="1" value={count} autoFocus required onChange={e=>{setCount(e.target.value);setError('');}}/></label>
    {valid&&<div className="add-days-preview" aria-live="polite"><CalendarPlus size={23}/><div><strong>Day {trip.days.length+1}{amount>1?` – Day ${trip.days.length+amount}`:''}</strong><p>{dateLabel(trip.days.length)}{amount>1?` – ${dateLabel(trip.days.length+amount-1)}`:''}</p><small>{trip.days.length+amount} days in your trip</small></div></div>}
    {error&&<p className="day-plan-error" role="alert">{error}</p>}
    <p className="subtle-note">Your trip’s end date updates automatically. You can undo this change.</p>
    <button className="button primary full" type="submit">Add {valid?amount:''} {amount===1?'day':'days'}<ArrowRight size={16}/></button>
  </form>;
}
