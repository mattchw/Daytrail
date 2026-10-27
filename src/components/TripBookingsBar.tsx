import {useId, useState} from 'react';
import {ArrowRight, BedDouble, ChevronDown, ChevronRight, ChevronUp, Moon, PlaneLanding, PlaneTakeoff, Plus, Settings2} from 'lucide-react';
import type {Place, Trip} from '../model';
import {tripBookingSummary} from '../bookings/journey';
import type {FlightSegment} from '../bookings/types';
import './trip-bookings.css';

export type BookingEntry = {kind:'flight'|'stay';manage?:boolean;intent?:'arrival'|'departure';flightId?:string;stayId?:string;date?:string};
const shortDate=(date:string)=>new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
const name=(places:Record<string,Place>,id:string)=>places[id]?.userLabel||places[id]?.name||'Location to confirm';

/** Trip-level bookings stay reachable without taking space from the day's stops. */
export default function TripBookingsBar({trip,places,onOpen,onManage}:{trip:Trip;places:Record<string,Place>;onOpen?:(entry:BookingEntry)=>void;onManage?:()=>void}){
  const contentId=useId(),[expanded,setExpanded]=useState(true);
  const summary=tripBookingSummary(trip),otherFlights=(trip.flights??[]).filter(f=>!summary.arrivals.some(a=>a.id===f.id)&&!summary.departures.some(d=>d.id===f.id)),stays=[...(trip.stays??[])].sort((a,b)=>a.checkInDate.localeCompare(b.checkInDate));
  const flightCount=trip.flights?.length??0;
  const bookingCounts=`${flightCount} ${flightCount===1?'flight':'flights'} · ${stays.length} ${stays.length===1?'stay':'stays'}`;
  const nightAttention=[summary.missingNights?`${summary.missingNights} ${summary.missingNights===1?'night':'nights'} to plan`:'',summary.overlappingNights?`${summary.overlappingNights} overlapping ${summary.overlappingNights===1?'night':'nights'}`:''].filter(Boolean).join(' · ');
  function flightChip(intent:'arrival'|'departure',flights:FlightSegment[],flight:FlightSegment|null){
    const label=intent==='arrival'?'Arrival flight':'Departure flight',Icon=intent==='arrival'?PlaneLanding:PlaneTakeoff;
    const moment=flight?.[intent==='arrival'?'arrival':'departure'];
    const title=flight?`${flight.flightNumber||label} · ${moment?.time||'Time to confirm'}`:flights.length?`${flights.length} ${intent} flights`:`Add ${intent} flight`;
    const content=<><Icon size={18} aria-hidden="true"/><span><small>{label}</small><strong>{title}</strong>{flight&&<em>{name(places,intent==='arrival'?flight.toPlaceId:flight.fromPlaceId)} · {shortDate(moment!.date)}</em>}</span>{onOpen&&(flights.length?<ChevronRight size={14}/>:<Plus size={15}/>)}</>;
    return onOpen?<button className={`trip-booking-chip ${flights.length?'is-flight':'is-missing'}`} onClick={()=>flights.length>1?onManage?.():onOpen({kind:'flight',intent,flightId:flight?.id})}>{content}</button>:<div className={`trip-booking-chip ${flights.length?'is-flight':'is-missing'}`}>{flights.length?content:<><Icon size={18}/><span><small>{label}</small><strong>No flight added</strong></span></>}</div>;
  }
  return <section className={`trip-bookings-bar ${expanded?'is-expanded':'is-collapsed'}`} aria-label="Trip bookings">
    <div className="trip-bookings-heading"><div className="trip-bookings-title"><BedDouble size={16} aria-hidden="true"/><h2>Bookings</h2></div>{!expanded&&<div className="trip-bookings-summary"><span>{bookingCounts}</span>{summary.totalNights>0&&<span className={nightAttention?'needs-attention':''}>{summary.bookedNights}/{summary.totalNights} nights covered</span>}{nightAttention&&<span className="trip-bookings-summary-note">{nightAttention}</span>}</div>}</div>
    <div className="trip-bookings-scroll" id={contentId} hidden={!expanded}>
    {flightChip('arrival',summary.arrivals,summary.arrival)}<ArrowRight className="trip-bookings-arrow" size={15} aria-hidden="true"/>
    {stays.map(stay=>{const nights=Math.round((Date.parse(stay.checkOutDate)-Date.parse(stay.checkInDate))/86400000);const content=<><BedDouble size={18}/><span><small>{shortDate(stay.checkInDate)} – {shortDate(stay.checkOutDate)} · {nights} {nights===1?'night':'nights'}</small><strong>{name(places,stay.placeId)}</strong></span>{onOpen&&<ChevronRight size={14}/>}</>;return onOpen?<button key={stay.id} className="trip-booking-chip is-stay" onClick={()=>onOpen({kind:'stay',stayId:stay.id})}>{content}</button>:<div key={stay.id} className="trip-booking-chip is-stay">{content}</div>;})}
    {!stays.length&&(onOpen?<button className="trip-booking-chip is-missing" onClick={()=>onOpen({kind:'stay'})}><BedDouble size={18}/><span><small>A place to unwind</small><strong>Add a stay</strong></span><Plus size={15}/></button>:<div className="trip-booking-chip is-missing"><BedDouble size={18}/><strong>No stay added</strong></div>)}
    {stays.length>0&&onOpen&&<button className="trip-booking-add-stay" aria-label="Add another stay" title="Add another stay" onClick={()=>onOpen({kind:'stay'})}><Plus size={16}/></button>}
    <ArrowRight className="trip-bookings-arrow" size={15} aria-hidden="true"/>{flightChip('departure',summary.departures,summary.departure)}
    {otherFlights.length>0&&(onManage?<button className="trip-booking-chip is-stay" onClick={onManage}><PlaneTakeoff size={17}/><span><small>Along the way</small><strong>{otherFlights.length} other {otherFlights.length===1?'flight':'flights'}</strong></span></button>:<div className="trip-booking-chip is-stay"><PlaneTakeoff size={17}/><span><small>Along the way</small><strong>{otherFlights.length} other {otherFlights.length===1?'flight':'flights'}</strong></span></div>)}
    {summary.totalNights>0&&<div className={`trip-nights ${summary.missingNights||summary.overlappingNights?'needs-attention':''}`}><Moon size={15}/><span><strong>{summary.bookedNights}/{summary.totalNights} nights covered</strong>{summary.overlappingNights>0?<small>{summary.overlappingNights} overlapping {summary.overlappingNights===1?'night':'nights'}</small>:summary.missingNights>0?<small>{summary.missingNights} {summary.missingNights===1?'night':'nights'} to plan</small>:<small>Somewhere to rest each night</small>}</span>{onOpen&&summary.missingNights>0&&<button onClick={()=>onOpen({kind:'stay',date:summary.nights.find(n=>n.status==='missing')?.date})}>Add stay</button>}{onManage&&summary.overlappingNights>0&&<button onClick={onManage}>Review</button>}</div>}
    </div><div className="trip-bookings-controls">{onManage&&<button type="button" className="trip-bookings-manage" onClick={onManage} aria-label="Manage all flights and stays" title="Manage all flights and stays"><Settings2 size={16} aria-hidden="true"/></button>}<button type="button" className="trip-bookings-toggle" aria-expanded={expanded} aria-controls={contentId} aria-label={expanded?'Collapse bookings':'Expand bookings'} onClick={()=>setExpanded(value=>!value)}>{expanded?<ChevronUp size={17} aria-hidden="true"/>:<ChevronDown size={17} aria-hidden="true"/>}<span>{expanded?'Collapse':'Expand'}</span></button></div>
  </section>;
}
