import type {TodayRuntime} from './model';

export interface TodayIdentity {ownerId:string|null;scope:'guest'|'account';tripId:string;dayId:string}
export function todayStorageKey(identity:TodayIdentity):string {
  return `daytrail.today.v1:${encodeURIComponent(JSON.stringify([identity.scope,identity.ownerId,identity.tripId,identity.dayId]))}`;
}
/** No bookings, contact details, auth tokens or provider responses are persisted here. */
export function parseTodayRuntime(raw:string|null,identity:TodayIdentity,now=Date.now()):TodayRuntime|null {
  try{
    const value=JSON.parse(raw??'null'),runtime=value?.runtime;
    if(!value||value.ownerId!==identity.ownerId||value.scope!==identity.scope||(identity.scope==='account'&&!identity.ownerId)||!runtime||runtime.schema!==1||runtime.tripId!==identity.tripId||runtime.dayId!==identity.dayId)return null;
    if(typeof runtime.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(runtime.date)||new Date(`${runtime.date}T00:00:00Z`).toISOString().slice(0,10)!==runtime.date||typeof runtime.timezone!=='string'||runtime.timezone.length>100||!['start','travel','visit','complete'].includes(runtime.phase)||typeof runtime.placeId!=='string'||!runtime.placeId||runtime.placeId.length>200)return null;
    new Intl.DateTimeFormat('en-GB',{timeZone:runtime.timezone}).format(now);
    if(runtime.targetId!==null&&(typeof runtime.targetId!=='string'||runtime.targetId.length>240))return null;
    if((runtime.phase==='travel'||runtime.phase==='visit')!==Boolean(runtime.targetId))return null;
    if(!Number.isFinite(runtime.since)||!Number.isFinite(runtime.updatedAt)||runtime.since>now+60000||runtime.updatedAt>now+60000||runtime.updatedAt<runtime.since||now-runtime.updatedAt>7*86400000||now-runtime.since>7*86400000)return null;
    if(runtime.leaveAt!==null&&(!Number.isFinite(runtime.leaveAt)||runtime.leaveAt<runtime.since||runtime.leaveAt-runtime.since>7*86400000))return null;
    if(runtime.originArrivedAt!==undefined&&(!Number.isFinite(runtime.originArrivedAt)||runtime.originArrivedAt>runtime.since||runtime.since-runtime.originArrivedAt>7*86400000))return null;
    if(runtime.bypassedFreeIds!==undefined&&(!Array.isArray(runtime.bypassedFreeIds)||runtime.bypassedFreeIds.length>100||new Set(runtime.bypassedFreeIds).size!==runtime.bypassedFreeIds.length||runtime.bypassedFreeIds.some((id:unknown)=>typeof id!=='string'||!/^free:[A-Za-z0-9_-]{1,100}$/.test(id))))return null;
    return {schema:1,tripId:runtime.tripId,dayId:runtime.dayId,date:runtime.date,timezone:runtime.timezone,phase:runtime.phase,targetId:runtime.targetId,placeId:runtime.placeId,since:runtime.since,leaveAt:runtime.leaveAt,updatedAt:runtime.updatedAt,...(runtime.originArrivedAt!==undefined?{originArrivedAt:runtime.originArrivedAt}:{}),...(runtime.bypassedFreeIds?{bypassedFreeIds:runtime.bypassedFreeIds}:{})};
  }catch{return null;}
}
export function serializeTodayRuntime(runtime:TodayRuntime,identity:TodayIdentity):string {
  const {schema,tripId,dayId,date,timezone,phase,targetId,placeId,since,leaveAt,updatedAt,originArrivedAt,bypassedFreeIds}=runtime;
  return JSON.stringify({ownerId:identity.ownerId,scope:identity.scope,runtime:{schema,tripId,dayId,date,timezone,phase,targetId,placeId,since,leaveAt,updatedAt,...(originArrivedAt!==undefined?{originArrivedAt}:{}),...(bypassedFreeIds?{bypassedFreeIds}:{})}});
}
