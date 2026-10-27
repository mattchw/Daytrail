import {bookingDayDate,incomingFlightStartIssue,isTrip,scheduleVisitWindow,type Activity,type Journey,type Place,type Trip} from '../model';
import {airportFinishGoal,hoursFixSignature,scheduleWithOpeningHours,type HoursByPlace} from '../hoursPlanning';
import {checkVisitHours,type VisitHoursCheck} from '../visitHours';
import {calculateDayRoutes,routeInputSignature} from '../useLiveRoutes';
import {computeJourney} from '../googleMaps';
import {fetchVisitOpeningInfo} from '../discoveryData';
import {withPlaceAdmission} from '../placeHours';
import {assessPacing,type PacingAssessment} from './model';
export interface PacingFixInput {trip:Trip;dayIndex:number;places:Record<string,Place>;hours:HoursByPlace}
export type PacingCandidate={kind:'meal-insert';place:Place;insertIndex:number;duration?:number;gapId?:string}|{kind:'taxi';targetId:string};
export interface PacingDayEvaluation {schedule:ReturnType<typeof scheduleWithOpeningHours>;checks:Record<string,VisitHoursCheck>;assessment:PacingAssessment}
export interface PacingFix {kind:PacingCandidate['kind'];label:string;detail:string;dayId:string;candidate:PacingCandidate;activity?:Activity;inputSignature:string;verifiedAt:number;before:PacingDayEvaluation;after:PacingDayEvaluation;legs:Record<string,Journey>}
export interface PacingFixDependencies {resolveRoutes?:(trip:Trip,index:number,current:()=>boolean,context:{places:Record<string,Place>;hours:HoursByPlace})=>Promise<Record<string,Journey>>;current?:()=>boolean;now?:()=>number;fetchHours?:typeof fetchVisitOpeningInfo}
export function pacingFixSignature(trip:Trip):string{return JSON.stringify([hoursFixSignature(trip),trip.pace??'relaxed']);}
export function evaluatePacingDay(input:PacingFixInput,trip:Trip,index:number,legs:Record<string,Journey>):PacingDayEvaluation{
 const date=bookingDayDate(trip,index),schedule=scheduleWithOpeningHours(trip.days[index],input.places,legs,{date,hours:input.hours,context:{trip,dayIndex:index}});
 const checks=Object.fromEntries(schedule.rows.filter(row=>!row.it.flightId&&row.it.mode!=='flight'&&!row.it.departureForFlightId).map(row=>[row.it.aid,checkVisitHours(input.hours[row.it.placeId],{...scheduleVisitWindow(row,date),allowWait:row.it.fixed===null})]));
 return {schedule,checks,assessment:assessPacing(trip,index,schedule,input.places)};
}
const rank=(check:VisitHoursCheck|undefined)=>check?.status==='closed'?2:check?.status==='short'?1:0;
/** Shared by meal, taxi and rain previews. No new/worse hard constraints or comfort gaps. */
export function safePacingChange(before:PacingDayEvaluation,after:PacingDayEvaluation,trip:Trip,index:number):boolean{
 const day=trip.days[index],old=before.schedule,next=after.schedule;
 if(next.unknown||next.finishApprox||next.late>old.late)return false;
 const goal=airportFinishGoal(trip,index);
 if(goal===null)return false;
 for(const limit of [day.finishBy,goal])if(limit!==undefined&&limit!==null&&Math.max(0,next.finish-limit)>Math.max(0,old.finish-limit))return false;
 for(const row of next.rows){const prior=old.rows.find(item=>item.it.aid===row.it.aid),a=before.checks[row.it.aid],b=after.checks[row.it.aid];
  if(row.late>(prior?.late??0)||rank(b)>rank(a)||a?.status!=='unknown'&&a&&b?.status==='unknown')return false;
  if(a?.status==='short'&&b?.status==='short'&&(b.availableMinutes??0)<(a.availableMinutes??0))return false;
  if(prior&&a?.status==='closed'&&b?.status==='closed'&&a.reason!=='closed-day'&&Math.max(row.start,row.arrive)>Math.max(prior.start,prior.arrive))return false;
 }
 if(after.assessment.gaps.some(gap=>!before.assessment.gaps.some(old=>old.id===gap.id)))return false;
 const excess=(value:PacingAssessment)=>Math.max(0,value.walking.knownMeters-value.limitMeters);
 return excess(after.assessment)<=excess(before.assessment);
}
function mutate(trip:Trip,dayIndex:number,candidate:PacingCandidate,activity?:Activity){
 const day=trip.days[dayIndex];
 if(candidate.kind==='meal-insert'){
  if(!activity||!Number.isInteger(candidate.insertIndex)||candidate.insertIndex<0||candidate.insertIndex>day.items.length||day.items.length>=100)throw Error('The insertion point changed.');
  if(!trip.customPlaces[candidate.place.id]&&!Object.hasOwn(knownSamplePlaces,candidate.place.id))trip.customPlaces[candidate.place.id]={...candidate.place};
  day.items.splice(candidate.insertIndex,0,{...activity});
 }else{
  if(candidate.targetId===`end:${day.id}`){if(day.endMode==='flight'||day.endFlightId)throw Error('Keep the booked flight.');day.endMode='drive';}
  else {const item=day.items.find(item=>`activity:${item.aid}`===candidate.targetId);if(!item||item.mode==='flight'||item.flightId)throw Error('The journey changed.');item.mode='drive';}
 }
}
// Only names/coordinates needed by this planner; canonical persistence applies provider restrictions later.
import {PLACES as knownSamplePlaces} from '../model';
export async function findPacingFix(input:PacingFixInput,candidate:PacingCandidate,dependencies:PacingFixDependencies={}):Promise<PacingFix|null>{
 const current=dependencies.current??(()=>true),assertCurrent=()=>{if(!current())throw new DOMException('The plan changed.','AbortError');};assertCurrent();
 const trip=structuredClone(input.trip),day=trip.days[input.dayIndex];if(!day)return null;
 let activity:Activity|undefined;
 if(candidate.kind==='meal-insert'){
  const duration=candidate.duration??45;if(!Number.isInteger(duration)||duration<15||duration>180)return null;
  // Do not detach a selected place from its actual trip ID or alter an existing venue.
  activity={aid:`meal-${crypto.randomUUID()}`,placeId:candidate.place.id,duration,fixed:null,mode:'walk',note:'',meal:'meal'};
 }else{const mode=candidate.targetId===`end:${day.id}`?day.endMode:day.items.find(item=>`activity:${item.aid}`===candidate.targetId)?.mode;if(mode!=='walk'&&mode!=='transit')return null;}
 try{mutate(trip,input.dayIndex,candidate,activity);}catch{return null;}
 if(!isTrip(trip))return null;
 for(let index=0;index<trip.days.length;index++)if(incomingFlightStartIssue(trip,index)&&!incomingFlightStartIssue(input.trip,index))return null;
 const places={...input.places,...(candidate.kind==='meal-insert'?{[candidate.place.id]:input.places[candidate.place.id]??candidate.place}:{})},hours={...input.hours};
 for(const id of [...new Set(day.items.filter(item=>item.mode!=='flight'&&!item.departureForFlightId).map(item=>item.placeId))]){
  assertCurrent();if(places[id]?.googlePlaceId)try{hours[id]=await(dependencies.fetchHours??fetchVisitOpeningInfo)(places[id].googlePlaceId!);}catch{hours[id]=undefined;}
  hours[id]=withPlaceAdmission(hours[id],places[id]);
 }
 const context={...input,places,hours};let calls=0;
 const resolve:NonNullable<PacingFixDependencies['resolveRoutes']>=dependencies.resolveRoutes??((value,index,stillCurrent)=>calculateDayRoutes({...JSON.parse(routeInputSignature(value,index,places)),hours},undefined,stillCurrent,async(...args)=>{
  if(++calls>48)throw Error('This preview needs too many route checks.');return computeJourney(...args);
 }));
 const beforeLegs=await resolve(input.trip,input.dayIndex,current,context);assertCurrent();
 const legs=await resolve(trip,input.dayIndex,current,context);assertCurrent();
 const before=evaluatePacingDay(context,input.trip,input.dayIndex,beforeLegs),after=evaluatePacingDay(context,trip,input.dayIndex,legs);
 if(!safePacingChange(before,after,trip,input.dayIndex))return null;
 if(candidate.kind==='meal-insert'){
  if(after.checks[activity!.aid]?.status!=='fits')return null;
  if(candidate.gapId?(!before.assessment.gaps.some(g=>g.id===candidate.gapId)||after.assessment.gaps.some(g=>g.id===candidate.gapId)):after.assessment.gaps.length>=before.assessment.gaps.length)return null;
 }else{
  if(after.assessment.walking.knownMeters>=before.assessment.walking.knownMeters||after.assessment.walking.unknownLegIds.length>before.assessment.walking.unknownLegIds.length)return null;
 }
 const saved=Math.max(0,before.assessment.walking.knownMeters-after.assessment.walking.knownMeters),name=candidate.kind==='meal-insert'?(candidate.place.userLabel||candidate.place.name):undefined;
 return {kind:candidate.kind,label:candidate.kind==='meal-insert'?`Add a meal at ${name}`:'Take a taxi for this journey',detail:candidate.kind==='meal-insert'?`${activity!.duration} min meal · venue hours and onward routes checked`:`About ${(saved/1000).toFixed(1)} km less walking · driving estimate, excluding pickup time`,dayId:day.id,candidate,activity,inputSignature:pacingFixSignature(input.trip),verifiedAt:(dependencies.now??Date.now)(),before,after,legs};
}
export function applyPacingFix(trip:Trip,fix:PacingFix,now=Date.now()):void{
 if(pacingFixSignature(trip)!==fix.inputSignature||now<fix.verifiedAt||now-fix.verifiedAt>300000)throw Error('The plan changed or this check expired. Review a fresh suggestion.');
 const index=trip.days.findIndex(day=>day.id===fix.dayId);if(index<0)throw Error('This day is no longer available.');
 const candidate=structuredClone(trip);mutate(candidate,index,fix.candidate,fix.activity);if(!isTrip(candidate))throw Error('This suggestion no longer fits the itinerary.');
 mutate(trip,index,fix.candidate,fix.activity);
}
