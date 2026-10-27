import {bookingDayDate,dayTimezone,getPlaces,incomingFlightStartIssue,type Trip,type Place,type Journey} from '../model';
import {type HoursByPlace} from '../hoursPlanning';
import {evaluatePacingDay,safePacingChange,pacingFixSignature,type PacingDayEvaluation} from '../pacing/fixes';
import {calculateDayRoutes,routeInputSignature} from '../useLiveRoutes';
import {computeJourney,fetchPlace,findSamplePlace,hasCoordinates} from '../googleMaps';
import {fetchVisitOpeningInfo} from '../discoveryData';
import {withPlaceAdmission} from '../placeHours';
import {assessVisitWeather,weatherVisits,type WeatherForecast,type WeatherVisit} from './model';
import {getWeatherForecast} from './client';

export interface RainMoveFix {
  kind:'rain-move';activityId:string;fromDayId:string;toDayId:string;insertIndex:number;
  label:string;detail:string;inputSignature:string;verifiedAt:number;
  before:PacingDayEvaluation;after:PacingDayEvaluation;destinationBefore:PacingDayEvaluation;
  legsByDayId:Record<string,Record<string,Journey>>;
}
export interface RainMoveInput {trip:Trip;dayIndex:number;activityId:string;places:Record<string,Place>;hours:HoursByPlace}
export interface RainMoveDependencies {
  current?:()=>boolean;now?:()=>number;
  resolveRoutes?:(trip:Trip,index:number,places:Record<string,Place>,hours:HoursByPlace)=>Promise<Record<string,Journey>>;
  forecast?:(visit:WeatherVisit)=>Promise<WeatherForecast|undefined>;
  prepareDay?:(trip:Trip,index:number,places:Record<string,Place>,hours:HoursByPlace)=>Promise<void>;
}

/** A rain suggestion is checked against both days; forecasts alone cannot approve a move. */
export async function findRainMove(input:RainMoveInput,deps:RainMoveDependencies={}):Promise<RainMoveFix|null> {
  const current=deps.current??(()=>true),now=deps.now??Date.now;
  const assertCurrent=()=>{if(!current())throw new DOMException('The plan changed.','AbortError');};
  const source=input.trip.days[input.dayIndex],item=source?.items.find(activity=>activity.aid===input.activityId);
  if(!item||item.fixed!==null||item.flightId||item.departureForFlightId||item.mode==='flight')return null;
  const places={...getPlaces(input.trip),...input.places},hours={...input.hours};
  const prepared=new Set<number>(),hourIds=new Set(Object.keys(hours)),forecastCache=new Map<string,Promise<WeatherForecast|undefined>>();
  let calls=0,attempts=0,placeCalls=0;
  const prepare=async(trip:Trip,index:number)=>{
    if(prepared.has(index))return;prepared.add(index);assertCurrent();
    if(deps.prepareDay){await deps.prepareDay(trip,index,places,hours);assertCurrent();return;}
    const day=trip.days[index];
    for(const id of [...new Set([day.startPlaceId??'hotel',...day.items.map(a=>a.placeId),day.endPlaceId??'hotel'])]){
      assertCurrent();const place=places[id];if(!place)continue;
      if(!hasCoordinates(place)&&++placeCalls<=24)try{const found=place.googlePlaceId?await fetchPlace(place.googlePlaceId):!trip.customPlaces[id]?await findSamplePlace(place,trip.destination):null;if(found)places[id]={...place,...found,id};}catch{/* An unavailable location cannot approve a route. */}
      if(!hourIds.has(id)){hourIds.add(id);if(places[id]?.googlePlaceId)try{hours[id]=await fetchVisitOpeningInfo(places[id].googlePlaceId!);}catch{/* Remains unknown. */}}
      hours[id]=withPlaceAdmission(hours[id],places[id]);
    }
  };
  const forecasts=async(visit:WeatherVisit)=>{
    if(!visit.location)return undefined;
    const key=visit.location.key;
    if(!forecastCache.has(key))forecastCache.set(key,(deps.forecast?deps.forecast(visit):getWeatherForecast(visit.location,{now:now()})).catch(()=>undefined));
    return forecastCache.get(key)!;
  };
  const risks=async(trip:Trip,index:number,evaluation:PacingDayEvaluation)=>{
    const result=new Map<string,ReturnType<typeof assessVisitWeather>>();
    for(const visit of weatherVisits(trip,index,places,evaluation.schedule)){assertCurrent();const forecast=await forecasts(visit);assertCurrent();result.set(visit.id,assessVisitWeather(visit,forecast,now()));}
    return result;
  };
  const routeCache=new Map<string,Record<string,Journey>>();
  const evaluate=async(trip:Trip,index:number)=>{
    await prepare(trip,index);assertCurrent();const signature=routeInputSignature(trip,index,places);
    let legs=routeCache.get(signature);
    if(!legs){legs=deps.resolveRoutes?await deps.resolveRoutes(trip,index,places,hours):await calculateDayRoutes({...JSON.parse(signature),hours},undefined,current,async(...args)=>{assertCurrent();if(++calls>100)throw Error('No verified rain move within this search. Try another day manually.');return computeJourney(...args);});routeCache.set(signature,legs);}
    assertCurrent();return {legs,evaluation:evaluatePacingDay({...input,places,hours},trip,index,legs)};
  };
  const original=await evaluate(input.trip,input.dayIndex),originalRisks=await risks(input.trip,input.dayIndex,original.evaluation);
  if(original.evaluation.schedule.unknown||originalRisks.get(item.aid)?.status!=='rain')return null;
  const targetIndices=input.trip.days.map((_,index)=>index).filter(index=>index!==input.dayIndex).sort((a,b)=>Math.abs(a-input.dayIndex)-Math.abs(b-input.dayIndex)||a-b);
  for(const index of targetIndices){
    assertCurrent();const target=input.trip.days[index];if(target.items.length>=100)continue;
    const targetBase=await evaluate(input.trip,index);if(targetBase.evaluation.schedule.unknown)continue;
    const baseRisks=await risks(input.trip,index,targetBase.evaluation);
    let first=0,last=target.items.length;
    target.items.forEach((activity,i)=>{if(activity.mode==='flight')first=i+1;if(activity.departureForFlightId)last=Math.min(last,i);});
    for(let insertIndex=first;insertIndex<=last;insertIndex++){
      assertCurrent();if(++attempts>16)return null;
      const candidate=structuredClone(input.trip),[moving]=candidate.days[input.dayIndex].items.splice(source.items.findIndex(a=>a.aid===item.aid),1);
      candidate.days[index].items.splice(insertIndex,0,moving);
      if(candidate.days.some((_,i)=>!incomingFlightStartIssue(input.trip,i)&&incomingFlightStartIssue(candidate,i)))continue;
      const from=await evaluate(candidate,input.dayIndex),to=await evaluate(candidate,index);
      if(!safePacingChange(original.evaluation,from.evaluation,candidate,input.dayIndex)||!safePacingChange(targetBase.evaluation,to.evaluation,candidate,index)||to.evaluation.checks[item.aid]?.status!=='fits')continue;
      const fromRisks=await risks(candidate,input.dayIndex,from.evaluation),toRisks=await risks(candidate,index,to.evaluation);
      if(toRisks.get(item.aid)?.status!=='clear')continue;
      const worsens=(after:Map<string,ReturnType<typeof assessVisitWeather>>,before:Map<string,ReturnType<typeof assessVisitWeather>>)=>[...after].some(([id,risk])=>id!==item.aid&&(risk.status==='unknown'&&before.has(id)&&before.get(id)?.status!=='unknown'||risk.status==='rain'&&(before.get(id)?.status!=='rain'||(risk.probability??0)>(before.get(id)?.probability??0))));
      if(worsens(fromRisks,originalRisks)||worsens(toRisks,baseRisks))continue;
      assertCurrent();const date=new Date(bookingDayDate(candidate,index)+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
      return {kind:'rain-move',activityId:item.aid,fromDayId:source.id,toDayId:target.id,insertIndex,label:`Move to ${date}`,detail:`Lower rain risk during this visit · both days’ hours, bookings and pacing checked. Times are local to ${dayTimezone(candidate,target)}.`,inputSignature:pacingFixSignature(input.trip),verifiedAt:now(),before:original.evaluation,after:to.evaluation,destinationBefore:targetBase.evaluation,legsByDayId:{[source.id]:from.legs,[target.id]:to.legs}};
    }
  }
  return null;
}

export function applyRainMove(trip:Trip,fix:RainMoveFix,now=Date.now()):void {
  if(pacingFixSignature(trip)!==fix.inputSignature||now<fix.verifiedAt||now-fix.verifiedAt>300000)throw Error('The itinerary or forecast check changed. Review a fresh rain suggestion.');
  const source=trip.days.find(day=>day.id===fix.fromDayId),target=trip.days.find(day=>day.id===fix.toDayId),index=source?.items.findIndex(item=>item.aid===fix.activityId)??-1;
  if(!source||!target||source===target||index<0||fix.insertIndex<0||fix.insertIndex>target.items.length||!Number.isInteger(fix.insertIndex))throw Error('This stop moved. Check the suggestion again.');
  const item=source.items[index];if(item.fixed!==null||item.flightId||item.departureForFlightId||item.mode==='flight')throw Error('A booked journey cannot be moved by a weather suggestion.');
  source.items.splice(index,1);target.items.splice(fix.insertIndex,0,item);
}
