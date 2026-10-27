import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {Trip} from '../model';
import {createIndexedWorkspaceStore} from '../cloud/storage';
import {createIndexedCollaborationStore} from '../collaboration/storage';
import {useConnectivity} from './connectivity';
import {offlineFingerprint,offlineTripDocument,offlineTripGaps} from './readiness';
import {createOfflineStore,offlineKey,type OfflineManifest} from './storage';
import {prepareOfflineShell,shellStore} from './pwa';
import {saveOfflineProfile} from './profile';
export interface OfflineReadiness {status:'not-saved'|'preparing'|'ready'|'partial'|'error';savedAt:string|null;bytes:number;missing:string[];error:string|null}
export interface OfflineOptions {ownerId:string|null;scope:string;trip:Trip;durableReady:boolean;profile?:{id:string;email?:string;fullName?:string}|null}
const stores={offline:createOfflineStore(),workspace:createIndexedWorkspaceStore(),collaboration:createIndexedCollaborationStore()};
async function canonicalTrip(options:OfflineOptions):Promise<Trip|null>{
  const workspace=await stores.workspace.read(options.scope==='guest'?'guest':`account:${options.ownerId}`);
  const direct=workspace?.records[options.trip.id];if(direct&&!direct.deletedAt&&!direct.archived)return direct.trip;
  if(options.ownerId){const shared=await stores.collaboration.read(`collaboration:${options.ownerId}`);const row=Object.values(shared?.records||{}).find(record=>record.draft.id===options.trip.id&&!record.revoked&&!record.desiredDeleted);if(row)return row.base.role==='viewer'?row.base.trip:row.draft;}
  return null;
}
export function useOffline(options:OfflineOptions){
  const online=useConnectivity(),shell=useSyncExternalStore(shellStore.subscribe,shellStore.getSnapshot,shellStore.getSnapshot);
  const effective={...options,ownerId:options.scope==='guest'?null:options.ownerId,profile:options.scope==='guest'?null:options.profile};
  const key=offlineKey(effective.ownerId,effective.scope,effective.trip.id),latest=useRef(effective);latest.current=effective;
  const operation=useRef(0);
  const generation=useRef({key,n:0});if(generation.current.key!==key)generation.current={key,n:generation.current.n+1};
  const [state,setState]=useState<{key:string;manifest:OfflineManifest|null;busy:boolean;error:string|null;valid:boolean}>({key,manifest:null,busy:false,error:null,valid:false});
  const document=useMemo(()=>offlineTripDocument(options.trip),[options.trip]);
  const refresh=useCallback(async()=>{if(generation.current.key!==key)return;const n=generation.current.n,op=++operation.current,current=latest.current;try{let manifest=await stores.offline.read(key);const saved=manifest?await canonicalTrip(current):null;
    const savedFingerprint=saved?await offlineFingerprint(saved):null,currentFingerprint=await offlineFingerprint(current.trip);
    if(manifest&&saved&&savedFingerprint===currentFingerprint&&manifest.fingerprint!==savedFingerprint&&current.durableReady&&n===generation.current.n&&op===operation.current){
      // Refresh only the manifest of already durable authored data. The trip is never duplicated.
      const tripBytes=new TextEncoder().encode(offlineTripDocument(saved)).byteLength;manifest={...manifest,fingerprint:savedFingerprint!,savedAt:new Date().toISOString(),bytes:manifest.bytes+tripBytes-(manifest.tripBytes??tripBytes),tripBytes,missing:offlineTripGaps(saved)};await stores.offline.write(manifest);
    }
    const valid=!!saved&&savedFingerprint===currentFingerprint&&manifest?.fingerprint===savedFingerprint;if(n===generation.current.n&&op===operation.current)setState(previous=>({key,manifest,busy:false,error:previous.key===key?previous.error:null,valid}));
  }catch(error){if(n===generation.current.n&&op===operation.current)setState(value=>({...value,key,busy:false,error:error instanceof Error?error.message:'Offline readiness could not be checked.',valid:false}));}},[key]);
  useEffect(()=>{if(state.key!==key||!state.busy)void refresh();},[refresh,document,options.durableReady,state.busy,key,state.key]);
  const prepareTrip=useCallback(async()=>{if(generation.current.key!==key)throw new Error('The selected account or trip changed. Open offline preparation again.');const n=generation.current.n,op=++operation.current,current=latest.current;if(!current.durableReady)throw new Error('Wait until your latest itinerary is saved on this device.');
    setState(value=>({...value,key,busy:true,error:null}));try{
      const saved=await canonicalTrip(current);if(!saved||await offlineFingerprint(saved)!==await offlineFingerprint(current.trip))throw new Error('Your latest itinerary has not finished saving. Try again shortly.');
      let shellBytes=0,shellError:string|null=null;try{shellBytes=await prepareOfflineShell();}catch(error){shellError=error instanceof Error?error.message:'Offline app launch is not ready.';}
      if(n!==generation.current.n||op!==operation.current)return;
      if(shellError)throw new Error(shellError);
      const confirmed=await canonicalTrip(current);if(!confirmed||await offlineFingerprint(confirmed)!==await offlineFingerprint(current.trip))throw new Error('The itinerary changed while preparing. Save it again for offline use.');
      const manifest:OfflineManifest={version:1,key,ownerId:current.ownerId,scope:current.scope,tripId:current.trip.id,fingerprint:await offlineFingerprint(confirmed),savedAt:new Date().toISOString(),bytes:new TextEncoder().encode(offlineTripDocument(confirmed)).byteLength+shellBytes,tripBytes:new TextEncoder().encode(offlineTripDocument(confirmed)).byteLength,missing:offlineTripGaps(confirmed)};
      if(n!==generation.current.n||op!==operation.current)return;
      if(current.ownerId&&current.profile?.id===current.ownerId)saveOfflineProfile({id:current.ownerId,email:current.profile.email,name:current.profile.fullName});
      await stores.offline.write(manifest);
      if(n!==generation.current.n||op!==operation.current)return;
      if(n===generation.current.n&&op===operation.current)setState({key,manifest,busy:false,error:shellError,valid:true});
    }catch(error){if(n===generation.current.n&&op===operation.current)setState(value=>({...value,busy:false,error:error instanceof Error?error.message:'Offline preparation failed.'}));throw error;}},[key]);
  const removeTripResources=useCallback(async()=>{if(generation.current.key!==key)return;const n=generation.current.n,op=++operation.current;await stores.offline.remove(key);if(n===generation.current.n&&op===operation.current)setState({key,manifest:null,busy:false,error:null,valid:false});},[key]);
  const visible=state.key===key?state:null;
  const readiness:OfflineReadiness={status:visible?.busy?'preparing':visible?.error?(visible.manifest?'partial':'error'):!visible?.manifest?'not-saved':visible.valid&&shell.ready&&visible.manifest.missing.length===0?'ready':'partial',savedAt:visible?.manifest?.savedAt||null,bytes:visible?.manifest?.bytes||0,missing:visible?.manifest?[...visible.manifest.missing,...(!visible.valid?['This trip changed since preparation. Save for offline again to refresh its readiness.']:[]),...(!shell.ready?['Offline app launch is not ready in this browser.']:[])]:[],error:visible?.error||null};
  return {online,shell,readiness,busy:!!visible?.busy,error:visible?.error||null,prepareTrip,removeTripResources,refresh};
}
