import type {Trip} from '../model';
import {canonicalCloudTrip,validMutationId} from '../cloud/codec';
import type {MergeConflict,SharedMutation,SharedTrip} from './types';

export interface SharedRecord {
  base:SharedTrip;
  draft:Trip;
  pending:SharedMutation|null;
  remote:SharedTrip|null;
  conflicts:MergeConflict[];
  revoked:boolean;
  desiredDeleted:boolean;
  undo:{before:Trip;after:Trip}|null;
  /** Two local tabs may conflict before either draft reaches the server. */
  peerBase?:Trip;
  serverRemote?:SharedTrip|null;
}
export interface CollaborationData {version:1;key:string;records:Record<string,SharedRecord>}
export interface CollaborationStore {
  read(key:string):Promise<CollaborationData|null>;
  update(key:string,change:(value:CollaborationData|null)=>CollaborationData):Promise<CollaborationData>;
}
export const collaborationKey=(actorId:string)=>`collaboration:${actorId}`;
export const emptyCollaboration=(key:string):CollaborationData=>({version:1,key,records:{}});
export const newSharedRecord=(row:SharedTrip):SharedRecord=>({base:structuredClone(row),draft:structuredClone(row.trip),pending:null,remote:null,conflicts:[],revoked:false,desiredDeleted:!!row.deletedAt,undo:null});
function validate(data:CollaborationData|null,key:string):CollaborationData|null {
  if(data===null)return null;
  const fail=()=>{throw new Error('Shared trip storage could not be opened safely. Keep this browser data for recovery.');};
  if(data.version!==1||data.key!==key||!data.records||typeof data.records!=='object'||Array.isArray(data.records))fail();
  for(const [id,record] of Object.entries(data.records)) {
    if(!validMutationId(id)||record.base.cloudId!==id||record.draft.id!==record.base.trip.id||!Number.isSafeInteger(record.base.revision)||record.base.revision<1
      ||typeof record.revoked!=='boolean'||typeof record.desiredDeleted!=='boolean'||!Array.isArray(record.conflicts))fail();
    canonicalCloudTrip(record.draft);canonicalCloudTrip(record.base.trip);
    if(record.pending && (record.pending.cloudId!==id||!validMutationId(record.pending.mutationId)||record.pending.sourceTripId!==record.base.sourceTripId))fail();
    if(record.pending?.trip)canonicalCloudTrip(record.pending.trip);
  }
  return data;
}
export function createIndexedCollaborationStore(factory:IDBFactory|undefined=globalThis.indexedDB):CollaborationStore {
  let opened:Promise<IDBDatabase>|null=null;
  const open=()=>opened??=new Promise<IDBDatabase>((resolve,reject)=>{
    if(!factory){reject(new Error('Allow browser storage to save shared trip drafts.'));return;}
    const request=factory.open('daytrail.collaboration',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('accounts',{keyPath:'key'});
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();opened=null;};resolve(request.result);};
    request.onerror=()=>{opened=null;reject(request.error||new Error('Could not open shared trip storage.'));};
    request.onblocked=()=>{opened=null;reject(new Error('Close older Daytrail tabs and retry.'));};
  });
  return {
    async read(key){const db=await open();return new Promise((resolve,reject)=>{
      const tx=db.transaction('accounts','readonly'),request=tx.objectStore('accounts').get(key);
      request.onsuccess=()=>{try{resolve(validate(request.result??null,key));}catch(error){reject(error);}};
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });},
    async update(key,change){const db=await open();return new Promise((resolve,reject)=>{
      let tx:IDBTransaction;try{tx=db.transaction('accounts','readwrite',{durability:'strict'});}catch{tx=db.transaction('accounts','readwrite');}
      const store=tx.objectStore('accounts'),request=store.get(key);let next:CollaborationData;
      request.onsuccess=()=>{try{next=validate(change(validate(request.result??null,key)),key)!;store.put(next);}catch(error){reject(error);tx.abort();}};
      tx.oncomplete=()=>resolve(structuredClone(next));tx.onabort=()=>reject(tx.error||new Error('Shared changes could not be saved on this device.'));
      tx.onerror=()=>reject(tx.error||new Error('There is not enough device storage for this draft.'));
    });},
  };
}
export function createMemoryCollaborationStore():CollaborationStore {
  const data=new Map<string,CollaborationData>();let queue=Promise.resolve();
  return {async read(key){await queue;return structuredClone(validate(data.get(key)??null,key));},update(key,change){
    const result=queue.then(()=>{const next=validate(change(structuredClone(validate(data.get(key)??null,key))),key)!;data.set(key,structuredClone(next));return structuredClone(next);});
    queue=result.then(()=>{},()=>{});return result;
  }};
}
