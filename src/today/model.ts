import {bookingDayDate, dayMinutesAt, dayStartTime, dayTimezone, flightTiming, instantAtDayMinutes, localDateAt, type Journey, type Mode, type Place, type Trip, type schedule} from '../model';
import {targetState, travelPlaceName, travelTargets, tripLocalDate, type TravelMarks, type TravelTarget} from '../travel/model';
import type {OpeningInfo} from '../openingHours';
import {checkVisitHours,openingWaitMinutes,type VisitHoursCheck} from '../visitHours';

export type TodayPhase = 'start' | 'travel' | 'visit' | 'complete';
/** Actual progress belongs to this device; it never rewrites the planned itinerary. */
export interface TodayRuntime {
  schema: 1; tripId: string; dayId: string; date: string; timezone: string;
  phase: TodayPhase; targetId: string | null; placeId: string;
  since: number; leaveAt: number | null; updatedAt: number; originArrivedAt?:number; bypassedFreeIds?:string[];
}
export interface TodayRow {
  target: TravelTarget; place: Place; name: string; mark: 'planned'|'done'|'skipped'; mode: Mode; leg: Journey;
  arrival: number|null; start: number|null; end: number|null; plannedStart: number|null;
  delayMinutes: number|null; approx: boolean; lateMinutes: number; waitMinutes: number; hours?:VisitHoursCheck; freeMinutes?:number; freeTotalMinutes?:number; plannedFreeMinutes?:number; freeDeltaMinutes?:number; freeBookingName?:string; freeWarning?:string;
}
export interface TodayBooking {targetId:string;name:string;time:number;slackMinutes:number|null;lateMinutes:number|null;freeMinutes?:number}
export interface TodayProblem {targetId:string;name:string;label:string;severity:'red'|'amber'}
export interface TodayProjection {
  date:string; timezone:string; now:number; nowMinute:number; isToday:boolean; canAct:boolean;
  phase:TodayPhase; current:TodayRow|null; next:TodayRow|null; rows:TodayRow[];
  leaveAt:number|null; leaveInMinutes:number|null; finish:number|null;
  booking:TodayBooking|null;problem:TodayProblem|null;unknown:number;stale:boolean;originPlaceId:string;signature:string;stateSignature:string;
}
/** Only routes verified for these exact endpoints may be reused after skipping a stop. */
export type TodayRoutes = Readonly<Record<string,Journey>>;
export interface TodayOptions {
  trip:Trip;dayIndex:number;places:Record<string,Place>;schedule:ReturnType<typeof schedule>;
  marks:TravelMarks;now:number;runtime?:TodayRuntime|null;verifiedRoutes?:TodayRoutes;hoursByPlace?:Record<string,OpeningInfo|undefined>;
}
export type TodayFixAction = {kind:'leave-now'}|{kind:'shorten';activityId:string;duration:number}|{kind:'skip';activityId:string;placeId:string}|{kind:'drive';targetId:string};
export interface TodayFix {id:string;label:string;detail:string;outcome:string;savedMinutes:number|null;resolves:boolean;action:TodayFixAction;signature:string;stateSignature:string}

export const todayRouteKey = (from:string,to:string,mode:Mode) => JSON.stringify([from,to,mode]);
export function todayPlanSignature(trip:Trip,dayIndex:number):string {
  return JSON.stringify([trip.id,trip.startDate,trip.timezone,trip.days[dayIndex],trip.flights ?? []]);
}
export function todayStateSignature(options:Pick<TodayOptions,'trip'|'dayIndex'|'marks'|'runtime'>):string {
  return JSON.stringify([options.runtime??null,todayTargets(options.trip,options.dayIndex).map(target=>[target.id,targetState(options.marks,target.id)])]);
}
export function todayTime(timestamp:number|null,timezone:string,baseDate?:string):string {
  if(timestamp===null||!Number.isFinite(timestamp))return 'Time to confirm';
  try{const clock=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:timezone}).format(timestamp);const date=localDateAt(timestamp,timezone),offset=baseDate?Math.round((Date.parse(`${date}T00:00:00Z`)-Date.parse(`${baseDate}T00:00:00Z`))/86400000):0;return clock+(offset>0?` +${offset}d`:offset<0?` ${offset}d`:'');}catch{return 'Time to confirm';}
}
const known = (leg:Journey|undefined):leg is Journey & {min:number} => Boolean(leg&&leg.status!=='loading'&&leg.status!=='unavailable'&&leg.min!==null&&Number.isFinite(leg.min)&&leg.min>=0);
const unknownLeg = (mode:Mode):Journey => ({mode,min:null,km:'—',status:'unavailable',reason:'Recalculate this journey to confirm the arrival time.'});
const add = (time:number|null,minutes:number) => time===null?null:time+minutes*60000;
export const freeTimeName=(kind:string)=>({explore:'Time to explore',rest:'Rest or café',shopping:'Time for shopping',nothing:'Nothing planned'}[kind]??'Free time');
const effectiveState=(options:Pick<TodayOptions,'marks'|'runtime'>,target:TravelTarget)=>target.kind==='free'&&(options.runtime?.bypassedFreeIds?.includes(target.id)||target.anchorTargetId&&targetState(options.marks,target.anchorTargetId)==='skipped')?'skipped':targetState(options.marks,target.id);

/** A completed prior-day plan may include an overnight flight and its hotel transfer.
 * That flight remains in Bookings/its own day's progress; it is not today's first journey.
 */
export function todayTargets(trip:Trip,dayIndex:number):TravelTarget[]{
  const day=trip.days[dayIndex],previous=trip.days[dayIndex-1],targets=travelTargets(day,trip);
  if(!previous)return targets;
  return targets.filter(target=>{
    if(!target.flight||day.endFlightId===target.flight.id||day.items.some(item=>item.flightId===target.flight!.id))return true;
    const start=day.startPlaceId??'hotel',flight=target.flight;
    if(start===flight.toPlaceId||(previous.endPlaceId??'hotel')!==start||previous.endMode==='flight')return true;
    const position=previous.items.findIndex(item=>item.flightId===flight.id&&item.mode==='flight');
    if(position<0||previous.items.slice(position+1).some(item=>item.mode==='flight'))return true;
    const ready=flightTiming(flight).arrivalReadyMs,startAt=instantAtDayMinutes(bookingDayDate(trip,dayIndex),dayStartTime(day),dayTimezone(trip,day));
    return ready===null||startAt===null||startAt<ready;
  });
}

export function initialTodayRuntime(options:Pick<TodayOptions,'trip'|'dayIndex'|'places'|'marks'|'now'|'runtime'>):TodayRuntime {
  const {trip,dayIndex,marks,now}=options,day=trip.days[dayIndex],targets=todayTargets(trip,dayIndex);
  let placeId=day.startPlaceId??'hotel',leaveAt:number|null=null;
  for(const target of targets){if(effectiveState(options,target)==='planned')break;if(targetState(marks,target.id)==='done'){placeId=target.placeId;leaveAt=target.flight?flightTiming(target.flight).arrivalReadyMs:null;}}
  return {schema:1,tripId:trip.id,dayId:day.id,date:bookingDayDate(trip,dayIndex),timezone:dayTimezone(trip,day),
    phase:targets.every(target=>effectiveState(options,target)!=='planned')?'complete':'start',targetId:null,placeId,since:now,leaveAt:leaveAt===null?null:Math.max(now,leaveAt),updatedAt:now};
}
export function runtimeMatches(runtime:TodayRuntime,options:Pick<TodayOptions,'trip'|'dayIndex'|'places'|'marks'>):boolean {
  const day=options.trip.days[options.dayIndex];
  if(!day||runtime.tripId!==options.trip.id||runtime.dayId!==day.id||runtime.date!==bookingDayDate(options.trip,options.dayIndex)||runtime.timezone!==dayTimezone(options.trip,day)||!options.places[runtime.placeId])return false;
  if(runtime.phase==='visit'||runtime.phase==='travel'){
    const target=todayTargets(options.trip,options.dayIndex).find(target=>effectiveState({...options,runtime},target)==='planned');
    if(target?.id!==runtime.targetId)return false;
    return Boolean(target&&targetState(options.marks,target.id)==='planned'&&(runtime.phase!=='visit'||(target.kind==='activity'||target.kind==='free')&&target.placeId===runtime.placeId));
  }
  if(runtime.phase==='complete'&&todayTargets(options.trip,options.dayIndex).some(target=>effectiveState({...options,runtime},target)==='planned'))return false;
  const expected=initialTodayRuntime({...options,runtime,now:runtime.since});
  if(runtime.placeId!==expected.placeId||runtime.phase==='start'&&runtime.leaveAt!==null&&expected.leaveAt===null)return false;
  return runtime.targetId===null;
}

/** Reflow only remaining visits. The clock changes estimates, never completion marks. */
function projectToday(options:TodayOptions,freeDurations:Readonly<Record<string,number>>={}):TodayProjection {
  const {trip,dayIndex,places,marks,now}=options,day=trip.days[dayIndex],date=bookingDayDate(trip,dayIndex),timezone=dayTimezone(trip,day);
  const targets=todayTargets(trip,dayIndex),valid=options.runtime&&runtimeMatches(options.runtime,options),runtime=valid?options.runtime!:initialTodayRuntime(options);
  const stale=Boolean(options.runtime&&!valid),isToday=tripLocalDate(timezone,now)===date;
  // A user-started overnight session stays actionable through its scheduled end, never for a later trip date.
  const plannedEnd=instantAtDayMinutes(date,options.schedule.finish,timezone),overnight=Boolean(valid&&runtime.phase!=='complete'&&now>=runtime.since&&now-runtime.since<36*3600000&&plannedEnd!==null&&now<=plannedEnd+6*3600000);
  const canAct=isToday||overnight,active=targets.filter(target=>effectiveState(options,target)==='planned');
  let phase=active.length?runtime.phase:'complete';
  if(phase==='complete'&&active.length)phase='start';
  const currentTarget=phase==='visit'?active.find(target=>target.id===runtime.targetId)??null:null;
  const activeTarget=phase==='travel'?active.find(target=>target.id===runtime.targetId)??null:currentTarget;
  const firstIndex=activeTarget?targets.findIndex(target=>target.id===activeTarget.id):targets.findIndex(target=>effectiveState(options,target)==='planned');
  let origin=runtime.placeId;
  const plannedStart=instantAtDayMinutes(date,dayStartTime(day),timezone);
  let cursor:number|null=canAct?Math.max(now,plannedStart??now,runtime.phase==='start'?runtime.leaveAt??now:now):plannedStart;
  let uncertain=false,unknown=0,booking:TodayBooking|null=null,leaveAt:number|null=null,placeZone=timezone,previousArrival:number|null=runtime.originArrivedAt??cursor;
  const rows:TodayRow[]=[];
  const originalFrom=(target:TravelTarget):string=>{
    if(target.kind==='flight')return target.flight!.fromPlaceId;
    if(target.kind==='end')return day.items.at(-1)?.placeId??day.startPlaceId??'hotel';
    const index=day.items.findIndex(item=>item.aid===target.activity!.aid);
    return index>0?day.items[index-1].placeId:day.startPlaceId??'hotel';
  };
  const originalLeg=(target:TravelTarget):Journey|undefined=>target.kind==='end'?options.schedule.endLeg:target.kind==='activity'?options.schedule.rows.find(row=>row.it.aid===target.activity!.aid)?.leg:undefined;
  for(const [index,target]of targets.entries()){
    const mark=effectiveState(options,target),place=places[target.placeId];if(!place)continue;
    const base=target.kind==='activity'||target.kind==='free'?options.schedule.rows.find(row=>row.it.aid===(target.activity?.aid??target.anchorActivityId)):undefined;
    const planned=target.kind==='flight'?flightTiming(target.flight!).arrivalMs:instantAtDayMinutes(date,target.kind==='end'?options.schedule.finish:target.kind==='free'?base?.freeTime?.start??base?.physicalEnd??dayStartTime(day):base?.start??dayStartTime(day),timezone);
    const row:TodayRow={target,place,name:travelPlaceName(place),mark,mode:target.mode,leg:originalLeg(target)??unknownLeg(target.mode),arrival:null,start:null,end:null,plannedStart:planned,delayMinutes:null,approx:false,lateMinutes:0,waitMinutes:0};
    rows.push(row);
    if(target.kind==='flight'&&mark==='done')placeZone=target.flight!.arrival.timezone;
    if(mark!=='planned'||index<firstIndex)continue;
    const isCurrent=target.id===currentTarget?.id,isTravelling=phase==='travel'&&target.id===activeTarget?.id;
    if(target.kind==='free'&&target.freeTime){
      const free=target.freeTime,plannedFree=base?.freeTime;
      row.name=freeTimeName(free.kind);row.leg={mode:'walk',min:0,km:'0',status:'ready'};
      const duration=freeDurations[target.id]??free.duration;
      row.arrival=isCurrent?runtime.since:cursor;row.start=row.arrival;
      row.freeMinutes=duration;row.plannedFreeMinutes=plannedFree?.duration??free.duration;
      row.freeBookingName=plannedFree?.bookingName;
      row.end=isCurrent&&!free.untilBooking?runtime.leaveAt??add(runtime.since,free.duration):add(isCurrent?Math.max(now,runtime.since):cursor,duration);
      if(isCurrent){leaveAt=row.end;row.end=Math.max(now,row.end??now);}
      row.freeTotalMinutes=row.end!==null&&row.start!==null?Math.round((row.end-row.start)/60000):duration;row.freeDeltaMinutes=row.freeTotalMinutes-row.plannedFreeMinutes;
      row.approx=uncertain||row.start===null;row.freeWarning=row.approx?'Confirm the next journey before relying on this free time.':free.untilBooking&&duration<10?'Less than 10 min of free time left.':undefined;
      row.delayMinutes=row.start===null||planned===null?null:Math.round((row.start-planned)/60000);
      cursor=row.end;origin=target.placeId;continue;
    }
    if(isCurrent){
      row.arrival=runtime.since;row.start=runtime.since;
      const fixed=target.activity?.fixed===null||target.activity?.fixed===undefined?null:instantAtDayMinutes(date,target.activity.fixed,timezone);
      if(fixed!==null){row.start=Math.max(row.start,fixed);row.lateMinutes=Math.max(0,(runtime.since-fixed)/60000);}
      else if(options.hoursByPlace&&target.activity){const localDate=localDateAt(row.start,placeZone),start=Math.round(dayMinutesAt(row.start,localDate,placeZone));row.start+=openingWaitMinutes(options.hoursByPlace[target.placeId],{date:localDate,start,end:start+target.activity.duration})*60000;}
      row.waitMinutes=(row.start-row.arrival)/60000;
      leaveAt=runtime.leaveAt??add(runtime.since,target.activity?.duration??0);
      row.end=Math.max(now,leaveAt??now);cursor=row.end;previousArrival=runtime.since;origin=target.placeId;
      if(options.hoursByPlace&&target.activity){const localDate=localDateAt(row.start,placeZone);row.hours=checkVisitHours(options.hoursByPlace[target.placeId],{date:localDate,start:Math.round(dayMinutesAt(row.start,localDate,placeZone)),end:Math.round(dayMinutesAt(row.end,localDate,placeZone)),allowWait:false});}
      row.delayMinutes=planned===null?null:Math.round((row.start-planned)/60000);continue;
    }
    if(target.kind==='flight'){
      const timing=flightTiming(target.flight!);
      row.leg={mode:'flight',min:timing.durationMinutes,km:'—',status:timing.status==='ready'?'ready':'unavailable'};
      const departureReady=isTravelling?runtime.since:cursor,airportReady=isTravelling?runtime.originArrivedAt??runtime.since:previousArrival;
      const late=airportReady===null||timing.departureGoalMs===null?null:Math.max(0,(airportReady-timing.departureGoalMs)/60000,departureReady===null||timing.departureMs===null?0:(departureReady-timing.departureMs)/60000);
      row.lateMinutes=late??0;
      if(!booking&&timing.departureGoalMs!==null)booking={targetId:target.id,name:target.flight!.flightNumber||'Your flight',time:timing.departureGoalMs,slackMinutes:airportReady===null?null:Math.round(Math.min((timing.departureGoalMs-airportReady)/60000,departureReady===null||timing.departureMs===null?Infinity:(timing.departureMs-departureReady)/60000)),lateMinutes:late};
      const missed=departureReady!==null&&timing.departureMs!==null&&departureReady>timing.departureMs;
      row.arrival=timing.arrivalMs;row.start=timing.arrivalMs;row.end=timing.arrivalReadyMs;
      row.approx=uncertain||timing.status!=='ready'||missed||origin!==target.flight!.fromPlaceId;
      if(row.approx){uncertain=true;unknown++;cursor=null;}else cursor=row.end;
      origin=target.placeId;previousArrival=row.approx?null:row.end;placeZone=target.flight!.arrival.timezone;continue;
    }
    const baseline=originalLeg(target),baselineStart=target.kind==='end'?instantAtDayMinutes(date,options.schedule.rows.at(-1)?.freeTime?.end??options.schedule.rows.at(-1)?.physicalEnd??dayStartTime(day),timezone):base?instantAtDayMinutes(date,base.arrive-(baseline?.min??0),timezone):null;
    const actualDeparture=isTravelling?runtime.since:cursor;
    const reuseBaseline=origin===originalFrom(target)&&(target.mode!=='transit'||!canAct||actualDeparture!==null&&baselineStart!==null&&Math.abs(actualDeparture-baselineStart)<60000);
    const source=origin===target.placeId?{mode:target.mode,min:0,km:'0',status:'ready' as const}:options.verifiedRoutes?.[todayRouteKey(origin,target.placeId,target.mode)]??(reuseBaseline?baseline:undefined);
    row.leg=source&&source.mode===target.mode?source:unknownLeg(target.mode);
    if(!known(row.leg)){unknown++;uncertain=true;row.leg={...row.leg,min:null};}
    row.arrival=known(row.leg)?add(isTravelling?runtime.since:cursor,row.leg.min):null;
    if(isTravelling&&row.arrival!==null)row.arrival=Math.max(now,row.arrival);
    const fixed=target.activity?.fixed===null||target.activity?.fixed===undefined?null:instantAtDayMinutes(date,target.activity.fixed,timezone);
    row.start=row.arrival===null?null:Math.max(row.arrival,fixed??row.arrival);
    row.waitMinutes=row.arrival===null||fixed===null?0:Math.max(0,(fixed-row.arrival)/60000);
    row.lateMinutes=row.arrival===null||fixed===null?0:Math.max(0,(row.arrival-fixed)/60000);
    if(fixed===null&&row.start!==null&&target.activity&&options.hoursByPlace){
      const localDate=localDateAt(row.start,placeZone),localStart=dayMinutesAt(row.start,localDate,placeZone);
      const openingWait=openingWaitMinutes(options.hoursByPlace[target.placeId],{date:localDate,start:Math.round(localStart),end:Math.round(localStart+target.activity.duration),approx:uncertain});
      row.start+=openingWait*60000;row.waitMinutes+=openingWait;
    }
    if(!booking&&fixed!==null)booking={targetId:target.id,name:row.name,time:fixed,slackMinutes:row.arrival===null?null:Math.round((fixed-row.arrival)/60000),lateMinutes:row.arrival===null?null:row.lateMinutes};
    row.end=add(row.start,target.activity?.duration??0);row.approx=uncertain;
    if(options.hoursByPlace&&target.activity&&row.start!==null&&row.end!==null){const localDate=localDateAt(row.start,placeZone);row.hours=checkVisitHours(options.hoursByPlace[target.placeId],{date:localDate,start:Math.round(dayMinutesAt(row.start,localDate,placeZone)),end:Math.round(dayMinutesAt(row.end,localDate,placeZone)),approx:uncertain,allowWait:false});}
    row.delayMinutes=row.start===null||planned===null?null:Math.round((row.start-planned)/60000);
    cursor=row.end;previousArrival=row.arrival;origin=target.placeId;
  }
  const current=rows.find(row=>row.target.id===currentTarget?.id)??null;
  const remaining=rows.filter(row=>row.mark==='planned'&&row!==current&&!(row.target.kind==='free'&&row.freeMinutes===0));
  const next=phase==='travel'?remaining.find(row=>row.target.id===runtime.targetId)??remaining[0]??null:remaining[0]??null;
  const problemRow=rows.find(row=>row.mark==='planned'&&row.hours?.status==='closed')??rows.find(row=>row.mark==='planned'&&row.hours?.status==='short');
  const problem:TodayProblem|null=problemRow?{targetId:problemRow.target.id,name:problemRow.name,label:problemRow.hours!.label,severity:problemRow.hours!.status==='closed'?'red':'amber'}:null;
  if(phase==='start'&&runtime.leaveAt!==null&&runtime.leaveAt>now)leaveAt=runtime.leaveAt;
  if(booking){const bookingIndex=rows.findIndex(row=>row.target.id===booking!.targetId);const free=rows.slice(0,bookingIndex).filter(row=>row.target.kind==='free'&&row.mark==='planned'&&row.freeMinutes!==undefined&&!row.approx);if(free.length)booking.freeMinutes=free.reduce((sum,row)=>sum+row.freeMinutes!,0);}
  return {date,timezone,now,nowMinute:dayMinutesAt(now,date,timezone),isToday,canAct,phase,current,next,rows,leaveAt,leaveInMinutes:leaveAt===null?null:Math.ceil((leaveAt-now)/60000),finish:phase==='complete'?null:cursor,booking,problem,unknown,stale,originPlaceId:runtime.placeId,signature:todayPlanSignature(trip,dayIndex),stateSignature:todayStateSignature(options)};
}

/** Use free time as slack before the next booking, without inventing a journey.
 * Each candidate is reflowed through opening waits and fixed starts. */
export function buildTodayProjection(input:TodayOptions):TodayProjection {
  const invalid=Boolean(input.runtime&&!runtimeMatches(input.runtime,input));
  const options=invalid?{...input,runtime:null}:input;
  const durations:Record<string,number>={},targets=todayTargets(options.trip,options.dayIndex);
  const adjustable=targets.filter(target=>target.freeTime?.untilBooking&&effectiveState(options,target)==='planned');
  for(const target of targets){if(!target.freeTime)continue;
    const current=options.runtime?.phase==='visit'&&options.runtime.targetId===target.id;
    durations[target.id]=target.freeTime.untilBooking?0:current?Math.max(0,Math.ceil(((options.runtime!.leaveAt??options.now)-options.now)/60000)):target.freeTime.duration;
  }
  let result=projectToday(options,durations);
  for(const target of adjustable){
    const index=result.rows.findIndex(row=>row.target.id===target.id),row=result.rows[index];
    if(!row||row.mark!=='planned')continue;
    const bookingRow=result.rows.slice(index+1).find(row=>row.mark==='planned'&&(row.target.kind==='flight'||row.target.activity?.fixed!=null));
    const goal=bookingRow?.target.flight?flightTiming(bookingRow.target.flight).departureGoalMs:bookingRow?.target.activity?.fixed!=null?instantAtDayMinutes(result.date,bookingRow.target.activity.fixed,result.timezone):null;
    if(!bookingRow||goal===null||row.start===null||bookingRow.approx||bookingRow.arrival===null){
      durations[target.id]=options.runtime?.phase==='visit'&&options.runtime.targetId===target.id?Math.max(0,Math.ceil(((options.runtime.leaveAt??options.now)-options.now)/60000)):target.freeTime!.duration;result=projectToday(options,durations);const unchecked=result.rows.find(row=>row.target.id===target.id);if(unchecked&&bookingRow&&(bookingRow.approx||bookingRow.arrival===null)){unchecked.approx=true;unchecked.freeWarning='Confirm the next journey before relying on this free time.';}continue;
    }
    const originalProblems=new Map(result.rows.filter(row=>row.hours?.status==='closed'||row.hours?.status==='short').map(row=>[row.target.id,row.hours!.status]));
    const safe=(projection:TodayProjection)=>{const booking=projection.rows.find(row=>row.target.id===bookingRow.target.id)!;
      const arrival=booking.target.kind==='flight'?projection.rows[projection.rows.indexOf(booking)-1]?.end:booking.arrival;
      return arrival!==null&&arrival!==undefined&&arrival<=goal&&!projection.rows.slice(index+1,projection.rows.indexOf(booking)+1).some(row=>row.approx||row.hours&&(row.hours.status==='closed'||row.hours.status==='short')&&(!originalProblems.has(row.target.id)||row.hours.status==='closed'&&originalProblems.get(row.target.id)==='short'));
    };
    let low=0,high=720;
    while(low<high){const candidate=Math.ceil((low+high)/2);durations[target.id]=candidate;const tested=projectToday(options,durations);if(safe(tested))low=candidate;else high=candidate-1;}
    durations[target.id]=low;result=projectToday(options,durations);
    const allocated=result.rows.find(row=>row.target.id===target.id)!;allocated.freeBookingName=bookingRow.target.flight?.flightNumber||bookingRow.name;
  }
  if(invalid){result.stale=true;result.stateSignature=todayStateSignature(input);}
  return result;
}

function outcome(projection:TodayProjection):string {
  if(projection.problem?.severity==='red')return `${projection.problem.name}: ${projection.problem.label}`;
  const booking=projection.booking;
  if(booking){if(booking.slackMinutes===null)return `Arrival at ${booking.name} needs a route estimate`;return booking.slackMinutes>=0?booking.freeMinutes!==undefined?`On time for ${booking.name} · ${booking.freeMinutes} min of free time left`:`${booking.slackMinutes} min spare before ${booking.name}`:`${Math.abs(booking.slackMinutes)} min late for ${booking.name}`;}
  return projection.finish===null?'Arrival time needs a route estimate':`Finish around ${todayTime(projection.finish,projection.timezone,projection.date)}`;
}
/** Every option is a preview, including honest unknown results after an unverified shortcut. */
export function buildTodayFixes(options:TodayOptions):TodayFix[] {
  const projection=buildTodayProjection(options);if(!projection.canAct||projection.phase==='complete')return [];
  const fixes:TodayFix[]=[],signature=todayPlanSignature(options.trip,options.dayIndex);
  const append=(id:string,label:string,detail:string,action:TodayFixAction,nextOptions:TodayOptions)=>{
    const next=buildTodayProjection(nextOptions),before=projection.booking?.slackMinutes,after=next.booking?.slackMinutes;
    const savedMinutes=before!==null&&before!==undefined&&after!==null&&after!==undefined?after+(next.booking?.freeMinutes??0)-before-(projection.booking?.freeMinutes??0):projection.finish!==null&&next.finish!==null?Math.round((projection.finish-next.finish)/60000):null;
    fixes.push({id,label,detail,action,signature,stateSignature:projection.stateSignature,outcome:outcome(next),savedMinutes,resolves:next.unknown===0&&(!next.booking||next.booking.slackMinutes!==null&&next.booking.slackMinutes>=0)&&!next.rows.some(row=>row.mark==='planned'&&(row.hours?.status==='closed'||row.lateMinutes>0))});
  };
  if(projection.current&&options.runtime){
    const current=projection.current;
    append('leave-now','Leave now',`Finish your visit to ${current.name} now.`,{kind:'leave-now'},{...options,marks:{...options.marks,[current.target.id]:'done'},runtime:{...options.runtime,phase:'start',targetId:null,placeId:current.target.placeId,since:options.now,leaveAt:null,updatedAt:options.now}});
  }
  for(const row of projection.rows){
    const activity=row.target.activity;
    if(row.mark!=='planned'||!activity||row===projection.current||activity.fixed!==null||activity.departureForFlightId||activity.mode==='flight')continue;
    if(activity.duration>15){
      const duration=Math.max(15,activity.duration-15),trip=structuredClone(options.trip);
      trip.days[options.dayIndex].items.find(item=>item.aid===activity.aid)!.duration=duration;
      append(`shorten:${activity.aid}`,`Shorten ${row.name}`,`Spend ${duration} min here instead of ${activity.duration} min.`,{kind:'shorten',activityId:activity.aid,duration},{...options,trip});
    }
    if(projection.phase!=='travel'||row.target.id!==projection.next?.target.id)append(`skip:${activity.aid}`,`Save ${row.name} for later`,'Remove this stop from today and keep it in Ideas.',{kind:'skip',activityId:activity.aid,placeId:activity.placeId},{...options,marks:{...options.marks,[row.target.id]:'skipped'}});
    if(fixes.length>=5)break;
  }
  const next=projection.next;
  if(next&&next.target.kind!=='free'&&projection.phase!=='travel'&&next.mode!=='drive'&&next.mode!=='flight'){
    const from=projection.current?.target.placeId??projection.originPlaceId,route=options.verifiedRoutes?.[todayRouteKey(from,next.target.placeId,'drive')];
    if(known(route)&&route.status==='ready'&&(!known(next.leg)||route.min<next.leg.min)){
      const trip=structuredClone(options.trip),day=trip.days[options.dayIndex];
      if(next.target.kind==='end')day.endMode='drive';else if(next.target.activity)day.items.find(item=>item.aid===next.target.activity!.aid)!.mode='drive';
      append(`drive:${next.target.id}`,`Drive to ${next.name}`,`Use the checked ${route.min}-minute driving route.`,{kind:'drive',targetId:next.target.id},{...options,trip});
    }
  }
  return fixes;
}
