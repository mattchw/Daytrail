import {useEffect,useRef,useState} from 'react';
import {calculateDayRoutes,routeInputSignature} from '../useLiveRoutes';
import {computeJourney,hasCoordinates} from '../googleMaps';
import {searchDiscovery} from '../discoveryData';
import {findPacingFix,pacingFixSignature,type PacingFix,type PacingFixInput,type PacingFixDependencies} from './fixes';
import {knownWalkingMeters,type MealGap,type PacingAssessment} from './model';
import {scheduleWithOpeningHours} from '../hoursPlanning';
import {bookingDayDate,scheduleVisitWindow} from '../model';
/** Explicit, cancellable checks. A single review spends at most 48 route calls. */
export function usePacingFixes(input:PacingFixInput,assessment:PacingAssessment,enabled:boolean){
 const key=JSON.stringify([pacingFixSignature(input.trip),input.dayIndex,input.hours,enabled]),activeKey=useRef(key);activeKey.current=key;
 const request=useRef(0),previousKey=useRef(key);
 if(previousKey.current!==key){previousKey.current=key;request.current++;}
 const [state,setState]=useState<{key:string;pending:boolean;fixes:PacingFix[];error:string|null}>({key,pending:false,fixes:[],error:null});
 useEffect(()=>()=>{request.current++;},[]);
 const clear=()=>{request.current++;setState({key,pending:false,fixes:[],error:null});};
 async function run(gap?:MealGap){
  if(!enabled||activeKey.current!==key||gap&&!assessment.gaps.some(item=>item.id===gap.id))return;const token=++request.current,current=()=>activeKey.current===key&&request.current===token;
  setState({key,pending:true,fixes:[],error:null});
  let routeCalls=0;const routes=new Map<string,Awaited<ReturnType<typeof calculateDayRoutes>>>();
  const resolveRoutes:NonNullable<PacingFixDependencies['resolveRoutes']>=async(trip,index,stillCurrent,context)=>{
   const places={...trip.customPlaces,...context.places},hours=context.hours;
   const signature=routeInputSignature(trip,index,places),cacheKey=JSON.stringify([signature,hours]);
   if(routes.has(cacheKey))return routes.get(cacheKey)!;
   // A meal candidate can add a new place; hydrate it from its authored candidate data.
   const result=await calculateDayRoutes({...JSON.parse(routeInputSignature(trip,index,places)),hours},undefined,stillCurrent,async(...args)=>{
    if(!current()||++routeCalls>48)throw new DOMException('The preview budget is complete.','AbortError');return computeJourney(...args);
   });routes.set(cacheKey,result);return result;
  };
  const fixes:PacingFix[]=[];
  try{
   const day=input.trip.days[input.dayIndex];
   if(gap){
    const midpoint=(gap.windowStart+gap.windowEnd)/2;
    // Use the known visit closest to the meal window as a local discovery anchor.
    const baseline=await resolveRoutes(input.trip,input.dayIndex,current,input);if(!current())return;
    const schedule=scheduleWithOpeningHours(day,input.places,baseline,{date:bookingDayDate(input.trip,input.dayIndex),hours:input.hours,context:{trip:input.trip,dayIndex:input.dayIndex}});
    const positionTime=(index:number)=>{const row=schedule.rows[index];if(!row)return schedule.finish;const window=scheduleVisitWindow(row,bookingDayDate(input.trip,input.dayIndex));return (Date.parse(window.date+'T00:00:00Z')-Date.parse(gap.date+'T00:00:00Z'))/60000+window.start;};
    const positions=Array.from({length:day.items.length+1},(_,index)=>index).sort((a,b)=>Math.abs(positionTime(a)-midpoint)-Math.abs(positionTime(b)-midpoint)).slice(0,2);
    const anchor=input.places[day.items[positions[0]]?.placeId??day.endPlaceId??day.startPlaceId??'hotel'];
    const bounds=hasCoordinates(anchor)?{north:Math.min(90,anchor.lat+.025),south:Math.max(-90,anchor.lat-.025),east:Math.min(180,anchor.lng+.035),west:Math.max(-180,anchor.lng-.035)}:undefined;
    const results=await searchDiscovery('restaurants',input.trip.destination,'restaurants',bounds);if(!current())return;
    for(const result of results.slice(0,2)){for(const insertIndex of positions){
     if(!current()||routeCalls>=48)break;
     const fix=await findPacingFix(input,{kind:'meal-insert',place:result.place,insertIndex,duration:45,gapId:gap.id},{resolveRoutes,current});if(fix){fixes.push(fix);break;}
    }if(fixes.length>=2)break;}
   }else{
    const baseline=await resolveRoutes(input.trip,input.dayIndex,current,input);if(!current())return;
    const candidates=[...day.items.map(item=>({targetId:`activity:${item.aid}`,leg:baseline[item.aid]})),{targetId:`end:${day.id}`,leg:baseline.return}]
     .filter(value=>value.leg&&(value.leg.mode==='walk'||value.leg.mode==='transit')&&(knownWalkingMeters(value.leg)??0)>0)
     .sort((a,b)=>(knownWalkingMeters(b.leg)??0)-(knownWalkingMeters(a.leg)??0)).slice(0,2);
    for(const candidate of candidates){if(!current()||routeCalls>=48)break;const fix=await findPacingFix(input,{kind:'taxi',targetId:candidate.targetId},{resolveRoutes,current});if(fix)fixes.push(fix);}
   }
   if(current())setState({key,pending:false,fixes,error:fixes.length?null:'No checked option fits this day yet. Try another place or adjust a flexible stop.'});
  }catch(error){if(current())setState({key,pending:false,fixes,error:fixes.length?null:error instanceof DOMException&&error.name==='AbortError'?'This preview needs more route checks. Try one journey at a time.':'The preview could not be checked. Your plan is unchanged.'});}
 }
 return {pending:state.key===key&&state.pending,fixes:state.key===key?state.fixes:[],error:state.key===key?state.error:null,runMeal:(gap:MealGap)=>run(gap),runWalking:()=>run(),clear};
}
