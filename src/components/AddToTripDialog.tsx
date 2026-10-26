import {useId, useState, type FormEvent} from 'react';
import {ArrowRight, CalendarDays, MapPin, Plus} from 'lucide-react';
import type {Day, Place} from '../model';
import './planner-add.css';

export type AddToTripDialogProps = {
  place: Place;
  days: Day[];
  places: Record<string, Place>;
  initialDayIndex: number;
  onDayChange?: (dayIndex: number) => void;
  loading?: boolean;
  /** Move indices refer to the destination list after removing this activity. */
  excludeActivityId?: string;
  mode?: 'add' | 'move';
  onAdd: (dayIndex: number, index: number) => void;
  onCancel?: () => void;
};

/** Form content for the app's shared Modal, with no nested dialog. */
export default function AddToTripDialog({place, days, places, initialDayIndex, onDayChange, loading=false, excludeActivityId, mode='add', onAdd, onCancel}: AddToTripDialogProps) {
  const id=useId();
  const [dayIndex,setDayIndex]=useState(()=>Math.max(0,Math.min(initialDayIndex,days.length-1)));
  const [position,setPosition]=useState('end');
  const safeDayIndex=Math.max(0,Math.min(dayIndex,days.length-1));
  const day=days[safeDayIndex];
  const items=day?.items.filter(item=>item.aid!==excludeActivityId)??[];
  const afterIndex=items.findIndex(item=>`after:${item.aid}`===position);
  const index=position==='start'?0:afterIndex>=0?afterIndex+1:items.length;
  const before=items[index-1],after=items[index];
  const nameOf=(placeId:string)=>places[placeId]?.name||'Saved place';
  const verb=mode==='move'?'Move':'Add';
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(day&&!loading)onAdd(safeDayIndex,index);
  }
  return <form className="planner-add" onSubmit={submit}>
    <div className="planner-add-place"><span className="planner-add-place-icon"><MapPin size={19}/></span><div><span>{mode==='move'?'A different spot in your plans':'Make room for a favourite'}</span><strong>{place.name}</strong>{place.area&&<p>{place.area}</p>}</div></div>
    <div className="planner-add-fields">
      <label htmlFor={`${id}-day`}>Choose a day<select id={`${id}-day`} value={safeDayIndex} disabled={!days.length} onChange={event=>{const next=Number(event.target.value);setDayIndex(next);setPosition('end');onDayChange?.(next);}}>{days.map((candidate,candidateIndex)=><option key={candidate.id} value={candidateIndex}>{candidate.label} · {candidate.date}</option>)}</select></label>
      <label htmlFor={`${id}-position`}>Position in the day<select id={`${id}-position`} value={position} disabled={!day||loading} onChange={event=>setPosition(event.target.value)}><option value="end">End of day</option><option value="start">Start of day</option>{items.map(item=><option key={item.aid} value={`after:${item.aid}`}>After {nameOf(item.placeId)}</option>)}</select></label>
    </div>
    {day?<section className="planner-add-preview" aria-label="Selected day preview" aria-live="polite">
      <div className="planner-add-day"><CalendarDays size={16}/><div><strong>{day.label} · {day.date}</strong><span>{day.title}</span></div><small>{items.length} {items.length===1?'stop':'stops'}</small></div>
      {loading?<p className="planner-add-loading" role="status">Loading this day’s places…</p>:<ol className="planner-add-sequence">
        <li className="planner-add-neighbour"><span className="planner-add-dot"/><span>{before?nameOf(before.placeId):'Start of day'}</span></li>
        <li className="planner-add-insert"><span className="planner-add-dot"><Plus size={11}/></span><span><strong>{place.name}</strong><small>Stop {index+1} of {items.length+1}</small></span></li>
        <li className="planner-add-neighbour"><span className="planner-add-dot"/><span>{after?nameOf(after.placeId):'End of day'}</span></li>
      </ol>}
    </section>:<p className="planner-add-empty">Create a day in your trip to add this place.</p>}
    <div className="planner-add-actions">{onCancel&&<button type="button" className="button" onClick={onCancel}>Cancel</button>}<button type="submit" className="button primary" disabled={!day||loading}>{verb} to {day?.label||'trip'}<ArrowRight size={15}/></button></div>
  </form>;
}
