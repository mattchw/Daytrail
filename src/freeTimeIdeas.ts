import {bookingDayDate,scheduleVisitWindow,type Activity,type Journey,type Place,type Trip} from './model';
import {airportFinishGoal,hoursFixSignature,scheduleWithOpeningHours,type HoursByPlace} from './hoursPlanning';
import {checkVisitHours} from './visitHours';
import {hasCoordinates,computeJourney} from './googleMaps';
import {calculateDayRoutes,routeInputSignature} from './useLiveRoutes';
import {fetchVisitOpeningInfo} from './discoveryData';
import {withPlaceAdmission} from './placeHours';

export interface NearbyFreeIdea {place:Place;minutes:number}
export function nearbyFreeIdeas(trip:Trip,anchor:Place,places:Record<string,Place>):Place[]{
  if(!hasCoordinates(anchor))return [];
  const radians=(v:number)=>v*Math.PI/180;
  const distance=(p:Place)=>{
    const a=radians(p.lat!-anchor.lat!),b=radians(p.lng!-anchor.lng!);
    const h=Math.sin(a/2)**2+Math.cos(radians(anchor.lat!))*Math.cos(radians(p.lat!))*Math.sin(b/2)**2;
    return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
  };
  const planned=new Set(trip.days.flatMap(day=>day.items.map(item=>item.placeId)));
  const plannedProviderIds=new Set([...planned].map(id=>places[id]?.googlePlaceId).filter(Boolean));
  return trip.ideas.map(id=>places[id]).filter((p):p is Place=>!!p&&hasCoordinates(p)&&p.id!==anchor.id&&!planned.has(p.id)
    &&!(p.googlePlaceId&&(p.googlePlaceId===anchor.googlePlaceId||plannedProviderIds.has(p.googlePlaceId))))
    .map(place=>({place,meters:distance(place)})).filter(v=>v.meters<=1500).sort((a,b)=>a.meters-b.meters).slice(0,3).map(v=>v.place);
}
export async function loadNearbyFreeIdeas(trip:Trip,anchor:Place,places:Record<string,Place>,current:()=>boolean,compute=computeJourney):Promise<NearbyFreeIdea[]>{
  const found:NearbyFreeIdea[]=[];
  for(const place of nearbyFreeIdeas(trip,anchor,places)){
    if(!current())break;
    const leg=await compute(anchor,place,'walk');
    if(current()&&leg.status==='ready'&&leg.min!==null&&Number.isFinite(leg.min)&&leg.min>=0&&leg.min<=20)found.push({place,minutes:leg.min});
  }
  return found;
}
export interface FreeVisitPreview {signature:string;dayId:string;anchorId:string;freeId:string;activity:Activity;place:Place;legs:Record<string,Journey>;hours:HoursByPlace;verifiedAt:number}
interface Dependencies {
  current?:()=>boolean;
  routes?:(trip:Trip,index:number,hours:HoursByPlace,current:()=>boolean)=>Promise<Record<string,Journey>>;
  fetchHours?:typeof fetchVisitOpeningInfo;
  now?:()=>number;
}
/** Replace only this time block; all other stops and their reservations survive. */
export function replaceFreeWithVisit(trip:Trip,preview:FreeVisitPreview,now=Date.now()):void{
  if(hoursFixSignature(trip)!==preview.signature||now<preview.verifiedAt||now-preview.verifiedAt>300000)throw Error('Your plan changed. Check this nearby visit again.');
  if(!trip.ideas.includes(preview.place.id))throw Error('This place is no longer saved in Ideas. Choose another nearby visit.');
  const day=trip.days.find(d=>d.id===preview.dayId),index=day?.items.findIndex(a=>a.aid===preview.anchorId)??-1;
  if(!day||index<0||day.items[index].freeTime?.id!==preview.freeId)throw Error('This free time has changed. Open it again.');
  if(day.items.length>=100)throw Error('This day already has 100 stops.');
  delete day.items[index].freeTime;
  day.items.splice(index+1,0,{...preview.activity});
  trip.ideas=trip.ideas.filter(id=>id!==preview.place.id);
}
export async function previewFreeVisit(input:{trip:Trip;dayIndex:number;anchorId:string;place:Place;places:Record<string,Place>;hours:HoursByPlace},deps:Dependencies={}):Promise<FreeVisitPreview>{
  const {trip,dayIndex,anchorId,place,places}=input,day=trip.days[dayIndex],anchor=day.items.find(a=>a.aid===anchorId);
  if(!anchor?.freeTime||!trip.ideas.includes(place.id))throw Error('This free time or saved Idea has changed.');
  const current=deps.current??(()=>true),assertCurrent=()=>{if(!current())throw Error('Your plan changed. Try this nearby visit again.');};
  const hours={...input.hours};
  if(place.googlePlaceId)hours[place.id]=await (deps.fetchHours??fetchVisitOpeningInfo)(place.googlePlaceId);
  hours[place.id]=withPlaceAdmission(hours[place.id],place);assertCurrent();
  let calls=0;
  const routes=deps.routes??((value,index,info,stillCurrent)=>calculateDayRoutes({...JSON.parse(routeInputSignature(value,index,places)),hours:info},undefined,stillCurrent,async(...args)=>{
    if(++calls>48)throw Error('This day needs too many route checks. Try adding the place directly.');return computeJourney(...args);
  }));
  const evaluate=(value:Trip,legs:Record<string,Journey>)=>scheduleWithOpeningHours(value.days[dayIndex],places,legs,{date:bookingDayDate(value,dayIndex),hours,context:{trip:value,dayIndex}});
  const beforeLegs=await routes(trip,dayIndex,hours,current);assertCurrent();
  const before=evaluate(trip,beforeLegs),block=before.rows.find(r=>r.it.aid===anchorId)?.freeTime;
  if(!block||block.approx||block.duration<15||before.unknown)throw Error('Confirm journey times and leave at least 15 minutes of free time before adding a nearby visit.');
  const candidate=structuredClone(trip),position=day.items.indexOf(anchor);
  const activity:Activity={aid:crypto.randomUUID(),placeId:place.id,duration:Math.min(60,Math.floor(block.duration/15)*15),fixed:null,mode:'walk',note:place.userNotes||''};
  delete candidate.days[dayIndex].items[position].freeTime;
  candidate.days[dayIndex].items.splice(position+1,0,activity);
  // Try shorter visits when the walk consumes part of the available free time.
  while(activity.duration>=15){
    candidate.days[dayIndex].items[position+1]={...activity};
    const legs=await routes(candidate,dayIndex,hours,current);assertCurrent();
    const after=evaluate(candidate,legs),newRow=after.rows.find(r=>r.it.aid===activity.aid)!;
    const date=bookingDayDate(trip,dayIndex),goal=airportFinishGoal(trip,dayIndex);
    let safe=!after.unknown&&!after.finishApprox&&after.finish<=before.finish&&after.late<=before.late&&goal!==null;
    for(const limit of [day.finishBy,goal])if(limit!=null&&Math.max(0,after.finish-limit)>Math.max(0,before.finish-limit))safe=false;
    if(checkVisitHours(hours[place.id],{...scheduleVisitWindow(newRow,date),allowWait:true}).status!=='fits')safe=false;
    for(const row of after.rows){
      const prior=before.rows.find(r=>r.it.aid===row.it.aid);if(!prior)continue;
      if(row.late>prior.late)safe=false;
      const old=checkVisitHours(hours[row.pl.id],scheduleVisitWindow(prior,date)),next=checkVisitHours(hours[row.pl.id],scheduleVisitWindow(row,date));
      const rank=(s:string)=>s==='closed'?2:s==='short'?1:0;
      if(rank(next.status)>rank(old.status)||old.status!=='unknown'&&next.status==='unknown')safe=false;
      if(old.status==='short'&&next.status==='short'&&(next.availableMinutes??0)<(old.availableMinutes??0))safe=false;
      if(old.status==='closed'&&next.status==='closed'&&old.reason!=='closed-day'&&Math.max(row.start,row.arrive)>Math.max(prior.start,prior.arrive))safe=false;
      if(prior.freeTime&&row.freeTime&&row.freeTime.duration<prior.freeTime.duration)safe=false;
    }
    if(safe)return {signature:hoursFixSignature(trip),dayId:day.id,anchorId,freeId:anchor.freeTime.id,activity:{...activity},place,legs,hours,verifiedAt:(deps.now??Date.now)()};
    activity.duration-=15;
  }
  throw Error('This visit cannot fit the free time with its walks, opening hours and your bookings. It is still saved in Ideas.');
}
