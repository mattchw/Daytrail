import {bookingDayDate,dayStartTime,dayTimezone,dayMinutesAt,instantAtDayMinutes,localDateAt,scheduleVisitWindow,type Journey,type MealIntent,type Pace,type Place,type Trip,type schedule} from '../model';
import {visitTraits} from './traits';
import {visitDateForHours} from '../hoursPlanning';
export const PACE_LIMITS:Readonly<Record<Pace,number>>={relaxed:8000,moderate:12000,active:16000};
export interface MealGap {id:string;window:'lunch'|'dinner';date:string;start:number;end:number;windowStart:number;windowEnd:number}
export interface PacingAssessment {
 pace:Pace;limitMeters:number;signature:string;
 walking:{knownMeters:number;routeMeters:number;onSiteMeters:number;freeTimeMeters:number;unknownLegIds:string[];unknownVisitIds:string[];estimatedVisitIds:string[];exceedsLimit:boolean};
 meals:{activityId:string;date:string;start:number;end:number;kind:MealIntent}[];gaps:MealGap[];timingComplete:boolean;
}
export function pacingSignature(trip:Trip,dayIndex:number):string{
 const day=trip.days[dayIndex];return JSON.stringify([trip.id,trip.startDate,trip.timezone,trip.pace??'relaxed',day,
 Object.entries(trip.customPlaces).map(([id,p])=>[id,p.googlePlaceId,p.lat,p.lng,p.lastEntryMinutes]),trip.flights??[]]);
}
export function knownWalkingMeters(leg:Journey):number|undefined{
 if(leg.mode==='flight'||leg.mode==='drive')return 0;
 if(leg.status!=='ready'||leg.min===null)return undefined;
 const meters=leg.walkingMeters??(leg.mode==='walk'?leg.distanceMeters:undefined);
 return typeof meters==='number'&&Number.isFinite(meters)&&meters>=0?meters:undefined;
}
/** Planned meal-free spans; they never assert when a traveller actually ate. */
export function assessPacing(trip:Trip,dayIndex:number,sc:ReturnType<typeof schedule>,places:Record<string,Place>):PacingAssessment{
 const day=trip.days[dayIndex],pace=day.pace??trip.pace??'relaxed',limitMeters=PACE_LIMITS[pace],date=bookingDayDate(trip,dayIndex),zone=dayTimezone(trip,day);
 const walking:PacingAssessment['walking']={knownMeters:0,routeMeters:0,onSiteMeters:0,freeTimeMeters:0,unknownLegIds:[],unknownVisitIds:[],estimatedVisitIds:[],exceedsLimit:false};
 const addLeg=(id:string,leg:Journey)=>{const meters=knownWalkingMeters(leg);if(meters===undefined)walking.unknownLegIds.push(id);else walking.routeMeters+=meters;};
 const meals:PacingAssessment['meals']=[],freeMealInstants:{start:number;end:number}[]=[];
 let placeZone=zone;
 for(const row of sc.rows){addLeg(row.it.aid,row.leg);
  if(row.flight?.arrival.timezone)placeZone=row.flight.arrival.timezone;
  const free=row.freeTime;
  if(free){
   // The resolved length matters: a booking buffer can shrink to zero on a busy day.
   if(free.kind==='explore'||free.kind==='shopping'){
    walking.freeTimeMeters+=free.duration*25;
    if(free.duration>0)walking.estimatedVisitIds.push(free.id);
   }
   if(free.kind==='rest'&&free.duration>=30&&!free.approx){
    const start=instantAtDayMinutes(date,free.start,zone),end=instantAtDayMinutes(date,free.end,zone);
    if(start!==null&&end!==null){
     const first=localDateAt(start,placeZone),last=localDateAt(end,placeZone);
     for(let stamp=Date.parse(first+'T00:00:00Z'),n=0;stamp<=Date.parse(last+'T00:00:00Z')&&n<3;stamp+=86400000,n++){
      const localDate=new Date(stamp).toISOString().slice(0,10),lunchStart=instantAtDayMinutes(localDate,690,placeZone),lunchEnd=instantAtDayMinutes(localDate,810,placeZone);
      if(lunchStart!==null&&lunchEnd!==null&&start<lunchEnd&&end>lunchStart){
       meals.push({activityId:free.id,date:localDate,start:dayMinutesAt(start,localDate,placeZone),end:dayMinutesAt(end,localDate,placeZone),kind:'meal'});
       freeMealInstants.push({start,end});break;
      }
     }
    }
   }
  }
  if(row.it.mode==='flight'||row.it.flightId||row.it.departureForFlightId)continue;
  const traits=visitTraits(row.it,places[row.it.placeId]);
  if(traits.walkingMeters===undefined)walking.unknownVisitIds.push(row.it.aid);else{walking.onSiteMeters+=traits.walkingMeters;walking.estimatedVisitIds.push(row.it.aid);}
  if(traits.meal!=='none'){const window=scheduleVisitWindow(row,date),offset=Math.floor(window.start/1440)*1440;meals.push({activityId:row.it.aid,date:visitDateForHours(row,date),start:window.start-offset,end:window.end-offset,kind:traits.meal});}
 }
 addLeg(`end:${day.id}`,sc.endLeg);walking.knownMeters=walking.routeMeters+walking.onSiteMeters+walking.freeTimeMeters;walking.exceedsLimit=walking.knownMeters>limitMeters;
 const gaps:MealGap[]=[],timingComplete=!sc.unknown&&!sc.finishApprox&&sc.rows.every(row=>!row.approx&&!row.freeTime?.approx);
 if(timingComplete){
  // Flights divide local ground-day windows. Never call an in-flight interval a missed meal.
  const toInstant=(minute:number)=>instantAtDayMinutes(date,minute,zone);
  let segmentStart=toInstant(dayStartTime(day)),segmentZone=zone;
  const segments:{start:number;end:number;zone:string}[]=[];
  for(const row of sc.rows){if(!row.leg.flight)continue;const flight=row.leg.flight;
   if(segmentStart!==null&&flight.departureMs>segmentStart)segments.push({start:segmentStart,end:flight.departureMs,zone:segmentZone});
   segmentStart=flight.arrivalReadyMs;segmentZone=row.flight?.arrival.timezone??trip.flights?.find(f=>f.id===row.it.flightId)?.arrival.timezone??segmentZone;
  }
  const endFlight=sc.endLeg.flight,finish=toInstant(sc.finish);
  if(segmentStart!==null){const end=endFlight?.departureMs??finish;if(end!==null&&end>segmentStart)segments.push({start:segmentStart,end,zone:segmentZone});}
  const mealInstants=[...sc.rows.filter(row=>row.it.mode!=='flight'&&!row.it.departureForFlightId&&visitTraits(row.it,places[row.it.placeId]).meal==='meal').map(row=>({start:toInstant(Math.max(row.start,row.arrive)),end:toInstant(row.physicalEnd)})).filter((meal):meal is {start:number;end:number}=>meal.start!==null&&meal.end!==null),...freeMealInstants];
  for(const segment of segments){
   let cursor=segment.start;
   const spans:{start:number;end:number}[]=[];
   for(const meal of mealInstants.filter(meal=>meal.end>segment.start&&meal.start<segment.end).sort((a,b)=>a.start-b.start)){
    if(meal.start>cursor)spans.push({start:cursor,end:Math.min(meal.start,segment.end)});cursor=Math.max(cursor,meal.end);
   }
   if(cursor<segment.end)spans.push({start:cursor,end:segment.end});
   for(const span of spans){if(span.end-span.start<240*60000)continue;
    const first=localDateAt(span.start,segment.zone),last=localDateAt(span.end,segment.zone);
    for(let stamp=Date.parse(first+'T00:00:00Z'),n=0;stamp<=Date.parse(last+'T00:00:00Z')&&n<5;stamp+=86400000,n++){
     const localDate=new Date(stamp).toISOString().slice(0,10);
     for(const [window,from,to] of [['lunch',690,810],['dinner',1110,1230]] as const){
      const fromMs=instantAtDayMinutes(localDate,from,segment.zone),toMs=instantAtDayMinutes(localDate,to,segment.zone);
      if(fromMs===null||toMs===null||span.start>fromMs||span.end<toMs)continue;
      const id=JSON.stringify([day.id,localDate,window]);
      if(!gaps.some(gap=>gap.id===id))gaps.push({id,window,date:localDate,start:dayMinutesAt(span.start,localDate,segment.zone),end:dayMinutesAt(span.end,localDate,segment.zone),windowStart:from,windowEnd:to});
     }
    }
   }
  }
 }
 meals.sort((a,b)=>a.date.localeCompare(b.date)||a.start-b.start);
 return {pace,limitMeters,walking,meals,gaps,timingComplete,signature:pacingSignature(trip,dayIndex)};
}
