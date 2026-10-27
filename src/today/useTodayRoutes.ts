import {useCallback,useEffect,useRef,useState} from 'react';
import {computeJourney,hasCoordinates,unavailableJourney} from '../googleMaps';
import {dayStartTime,instantAtDayMinutes,type GroundMode,type Journey,type Place} from '../model';
import {buildTodayProjection,todayPlanSignature,todayRouteKey,todayStateSignature,type TodayOptions,type TodayProjection} from './model';

export interface TodayRouteRequest {key:string;from:Place;to:Place;mode:GroundMode;departureMs:number;signature:string}
export function readyTodayStaticRoute(request:TodayRouteRequest,options:TodayOptions):Journey|undefined{
  if(request.mode==='transit')return undefined;
  const verified=options.verifiedRoutes?.[request.key];
  if(verified?.mode===request.mode&&verified.status==='ready'&&verified.min!==null&&Number.isFinite(verified.min)&&verified.min>=0)return verified;
  const day=options.trip.days[options.dayIndex];let from=day.startPlaceId??'hotel';
  const legs=[...day.items.map(item=>({id:item.aid,to:item.placeId,mode:item.mode})),{id:'return',to:day.endPlaceId??'hotel',mode:day.endMode}];
  for(const edge of legs){
    if(from===request.from.id&&edge.to===request.to.id&&edge.mode===request.mode){
      const leg=edge.id==='return'?options.schedule.endLeg:options.schedule.rows.find(row=>row.it.aid===edge.id)?.leg;
      if(leg?.mode===request.mode&&leg.status==='ready'&&leg.min!==null&&Number.isFinite(leg.min)&&leg.min>=0)return leg;
    }
    from=edge.to;
  }
  return undefined;
}
/** Bound the request set to the next journey, its driving alternative and three skip previews. */
export function todayRouteRequests(options:TodayOptions,projection:TodayProjection,includeFixes=false):TodayRouteRequest[]{
  if(!projection.canAct||projection.phase==='complete')return [];
  const requests:TodayRouteRequest[]=[],seen=new Set<string>();
  const add=(fromId:string,toId:string,mode:GroundMode,departure:number|null)=>{
    const from=options.places[fromId],to=options.places[toId],key=todayRouteKey(fromId,toId,mode);
    if(!from||!to||fromId===toId||departure===null||seen.has(key))return;seen.add(key);
    const departureMs=mode==='transit'?Math.floor(departure/60000)*60000:departure;
    requests.push({key,from,to,mode,departureMs,signature:JSON.stringify([fromId,from.googlePlaceId,from.lat,from.lng,toId,to.googlePlaceId,to.lat,to.lng,mode,mode==='transit'?departureMs:null])});
  };
  const next=projection.next,from=projection.current?.target.placeId??projection.originPlaceId;
  const dayStart=instantAtDayMinutes(projection.date,dayStartTime(options.trip.days[options.dayIndex]),projection.timezone)??options.now;
  const departure=projection.phase==='travel'?options.runtime?.since??options.now:projection.current?Math.max(options.now,projection.leaveAt??options.now):Math.max(options.now,dayStart,projection.leaveAt??options.now);
  if(next&&next.mode!=='flight'){
    add(from,next.target.placeId,next.mode,departure);
    if(projection.phase!=='travel'&&next.mode!=='drive')add(from,next.target.placeId,'drive',departure);
  }
  if(includeFixes){
    const remaining=projection.rows.filter(row=>row.mark==='planned'),currentIndex=projection.current?remaining.indexOf(projection.current):-1;
    let count=0;
    for(let index=Math.max(0,currentIndex+1);index<remaining.length-1&&count<3;index++){
      const skipped=remaining[index],activity=skipped.target.activity,after=remaining[index+1];
      if(!activity||activity.fixed!==null||activity.departureForFlightId||activity.mode==='flight'||after.mode==='flight'||projection.phase==='travel'&&skipped.target.id===next?.target.id)continue;
      const before=index>0?remaining[index-1]:null,skipFrom=before?.target.placeId??projection.originPlaceId;
      const skipDeparture=before?before===projection.current?departure:before.end:departure;
      add(skipFrom,after.target.placeId,after.mode,skipDeparture);count++;
    }
  }
  return requests;
}

export async function calculateTodayRoutes(requests:TodayRouteRequest[],current:()=>boolean=()=>true,compute:typeof computeJourney=computeJourney):Promise<Record<string,Journey>>{
  const entries=await Promise.all(requests.map(async request=>{
    if(!current())return null;
    let route:Journey;
    if(!hasCoordinates(request.from)||!hasCoordinates(request.to))route=unavailableJourney(request.mode,'Choose a map location to calculate this journey.');
    else try{route=await compute(request.from,request.to,request.mode,request.mode==='transit'?new Date(request.departureMs):undefined);}catch{route=unavailableJourney(request.mode,'This live journey could not be checked. Try again.');}
    if(!current())return null;
    if(route.mode!==request.mode||route.min!==null&&(!Number.isFinite(route.min)||route.min<0))route=unavailableJourney(request.mode,'A valid journey estimate is unavailable.');
    return [request.key,route] as const;
  }));
  return Object.fromEntries(entries.filter((entry):entry is NonNullable<typeof entry>=>entry!==null));
}

/** Resolve later transit departures in order, because every arrival changes the next departure.
 * Known static routes are reused; unknown earlier travel never creates a made-up departure.
 */
export async function calculateTodayRemainingRoutes(options:TodayOptions,current:()=>boolean=()=>true,compute:typeof computeJourney=computeJourney,onRoutes:(routes:Record<string,Journey>)=>void=()=>{},cache?:Map<string,Journey>):Promise<Record<string,Journey>>{
  const verified:Record<string,Journey>={...options.verifiedRoutes},initial=buildTodayProjection(options);
  if(!initial.canAct||initial.phase==='complete')return verified;
  const remaining=initial.rows.filter(row=>row.mark==='planned'&&row.target.id!==initial.current?.target.id).slice(0,101);
  for(let index=0;index<remaining.length;index++){
    if(!current())return verified;
    const projection=buildTodayProjection({...options,verifiedRoutes:verified}),row=projection.rows.find(row=>row.target.id===remaining[index].target.id)!;
    if(row.mode==='flight')continue;
    const previous=index>0?projection.rows.find(row=>row.target.id===remaining[index-1].target.id):projection.current;
    const fromId=previous?.target.placeId??projection.originPlaceId,toId=row.target.placeId,from=options.places[fromId],to=options.places[toId];
    if(!from||!to||fromId===toId)continue;
    const dayStart=instantAtDayMinutes(projection.date,dayStartTime(options.trip.days[options.dayIndex]),projection.timezone)??options.now;
    const departure=index===0&&projection.phase==='travel'?options.runtime?.since??options.now:previous?(previous.approx?null:previous.end):(index===0?Math.max(options.now,dayStart,projection.leaveAt??options.now):null);
    const key=todayRouteKey(fromId,toId,row.mode);
    if(departure===null&&row.mode==='transit'){verified[key]=unavailableJourney(row.mode,'Confirm earlier journeys before checking this transit departure.');onRoutes({...verified});continue;}
    const departureMs=Math.floor((departure??options.now)/60000)*60000;
    const request:TodayRouteRequest={key,from,to,mode:row.mode,departureMs,signature:JSON.stringify([from.id,from.googlePlaceId,from.lat,from.lng,to.id,to.googlePlaceId,to.lat,to.lng,row.mode,row.mode==='transit'?departureMs:null])};
    const cached=cache?.get(request.signature),ready=cached??readyTodayStaticRoute(request,options);
    if(ready){verified[key]=ready;continue;}
    verified[key]={mode:row.mode,min:null,km:'—',status:'loading',reason:'Checking the route for your live departure.'};onRoutes({...verified});
    const result=await calculateTodayRoutes([request],current,compute);
    if(!current())return verified;
    const leg=result[key];if(leg){verified[key]=leg;if(leg.status==='ready'&&leg.min!==null)cache?.set(request.signature,leg);onRoutes({...verified});}
  }
  return verified;
}

export function useTodayRoutes(options:TodayOptions,enabled=true,includeFixes=false,scopeKey='local'){
  const [online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine!==false);
  useEffect(()=>{const update=()=>setOnline(navigator.onLine!==false);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
  const permitted=enabled&&online;
  const projection=buildTodayProjection(options),requests=todayRouteRequests(options,projection,includeFixes);
  const identity=JSON.stringify([scopeKey,options.trip.id,options.trip.days[options.dayIndex].id,options.trip.startDate]);
  const requestKey=JSON.stringify([requests.map(request=>request.signature),todayPlanSignature(options.trip,options.dayIndex),todayStateSignature(options),options.hoursByPlace,Math.floor(options.now/60000)]),[attempt,setAttempt]=useState(0);
  const key=JSON.stringify([identity,requestKey,attempt,permitted]),latest=useRef({key,requests});latest.current={key,requests};
  const cache=useRef<{identity:string;routes:Map<string,Journey>}>({identity,routes:new Map()});
  const [state,setState]=useState<{key:string;routes:Record<string,Journey>;loading:boolean}>({key:'',routes:{},loading:false});
  useEffect(()=>{
    if(cache.current.identity!==identity)cache.current={identity,routes:new Map()};
    if(!permitted||!projection.canAct||projection.phase==='complete'){setState({key,routes:{},loading:false});return;}
    let active=true;const requestSnapshot=latest.current.requests,initial:Record<string,Journey>={},missing:TodayRouteRequest[]=[];
    for(const request of requestSnapshot){const ready=cache.current.routes.get(request.signature)??readyTodayStaticRoute(request,options);if(ready)initial[request.key]=ready;else{missing.push(request);initial[request.key]={mode:request.mode,min:null,km:'—',status:'loading',reason:'Checking the route for your live departure.'};}}
    setState({key,routes:initial,loading:missing.length>0});
    const timer=window.setTimeout(()=>{
      void calculateTodayRoutes(missing,()=>active&&latest.current.key===key).then(async result=>{
        if(!active||latest.current.key!==key)return;
        for(const request of missing){const route=result[request.key];if(route?.status==='ready'&&route.min!==null)cache.current.routes.set(request.signature,route);}
        const initialRoutes={...initial,...result};setState({key,routes:initialRoutes,loading:true});
        const remaining=await calculateTodayRemainingRoutes({...options,verifiedRoutes:{...options.verifiedRoutes,...initialRoutes}},()=>active&&latest.current.key===key,computeJourney,routes=>{
          if(active&&latest.current.key===key)setState({key,routes,loading:true});
        },cache.current.routes);
        if(!active||latest.current.key!==key)return;
        // Keep a small session cache, never a provider database.
        while(cache.current.routes.size>120)cache.current.routes.delete(cache.current.routes.keys().next().value!);
        setState({key,routes:remaining,loading:false});
      });
    },350);
    return()=>{active=false;window.clearTimeout(timer);};
    // The key includes endpoint coordinates, mode, departure bucket, scope, and retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key]);
  const retry=useCallback(()=>{cache.current.routes.clear();setAttempt(value=>value+1);},[]);
  const pending=Object.fromEntries(requests.map(request=>[request.key,(cache.current.identity===identity?cache.current.routes.get(request.signature):undefined)??readyTodayStaticRoute(request,options)??{mode:request.mode,min:null,km:'—',status:'loading',reason:'Checking the route for your live departure.'}])) as Record<string,Journey>;
  const routes:Record<string,Journey>=!permitted?{}:state.key===key?{...state.routes}:pending;
  for(const request of requests)if(permitted&&routes[request.key]?.status!=='ready'){const ready=readyTodayStaticRoute(request,options);if(ready)routes[request.key]=ready;}
  return {routes,loading:permitted&&Object.values(routes).some(route=>route.status==='loading'),error:Object.values(routes).some(route=>route.status==='unavailable')?'Some live journey times need confirmation.':null,retry};
}
