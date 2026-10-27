export interface OfflineManifest {version:1;key:string;ownerId:string|null;scope:string;tripId:string;fingerprint:string;savedAt:string;bytes:number;tripBytes?:number;missing:string[]}
export const offlineKey=(ownerId:string|null,scope:string,tripId:string)=>JSON.stringify([scope,ownerId,tripId]);
function valid(value:unknown,key:string):OfflineManifest|null {
  if(value==null)return null;const v=value as OfflineManifest;
  if(v.version!==1||v.key!==key||typeof v.tripId!=='string'||typeof v.scope!=='string'||(v.ownerId!==null&&typeof v.ownerId!=='string')||typeof v.fingerprint!=='string'||!Number.isFinite(Date.parse(v.savedAt))||!Number.isSafeInteger(v.bytes)||v.bytes<0||(v.tripBytes!==undefined&&(!Number.isSafeInteger(v.tripBytes)||v.tripBytes<0))||!Array.isArray(v.missing)||v.missing.some(x=>typeof x!=='string'))throw new Error('Offline readiness data could not be opened. Your itinerary and queued changes are unchanged.');
  return v;
}
export interface OfflineStore {read(key:string):Promise<OfflineManifest|null>;write(value:OfflineManifest):Promise<void>;remove(key:string):Promise<void>}
export function createOfflineStore(factory:IDBFactory|undefined=globalThis.indexedDB):OfflineStore {
  let opened:Promise<IDBDatabase>|null=null;
  const open=()=>opened??=new Promise<IDBDatabase>((resolve,reject)=>{if(!factory){reject(new Error('Device storage is unavailable. Allow site storage before saving offline.'));return;}const request=factory.open('daytrail.offline',1);request.onupgradeneeded=()=>request.result.createObjectStore('manifests',{keyPath:'key'});request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opened=null;};resolve(db);};request.onerror=()=>{opened=null;reject(new Error('Offline storage could not be opened.'));};request.onblocked=()=>{opened=null;reject(new Error('Close older Daytrail tabs and retry offline preparation.'));};});
  async function access<T>(mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const db=await open();return new Promise((resolve,reject)=>{let tx:IDBTransaction;try{tx=db.transaction('manifests',mode,{durability:'strict'});}catch{tx=db.transaction('manifests',mode);}const request=action(tx.objectStore('manifests'));let value:T;request.onsuccess=()=>{value=request.result;};tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(new Error('Offline preparation could not be saved. Free device storage and retry; existing trips and queued changes are unchanged.'));});}
  return {read:async key=>valid(await access('readonly',store=>store.get(key)),key),write:async value=>{valid(value,value.key);await access('readwrite',store=>store.put(value));},remove:async key=>{await access('readwrite',store=>store.delete(key));}};
}
