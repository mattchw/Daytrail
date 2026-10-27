import {PLACES,type Trip} from '../model';
import type {ConflictChoices, MergeConflict} from './types';

const absent = Symbol('absent');
type Value = unknown | typeof absent;
const clone = <T,>(value:T):T => value === absent ? value : structuredClone(value);
const plain = (value:unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function sameValue(a:unknown,b:unknown):boolean {
  if(a === b) return true;
  if(Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value,index)=>sameValue(value,b[index]));
  if(plain(a) && plain(b)) {
    const keys = Object.keys(a).filter(key=>a[key] !== undefined), others=Object.keys(b).filter(key=>b[key] !== undefined);
    return keys.length===others.length && keys.every(key=>Object.hasOwn(b,key) && sameValue(a[key],b[key]));
  }
  return false;
}
const escape = (key:string)=>key.replaceAll('~','~0').replaceAll('/','~1');

/** Stable-ID three-way merge. Array positions are never entity identities. */
export function mergeTrips(base:Trip,local:Trip,remote:Trip,choices:ConflictChoices={}):{trip:Trip;conflicts:MergeConflict[]} {
  const conflicts:MergeConflict[]=[];
  const names:Record<string,string>={pace:'Walking pace',meal:'Meal intent',walkingMeters:'Walking during visit',exposure:'Indoor or outdoor',name:'Trip name',title:'Day title',destination:'Destination',startDate:'Trip dates',timezone:'Time zone',note:'Notes',duration:'Visit duration',fixed:'Arrival time',mode:'Travel mode',startTime:'Day start time',finishBy:'Preferred finish time',startPlaceId:'Starting point',endPlaceId:'End point',endMode:'Final travel mode',startStayId:'Starting accommodation',endStayId:'Ending accommodation',endFlightId:'Final flight',flightId:'Linked flight',departureForFlightId:'Airport check-in',bookingReference:'Private booking reference',privateNotes:'Private booking notes',contact:'Private contact',bookingUrl:'Private booking link',departure:'Departure',arrival:'Arrival',time:'Local time',date:'Date',checkInDate:'Check-in date',checkOutDate:'Check-out date',checkInTime:'Check-in time',checkOutTime:'Check-out time',airportBufferMinutes:'Airport buffer',arrivalBufferMinutes:'Arrival buffer'};
  const placeName=(id:string)=>local.customPlaces[id]?.userLabel||local.customPlaces[id]?.name||remote.customPlaces[id]?.userLabel||remote.customPlaces[id]?.name||PLACES[id]?.name||id.replaceAll('-',' ');
  const label=(path:string)=>{
    const parts=path.split('/').filter(Boolean).map(part=>part.replaceAll('~1','/').replaceAll('~0','~'));
    const field=parts.at(-1)||'';
    if(parts[0]==='days'){
      const day=local.days.find(item=>item.id===parts[1])||remote.days.find(item=>item.id===parts[1])||base.days.find(item=>item.id===parts[1]);
      if(!day)return 'Trip day order';
      const dayName=day.label.split(' · ')[0];
      if(field==='$order')return `${dayName} · Stop order`;
      if(parts[2]==='items'){
        const item=[...day.items,...base.days.flatMap(value=>value.items),...remote.days.flatMap(value=>value.items)].find(item=>item.aid===parts[3]);
        return `${dayName} · ${item?placeName(item.placeId):'Place'}${parts.length>4?' · '+(names[field]||field):''}`;
      }
      return `${dayName} · ${names[field]||'Day details'}`;
    }
    if(parts[0]==='flights'){
      const flight=[...(local.flights||[]),...(remote.flights||[]),...(base.flights||[])].find(item=>item.id===parts[1]);
      return `${flight?.flightNumber||'Flight'} · ${names[field]||'Flight details'}`;
    }
    if(parts[0]==='stays'){
      const stay=[...(local.stays||[]),...(remote.stays||[]),...(base.stays||[])].find(item=>item.id===parts[1]);
      return `${stay?placeName(stay.placeId):'Accommodation'} · ${names[field]||'Stay details'}`;
    }
    if(parts[0]==='customPlaces')return `${placeName(parts[1])} · ${names[field]||'Place details'}`;
    return names[field]||parts.join(' · ');
  };
  const dispute=(path:string,b:Value,l:Value,r:Value,kind:MergeConflict['kind']='field'):Value=>{
    if(choices[path]) return clone(choices[path]==='local'?l:r);
    conflicts.push({path,label:label(path),kind,base:b===absent?undefined:clone(b),local:l===absent?undefined:clone(l),remote:r===absent?undefined:clone(r)});
    return clone(r);
  };
  const merge=(b:Value,l:Value,r:Value,path:string):Value=>{
    if(sameValue(l,b)) return clone(r);
    if(sameValue(r,b) || sameValue(l,r)) return clone(l);
    if(l===absent || r===absent || b===absent) return dispute(path,b,l,r,l===absent||r===absent?'delete':'field');
    if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)) {
      const key = path.endsWith('/items')?'aid':path==='/days'||path==='/flights'||path==='/stays'?'id':null;
      if(key) return mergeEntities(b,l,r,path,key);
      // Saved ideas are a set presented in a stable order. Independent additions survive.
      if(path==='/ideas' && [b,l,r].every(values=>values.every(item=>typeof item==='string'))) {
        const kept = [...r].filter(id=>!b.includes(id)||l.includes(id));
        for(const id of l) if(!b.includes(id)&&!kept.includes(id)) kept.push(id);
        return kept;
      }
      return dispute(path,b,l,r,'order');
    }
    if(plain(b)&&plain(l)&&plain(r)) {
      const result:Record<string,unknown>={};
      for(const key of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])) {
        if(['__proto__','prototype','constructor'].includes(key)) continue;
        const value=merge(Object.hasOwn(b,key)?b[key]:absent,Object.hasOwn(l,key)?l[key]:absent,Object.hasOwn(r,key)?r[key]:absent,`${path}/${escape(key)}`);
        if(value!==absent && value!==undefined) result[key]=value;
      }
      return result;
    }
    return dispute(path,b,l,r);
  };
  const mergeEntities=(b:unknown[],l:unknown[],r:unknown[],path:string,key:string):unknown[]=>{
    const index=(values:unknown[])=>new Map(values.map(value=>[String((value as Record<string,unknown>)[key]),value]));
    const bi=index(b),li=index(l),ri=index(r), ids=(values:unknown[])=>values.map(value=>String((value as Record<string,unknown>)[key]));
    if([bi,li,ri].some((map,i)=>map.size!==[b,l,r][i].length)) return dispute(path,b,l,r,'structure') as unknown[];
    const merged=new Map<string,unknown>();
    for(const id of new Set([...bi.keys(),...li.keys(),...ri.keys()])) {
      const value=merge(bi.has(id)?bi.get(id):absent,li.has(id)?li.get(id):absent,ri.has(id)?ri.get(id):absent,`${path}/${escape(id)}`);
      if(value!==absent) merged.set(id,value);
    }
    const baseIds=ids(b),localIds=ids(l),remoteIds=ids(r);
    const common=baseIds.filter(id=>li.has(id)&&ri.has(id));
    const baseline=baseIds.filter(id=>common.includes(id));
    const localOrder=localIds.filter(id=>common.includes(id)),remoteOrder=remoteIds.filter(id=>common.includes(id));
    const localMoved=!sameValue(localOrder,baseline),remoteMoved=!sameValue(remoteOrder,baseline);
    let order=remoteMoved?remoteIds:localMoved?localIds:remoteIds;
    const planning=(value:unknown)=>plain(value)?Object.fromEntries(Object.entries(value).filter(([field])=>field!=='note')):value;
    const dayId=path.match(/^\/days\/([^/]+)\/items$/)?.[1]?.replaceAll('~1','/').replaceAll('~0','~');
    const dayInputs=(trip:Trip)=>{
      const day=trip.days.find(item=>item.id===dayId);
      return day?{startDate:trip.startDate,timezone:trip.timezone,startTime:day.startTime,finishBy:day.finishBy,startPlaceId:day.startPlaceId,endPlaceId:day.endPlaceId,endMode:day.endMode,timezoneDay:day.timezone,startStayId:day.startStayId,endStayId:day.endStayId,endFlightId:day.endFlightId}:null;
    };
    const localPlanningChanged=common.some(id=>!sameValue(planning(bi.get(id)),planning(li.get(id))))||!!dayId&&!sameValue(dayInputs(base),dayInputs(local));
    const remotePlanningChanged=common.some(id=>!sameValue(planning(bi.get(id)),planning(ri.get(id))))||!!dayId&&!sameValue(dayInputs(base),dayInputs(remote));
    if(localMoved&&remoteMoved&&!sameValue(localOrder,remoteOrder)
      ||path.endsWith('/items')&&(localMoved&&remotePlanningChanged||remoteMoved&&localPlanningChanged)) {
      const chosen=dispute(`${path}/$order`,baseIds,localIds,remoteIds,'order');
      order=chosen as string[];
    }
    order=order.filter(id=>merged.has(id));
    // Insert absent additions beside their nearest surviving predecessor; preserve
    // server-accepted insertions ahead of subsequent additions in the same gap.
    for(const source of [remoteIds,localIds,baseIds]) for(let i=0;i<source.length;i++) {
      const id=source[i]; if(!merged.has(id)||order.includes(id)) continue;
      const before=source.slice(0,i).reverse().find(candidate=>order.includes(candidate));
      const after=source.slice(i+1).find(candidate=>order.includes(candidate));
      const position=after?order.indexOf(after):before?order.length:order.length;
      order.splice(position,0,id);
    }
    return order.map(id=>merged.get(id));
  };
  const trip=merge(base,local,remote,'') as Trip;
  // A route proposal depends on its start/end, dates and times even when the
  // other editor did not touch the items array itself.
  for(const original of base.days){
    const left=local.days.find(day=>day.id===original.id),right=remote.days.find(day=>day.id===original.id),merged=trip.days.find(day=>day.id===original.id);
    if(!left||!right||!merged)continue;
    const common=original.items.map(item=>item.aid).filter(id=>left.items.some(item=>item.aid===id)&&right.items.some(item=>item.aid===id));
    const originalIds=original.items.map(item=>item.aid);
    const moved=(day:typeof original)=>!sameValue(day.items.map(item=>item.aid).filter(id=>originalIds.includes(id)),originalIds.filter(id=>day.items.some(item=>item.aid===id)));
    const inputs=(value:Trip,day:typeof original)=>({startDate:value.startDate,timezone:value.timezone,startTime:day.startTime,finishBy:day.finishBy,startPlaceId:day.startPlaceId,endPlaceId:day.endPlaceId,endMode:day.endMode,dayTimezone:day.timezone,startStayId:day.startStayId,endStayId:day.endStayId,endFlightId:day.endFlightId,
      items:day.items.map(({note:_,...item})=>item).sort((a,b)=>a.aid.localeCompare(b.aid))});
    if(moved(left)&&!sameValue(inputs(base,original),inputs(remote,right))||moved(right)&&!sameValue(inputs(base,original),inputs(local,left))){
      const path=`/days/${escape(original.id)}/items/$order`;
      const chosen=choices[path]??'remote';
      if(!choices[path]&&!conflicts.some(field=>field.path===path))dispute(path,original.items.map(item=>item.aid),left.items.map(item=>item.aid),right.items.map(item=>item.aid),'order');
      const order=(chosen==='local'?left:right).items.map(item=>item.aid),all=new Map(merged.items.map(item=>[item.aid,item]));
      merged.items=[...order.filter(id=>all.has(id)),...merged.items.map(item=>item.aid).filter(id=>!order.includes(id))].map(id=>all.get(id)!);
    }
  }
  const locations=(value:Trip)=>new Map(value.days.flatMap(day=>day.items.map(item=>[item.aid,{day:day.id,item}] as const)));
  const originalLocations=locations(base),localLocations=locations(local),remoteLocations=locations(remote);
  const disputedIds=new Set([...originalLocations].filter(([id,original])=>{
    const left=localLocations.get(id),right=remoteLocations.get(id);
    if(!left&&!right)return false;
    if(!left)return !!right&&!sameValue(original,right);
    if(!right)return !sameValue(original,left);
    return left.day!==original.day&&right.day!==original.day&&left.day!==right.day;
  }).map(([id])=>id));
  // Cross-day moves are coupled remove+insert operations. A conflicting move must
  // not leave an activity duplicated in two days or resurrect a deleted entity.
  const seen=new Set<string>();
  for(const day of trip.days)for(const item of day.items){if(seen.has(item.aid))disputedIds.add(item.aid);seen.add(item.aid);}
  if(disputedIds.size) {
    const path='/days/$structure';
    const selected=choices[path];
    if(!selected) conflicts.push({path,label:'Day structure',kind:'structure',base:clone(base.days),local:clone(local.days),remote:clone(remote.days)});
    // Keep the server's placement only for disputed entities. Independent titles,
    // notes and other stop edits survive review of a conflicting cross-day move.
    for(const id of disputedIds){
      for(const day of trip.days)day.items=day.items.filter(item=>item.aid!==id);
      const saved=remoteLocations.get(id);if(!saved)continue;
      const target=trip.days.find(day=>day.id===saved.day);if(!target)continue;
      const left=localLocations.get(id),original=originalLocations.get(id);
      const item=left&&original?merge(original.item,left.item,saved.item,`/days/${escape(saved.day)}/items/${escape(id)}`) as typeof saved.item:clone(saved.item);
      const order=remote.days.find(day=>day.id===saved.day)!.items.map(item=>item.aid),index=order.indexOf(id);
      const successor=order.slice(index+1).find(aid=>target.items.some(item=>item.aid===aid));
      target.items.splice(successor?target.items.findIndex(item=>item.aid===successor):target.items.length,0,item);
    }
  }
  return {trip,conflicts};
}

/** When compound booking/day edits no longer fit, keep the saved links while
 * retaining independent titles, notes and changes to unrelated ground days. */
export function keepSavedStructure(base:Trip,local:Trip,remote:Trip,choices:ConflictChoices,valid:(trip:Trip)=>boolean):Trip {
  const safe=clone(local);
  safe.startDate=base.startDate;safe.timezone=base.timezone;safe.flights=clone(base.flights);safe.stays=clone(base.stays);
  safe.customPlaces={...clone(base.customPlaces),...clone(local.customPlaces)};
  const hasFlight=(day:Trip['days'][number])=>day.endMode==='flight'||!!day.endFlightId||day.items.some(item=>item.mode==='flight'||item.flightId||item.departureForFlightId);
  safe.days=base.days.map(original=>{
    const edited=local.days.find(day=>day.id===original.id);if(!edited)return clone(original);
    const next=hasFlight(original)||hasFlight(edited)?{...clone(original),title:edited.title,items:original.items.map(item=>{
      const changed=edited.items.find(value=>value.aid===item.aid);return changed?{...clone(item),note:changed.note,duration:changed.duration,fixed:changed.fixed}:clone(item);
    })}:clone(edited);
    for(const key of ['date','label','startPlaceId','endPlaceId','startStayId','endStayId','endFlightId'] as const){
      if(original[key]===undefined)delete next[key];else (next as unknown as Record<string,unknown>)[key]=original[key];
    }
    return next;
  });
  let result=mergeTrips(base,safe,remote,choices).trip;if(valid(result))return result;
  // A changed provider place may also invalidate links. Fall back to independent
  // text edits, never an unannounced whole-trip replacement.
  const textOnly=clone(base);textOnly.name=local.name;textOnly.destination=local.destination;
  for(const day of textOnly.days){const edited=local.days.find(value=>value.id===day.id);if(!edited)continue;day.title=edited.title;
    for(const item of day.items){const changed=edited.items.find(value=>value.aid===item.aid);if(changed)item.note=changed.note;}}
  result=mergeTrips(base,textOnly,remote,choices).trip;return valid(result)?result:clone(remote);
}
