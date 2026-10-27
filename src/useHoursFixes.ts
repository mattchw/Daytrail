import {useEffect,useState} from 'react';
import type {Place,Trip} from './model';
import {fetchVisitOpeningInfo} from './discoveryData';
import {applyOpeningHoursFix,findOpeningHoursFix,hoursFixSignature,type HoursFix,type HoursByPlace} from './hoursPlanning';
import {calculateDayRoutes,routeInputSignature} from './useLiveRoutes';
import {withPlaceAdmission} from './placeHours';

export {applyOpeningHoursFix};
/** Compute suggestions outside rendering; stale journeys never leave an actionable fix. */
export function useHoursFixes(trip:Trip,dayIndex:number,places:Record<string,Place>,hours:HoursByPlace,conflicts:string[],enabled:boolean) {
  const key=JSON.stringify([hoursFixSignature(trip),dayIndex,conflicts,enabled,hours,
    Object.values(places).map(p=>[p.id,p.googlePlaceId,p.lat,p.lng,p.lastEntryMinutes])]);
  const [state,setState]=useState<{key:string;fixes:Record<string,HoursFix|null>;pending:string[]}>({key:'',fixes:{},pending:[]});
  useEffect(()=>{
    let active=true;
    setState({key,fixes:{},pending:enabled?conflicts:[]});
    if(!enabled||!conflicts.length)return()=>{active=false;};
    const timer=setTimeout(()=>{void(async()=>{
      const allHours={...hours};
      const checkedHours=new Set(Object.keys(hours));
      // Check only days considered by the bounded search, rather than fetching
      // every place in a long trip before the nearest reorder can be tried.
      const ensureDayHours=async(candidate:Trip,index:number)=>{
        for(const id of [...new Set(candidate.days[index].items.filter(a=>a.mode!=='flight'&&!a.departureForFlightId).map(a=>a.placeId))]){
          if(!active)return;
          if(!checkedHours.has(id)){
            checkedHours.add(id);
            if(places[id]?.googlePlaceId)try{allHours[id]=await fetchVisitOpeningInfo(places[id].googlePlaceId!);}catch{/* Unknown remains unknown. */}
          }
          allHours[id]=withPlaceAdmission(allHours[id],places[id]);
        }
      };
      let routeChecks=0;
      const routeCache=new Map<string,Awaited<ReturnType<typeof calculateDayRoutes>>>();
      for(const aid of conflicts){
        if(!active)return;
        let fix:HoursFix|null=null;
        try{fix=await findOpeningHoursFix({trip,dayIndex,activityId:aid,places,hours:allHours},async(candidate,index,current)=>{
          const signature=routeInputSignature(candidate,index,places);
          if(routeCache.has(signature))return routeCache.get(signature)!;
          if(++routeChecks>24)throw Error('No verified fix in this search.');
          await ensureDayHours(candidate,index);
          if(!active)throw new DOMException('This check was cancelled.','AbortError');
          const legs=await calculateDayRoutes({...JSON.parse(signature),hours:allHours},undefined,current);
          routeCache.set(signature,legs);return legs;
        },()=>active);}catch{/* A stale or unavailable estimate is never offered as a fix. */}
        if(active)setState(previous=>({key,fixes:{...previous.fixes,[aid]:fix},pending:previous.pending.filter(id=>id!==aid)}));
      }
    })();},600);
    return()=>{active=false;clearTimeout(timer);};
  },[key]);
  return state.key===key?state:{key,fixes:{},pending:enabled?conflicts:[]};
}
