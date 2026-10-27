import {AlertTriangle, BedDouble, Luggage, PlaneLanding, PlaneTakeoff, Plus} from 'lucide-react';
import {bookingDayDate, dayMinutesAt, dayStartTime, dayTimezone, flightTiming, formatDuration, formatTime, type Place, type Trip} from '../model';
import {appliedFlightBoundaries} from '../bookings/journey';
import type {BookingEntry} from './TripBookingsBar';
import './trip-bookings.css';

export default function BookingDayBoundary({trip,dayIndex,places,position,finish,uncertain,onEdit,onBagStop}:{trip:Trip;dayIndex:number;places:Record<string,Place>;position:'start'|'end';finish:number;uncertain:boolean;onEdit?:(entry:BookingEntry)=>void;onBagStop?:(stayId:string,purpose:'drop'|'collect')=>void}){
  const day=trip.days[dayIndex],date=bookingDayDate(trip,dayIndex),boundary=appliedFlightBoundaries(trip,day.id);
  const flight=position==='start'?boundary.arrival:boundary.departure;
  const startStay=trip.stays?.find(stay=>stay.id===day.startStayId);
  const endStay=trip.stays?.find(stay=>stay.id===day.endStayId);
  const stay=position==='start'?startStay:endStay;
  const stayName=(id:string)=>places[id]?.userLabel||places[id]?.name||'Your stay';
  const timing=flight?flightTiming(flight):null;
  const goal=timing?.departureGoalMs!=null?Math.round(dayMinutesAt(timing.departureGoalMs,date,dayTimezone(trip,day))):null;
  const late=position==='end'&&goal!==null&&finish>goal;
  const beforeReady=position==='start'&&timing?.arrivalReadyMs!=null&&dayStartTime(day)<dayMinutesAt(timing.arrivalReadyMs,date,dayTimezone(trip,day));
  const bagStay=position==='start'&&boundary.arrival?endStay:position==='end'&&boundary.departure?startStay:undefined;
  const bagAlready=bagStay&&(position==='start'?day.items[0]?.placeId:day.items.at(-1)?.placeId)===bagStay.placeId;
  return <>
    {(position==='start'?boundary.ambiguousArrival:boundary.ambiguousDeparture)&&<section className="booking-day-boundary is-warning"><AlertTriangle size={18}/><div><strong>Choose which flight sets this day’s timing</strong><p>More than one booking matches this airport. Review the flight before planning the transfer.</p>{onEdit&&<button className="text-button" onClick={()=>onEdit({kind:'flight',manage:true})}>Review flights</button>}</div></section>}
    {flight&&<section className={`booking-day-boundary is-flight ${late||beforeReady?'is-warning':''}`} aria-label={position==='start'?'Arrival flight timing':'Departure flight timing'}>{late||beforeReady?<AlertTriangle size={18}/>:position==='start'?<PlaneLanding size={18}/>:<PlaneTakeoff size={18}/>}<div><small>{position==='start'?'Your arrival':'Your flight home'}{flight.flightNumber?` · ${flight.flightNumber}`:''}</small><strong>{position==='start'?`Land ${flight.arrival.time||'at a time to confirm'} · ${stayName(flight.toPlaceId)}`:`At ${stayName(flight.fromPlaceId)} by ${goal===null?'a time to confirm':formatTime(goal)}`}</strong>
    <p>{position==='start'?`Allow ${formatDuration(flight.arrivalBufferMinutes??60)} for immigration and bags. ${beforeReady?'Your day starts before you are ready to leave the airport.':`Your day starts at ${formatTime(dayStartTime(day))}.`}`:`Flight departs ${flight.departure.time||'at a time to confirm'} · ${formatDuration(flight.airportBufferMinutes??120)} airport buffer.`}</p>
    {position==='end'&&<p>{late?`Flight conflict: ${uncertain?'with incomplete transfer estimates, your plan is at least':'your plan reaches the airport'} ${formatDuration(finish-goal!)} ${uncertain?'late':'after the arrival goal'}. Shorten a visit or move a stop to Ideas.`:uncertain?'Complete the transfer estimates before relying on this timing.':goal!==null?`${formatDuration(Math.max(0,goal-finish))} to spare before your airport arrival goal.`:'Confirm the departure time to check your day.'}</p>}
    {onEdit&&<button className="text-button" onClick={()=>onEdit({kind:'flight',intent:position==='start'?'arrival':'departure',flightId:flight.id})}>Edit flight & buffer</button>}</div></section>}
    {stay&&(position==='end'||stay.checkOutDate===date)&&<section className="booking-day-boundary" aria-label={position==='start'?'Check-out reminder':'Check-in reminder'}><BedDouble size={18}/><div><small>{position==='start'?'Before you head out':stay.checkInDate===date?'Your stay tonight':'Back to your stay'}</small><strong>{position==='start'?`Check out${stay.checkOutTime?` by ${stay.checkOutTime}`:''}`:stay.checkInDate===date?`Check in${stay.checkInTime?` from ${stay.checkInTime}`:''}`:stayName(stay.placeId)}</strong><p>{position==='start'||stay.checkInDate===date?stayName(stay.placeId):'A place to rest after the day.'}{!((position==='start'?stay.checkOutTime:stay.checkInTime))?' · Confirm the time with your accommodation.':''}</p>{onEdit&&<button className="text-button" onClick={()=>onEdit({kind:'stay',stayId:stay.id})}>Edit stay</button>}</div></section>}
    {bagStay&&!bagAlready&&onBagStop&&<section className="booking-day-boundary"><Luggage size={18}/><div><strong>{position==='start'?'Want to drop your bags first?':'Need to collect your bags?'}</strong><p>{stayName(bagStay.placeId)} · Check luggage storage with your accommodation.</p><button className="text-button" onClick={()=>onBagStop(bagStay.id,position==='start'?'drop':'collect')}><Plus size={13}/>{position==='start'?'Add bag-drop stop':'Add bag-collection stop'}</button></div></section>}
  </>;
}
