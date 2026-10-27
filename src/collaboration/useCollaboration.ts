import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {getBrowserSupabaseClient} from '../auth/browser';
import {createCollaborationRemote} from './remote';
import {createCollaborationController} from './controller';
import {createIndexedCollaborationStore} from './storage';

export function useCollaboration(options:{actorId:string|null;authReady:boolean;authOffline?:boolean;activeTripId?:string|null}) {
  const [controller]=useState(()=>createCollaborationController({store:createIndexedCollaborationStore()}));
  const remote=useMemo(()=>{const client=options.actorId&&options.authReady&&!options.authOffline?getBrowserSupabaseClient():null;
    return client&&options.actorId?createCollaborationRemote(client,options.actorId):null;
  },[options.actorId,options.authReady,options.authOffline]);
  const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(()=>{void controller.setIdentity(options.actorId,remote,options.authReady,options.authOffline);return ()=>controller.dispose();},[controller,options.actorId,options.authReady,options.authOffline,remote]);
  useEffect(()=>controller.setScope(options.activeTripId??null),[controller,options.activeTripId]);
  const switching=snapshot.actorId!==(options.authReady?options.actorId:null);
  const safe=switching?{...snapshot,actorId:options.authReady?options.actorId:null,trips:[],trash:[],metadataById:{},statusById:{},conflicts:[],recoveryDrafts:[],ready:false,pendingCount:0,acknowledgedCount:0,canUndo:false,error:null}:snapshot;
  return {...safe,remote,changeTrip:controller.changeTrip,adjustActivityDuration:controller.adjustActivityDuration,undo:controller.undo,setEditing:controller.setEditing,setScope:controller.setScope,
    refresh:controller.refresh,retry:controller.retry,enable:controller.enable,resolveConflict:controller.resolveConflict,
    deleteTrip:controller.deleteTrip,restore:controller.restore,prepareSignOut:controller.prepareSignOut};
}
