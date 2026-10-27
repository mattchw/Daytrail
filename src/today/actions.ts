import {targetState,travelTargets,type TravelMark} from '../travel/model';
import {bookingDayDate,dayMinutesAt,dayTimezone,instantAtDayMinutes,localDateAt,type Trip} from '../model';
import {openingWaitMinutes} from '../visitHours';
import {initialTodayRuntime,runtimeMatches,todayPlanSignature,todayStateSignature,type TodayFix,type TodayOptions,type TodayProjection,type TodayRuntime} from './model';

export interface TodayActionResult {runtime:TodayRuntime;mark?:{targetId:string;previous:TravelMark;expected:TravelMark};previous:TodayRuntime|null;signature:string}
export function planTodayAction(options:Pick<TodayOptions,'trip'|'dayIndex'|'places'|'marks'|'runtime'|'now'|'hoursByPlace'>,projection:TodayProjection,kind:'leave'|'arrive'|'extend',minutes=15):TodayActionResult {
  const signature=todayPlanSignature(options.trip,options.dayIndex),now=options.now;
  if(!projection.canAct)throw new Error('Open the current trip day to record live progress.');
  if(projection.signature!==signature)throw new Error('The itinerary changed. Review the updated day before continuing.');
  if(projection.stateSignature!==todayStateSignature(options))throw new Error('Your progress changed. Review the current stop before continuing.');
  const existing=options.runtime??null,prior=existing&&runtimeMatches(existing,options)?existing:initialTodayRuntime({...options,runtime:null});
  let runtime:TodayRuntime,mark:TodayActionResult['mark'];
  if(kind==='extend'){
    if(projection.phase!=='visit'||!projection.current||projection.current.target.kind==='free'||!Number.isInteger(minutes)||minutes<1||minutes>120)throw new Error('Record your arrival at a stop before extending the visit.');
    runtime={...prior,leaveAt:Math.max(now,projection.leaveAt??now)+minutes*60000,updatedAt:now};
  }else if(kind==='arrive'){
    const next=projection.next;if(!next||projection.phase==='visit')throw new Error('Choose the next journey before recording an arrival.');
    if(next.target.kind==='free'){
      runtime={...prior,phase:'visit',targetId:next.target.id,placeId:next.target.placeId,since:now,leaveAt:now+(next.freeMinutes??next.target.freeTime?.duration??0)*60000,updatedAt:now,originArrivedAt:now};
    }else if(next.target.kind==='activity'){
      const fixed=next.target.activity?.fixed,day=options.trip.days[options.dayIndex];
      let start=fixed===null||fixed===undefined?now:Math.max(now,instantAtDayMinutes(bookingDayDate(options.trip,options.dayIndex),fixed,dayTimezone(options.trip,day))??now);
      if(fixed===null&&options.hoursByPlace){
        let zone=dayTimezone(options.trip,day);for(const target of travelTargets(day,options.trip)){if(target.id===next.target.id)break;if(target.flight)zone=target.flight.arrival.timezone;}
        const date=localDateAt(now,zone),minute=Math.round(dayMinutesAt(now,date,zone));
        start+=openingWaitMinutes(options.hoursByPlace[next.target.placeId],{date,start:minute,end:minute+(next.target.activity?.duration??0)})*60000;
      }
      runtime={...prior,phase:'visit',targetId:next.target.id,placeId:next.target.placeId,since:now,leaveAt:start+(next.target.activity?.duration??0)*60000,updatedAt:now,originArrivedAt:now};
    }
    else{
      mark={targetId:next.target.id,previous:targetState(options.marks,next.target.id),expected:'done'};
      runtime={...prior,phase:'start',targetId:null,placeId:next.target.placeId,since:now,leaveAt:next.target.flight?now+(next.target.flight.arrivalBufferMinutes??60)*60000:null,updatedAt:now,originArrivedAt:now};
    }
  }else{
    if(projection.phase==='travel'||projection.phase==='complete')throw new Error('This journey has already started.');
    if(projection.current)mark={targetId:projection.current.target.id,previous:targetState(options.marks,projection.current.target.id),expected:'done'};
    const next=projection.next;
    const beforeNext=next?projection.rows.slice(0,projection.rows.indexOf(next)):projection.rows;
    const bypassedFreeIds=[...new Set([...(prior.bypassedFreeIds??[]),...beforeNext.filter(row=>row.target.kind==='free'&&row!==projection.current&&row.mark==='planned'&&row.freeMinutes===0).map(row=>row.target.id)])];
    runtime={...prior,phase:next?.target.kind==='free'?'visit':next?'travel':'complete',targetId:next?.target.id??null,placeId:projection.current?.target.placeId??prior.placeId,since:now,leaveAt:next?.target.kind==='free'?now+(next.freeMinutes??0)*60000:null,updatedAt:now,originArrivedAt:projection.current?.arrival??prior.originArrivedAt??prior.since,...(bypassedFreeIds.length?{bypassedFreeIds}:{})};
  }
  return {runtime,mark,previous:existing,signature};
}

/** Apply a reviewed structural change; the caller owns the normal itinerary Undo transaction. */
export function applyTodayFix(trip:Trip,dayIndex:number,fix:TodayFix):void {
  if(todayPlanSignature(trip,dayIndex)!==fix.signature)throw new Error('The itinerary changed. Open Fix it again to review fresh options.');
  const day=trip.days[dayIndex],action=fix.action;
  if(!day)throw new Error('This trip day is no longer available.');
  if(action.kind==='leave-now')throw new Error('Leaving now is a personal progress action, not an itinerary edit.');
  const activityId=action.kind==='drive'?action.targetId.startsWith('activity:')?action.targetId.slice(9):null:action.activityId;
  const activity=activityId?day.items.find(item=>item.aid===activityId):undefined;
  if(action.kind==='drive'){
    if(action.targetId===`end:${day.id}`){if(day.endMode==='flight'||day.endFlightId)throw new Error('A flight cannot be changed by a driving suggestion.');day.endMode='drive';return;}
    if(!activity||activity.mode==='flight'||activity.flightId)throw new Error('This journey changed. Review the day before changing transport.');
    activity.mode='drive';return;
  }
  if(!activity||activity.fixed!==null||activity.mode==='flight'||activity.flightId||activity.departureForFlightId)throw new Error('Pinned bookings and flights cannot be shortened or skipped here.');
  if(action.kind==='shorten'){
    if(!Number.isInteger(action.duration)||action.duration<15||action.duration>=activity.duration)throw new Error('Choose a shorter valid visit duration.');
    activity.duration=action.duration;
  }else{
    if(activity.placeId!==action.placeId)throw new Error('This stop changed. Review the updated day.');
    day.items=day.items.filter(item=>item.aid!==activity.aid);
    if(!trip.ideas.includes(activity.placeId))trip.ideas.push(activity.placeId);
  }
}
