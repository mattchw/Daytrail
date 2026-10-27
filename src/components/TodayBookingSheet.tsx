import {useEffect,useId,useRef,useState} from 'react';
import {ArrowRight,Check,ClipboardList,Clock,Copy,MapPin,Navigation,X} from 'lucide-react';
import {formatTime,type Activity,type Place} from '../model';
import {travelDateLabel,travelDirectionsURL,travelPlaceName} from '../travel/model';

export interface TodayBookingSheetProps {
  activity:Activity|null;
  place?:Place;
  date:string|null;
  timezone:string;
  onClose:()=>void;
  onEditPlan?:()=>void;
}
/** Show only the selected activity's saved details, without inventing a reservation. */
export default function TodayBookingSheet({activity,place,date,timezone,onClose,onEditPlan}:TodayBookingSheetProps){
  const id=useId(),dialog=useRef<HTMLDialogElement>(null);
  const [copied,setCopied]=useState(false),[copyError,setCopyError]=useState('');
  useEffect(()=>{
    setCopied(false);setCopyError('');
    const element=dialog.current;
    if(activity&&element&&!element.open)element.showModal();
    else if(!activity&&element?.open)element.close();
  },[activity?.aid]);
  if(!activity)return null;
  function close(){dialog.current?.close();onClose();}
  const name=travelPlaceName(place),href=travelDirectionsURL(place,activity.mode==='flight'?'transit':activity.mode);
  const address=place?.offlineDetails?.address?.trim()||place?.area?.trim(),localAddress=place?.offlineDetails?.localAddress?.trim(),note=activity.note.trim();
  const addresses=[...new Set([address,localAddress].filter((value):value is string=>!!value))];
  async function copyAddress(){
    if(!addresses.length)return;
    try{await navigator.clipboard.writeText([name,...addresses].join('\n'));setCopied(true);setCopyError('');}
    catch{setCopyError('Copying is unavailable. Select the saved address below to copy it.');}
  }
  return <dialog ref={dialog} className="dt-today-fixes dt-today-booking-sheet" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget)close();}}>
    <div className="dt-today-sheet-handle"/>
    <header><h2 id={`${id}-title`}>Your booking</h2><button className="dt-travel-icon" aria-label="Close booking details" onClick={close}><X size={18} aria-hidden="true"/></button></header>
    <section className="dt-today-booking-summary"><span><ClipboardList size={15} aria-hidden="true"/>Activity booking</span><h3>{name}</h3><p><Clock size={15} aria-hidden="true"/>{travelDateLabel(date)} · {activity.fixed===null?'Time to confirm':formatTime(activity.fixed)}</p><small>{timezone.replaceAll('_',' ')} time</small></section>
    <section className="dt-today-booking-note"><h3>Booking details &amp; reference</h3>{note?<p>{note}</p>:<p className="is-empty">Add your confirmation details in the planner.</p>}</section>
    <section className="dt-today-booking-address"><h3><MapPin size={16} aria-hidden="true"/>Address for your driver</h3>{addresses.length?<>{addresses.map((value,index)=><p key={index} lang={value===localAddress?'und':undefined}>{value}</p>)}<button className="dt-travel-link" onClick={()=>void copyAddress()}>{copied?<Check size={15} aria-hidden="true"/>:<Copy size={15} aria-hidden="true"/>}{copied?'Address copied':'Copy address'}</button></>:<p className="is-empty">No address saved yet. Choose the place’s exact location in the planner.</p>}{copyError&&<p role="alert" className="dt-today-copy-error">{copyError}</p>}</section>
    {href&&<a className="dt-travel-button is-primary" href={href} target="_blank" rel="noopener noreferrer"><Navigation size={16} aria-hidden="true"/>Directions<span className="dt-travel-sr"> to {name} in Google Maps, opens another app or tab</span></a>}
    {onEditPlan&&<button className="dt-travel-link" onClick={()=>{close();onEditPlan();}}>Open day planner<ArrowRight size={14} aria-hidden="true"/></button>}
    <p className="dt-travel-sr" role="status" aria-live="polite">{copied?'Address copied.':''}</p>
  </dialog>;
}
