import type {Trip} from '../model';
import {canonicalCloudTrip,validMutationId} from '../cloud/codec';
import {keepSavedStructure,mergeTrips,sameValue} from './merge';
import {collaborationKey,emptyCollaboration,newSharedRecord,type CollaborationData,type CollaborationStore,type SharedRecord} from './storage';
import {CollaborationError,type CollaborationConflict,type CollaborationRemote,type ConflictChoices,type SharedTrip,type SharedTripMetadata,type SharedMutation} from './types';

export type CollaborationStatus='synced'|'saving'|'offline'|'conflict'|'readonly'|'revoked';
export interface CollaborationSnapshot {
  actorId:string|null;ready:boolean;trips:Trip[];trash:Trip[];metadataById:Record<string,SharedTripMetadata>;
  statusById:Record<string,CollaborationStatus>;pendingCount:number;acknowledgedCount:number;error:string|null;conflicts:CollaborationConflict[];
  canUndo:boolean;remoteUpdatesPending:boolean;recoveryDrafts:Trip[];
}
interface Options {store:CollaborationStore;autoSync?:boolean;requestTimeoutMs?:number;uuid?:()=>string}
const dirty=(r:SharedRecord)=>!!r.pending||!sameValue(r.draft,r.base.trip)||r.desiredDeleted!==!!r.base.deletedAt;
const initial=(actorId:string|null=null):CollaborationSnapshot=>({actorId,ready:false,trips:[],trash:[],metadataById:{},statusById:{},pendingCount:0,acknowledgedCount:0,error:null,conflicts:[],canUndo:false,remoteUpdatesPending:false,recoveryDrafts:[]});

/** Account-scoped durable drafts. Issued requests stay immutable until an explicit
 * server success or revision conflict; network failures never mint another ID. */
export function createCollaborationController(options:Options) {
  let actorId:string|null=null,remote:CollaborationRemote|null=null,data:CollaborationData|null=null,snapshot=initial();
  let acknowledgedCount=0;
  let epoch=0,ready=false,editing=false,scope:string|null=null,offline=false,error:string|null=null;
  let syncing:Promise<void>|null=null,refreshing:Promise<void>|null=null,refreshAgain=false;
  let timer:ReturnType<typeof setInterval>|null=null,unsubscribe:(()=>void)|null=null,subscriptionKey='';
  const listeners=new Set<()=>void>();const uuid=options.uuid??(()=>crypto.randomUUID());
  const deferred=new Map<string,SharedTrip>();
  let broadcast:BroadcastChannel|null=null;
  const emit=()=>{
    const next=initial(actorId);next.ready=ready;next.error=error;next.acknowledgedCount=acknowledgedCount;next.remoteUpdatesPending=deferred.size>0;
    for(const record of Object.values(data?.records||{})) {
      const {trip:_,...meta}=record.base;const id=record.draft.id;
      next.metadataById[id]=meta;
      if(record.revoked){if(dirty(record))next.recoveryDrafts.push(record.draft);next.statusById[id]='revoked';continue;}
      if(record.base.role==='viewer'&&dirty(record))next.recoveryDrafts.push(record.draft);
      (record.desiredDeleted?next.trash:next.trips).push(record.base.role==='viewer'?record.base.trip:record.draft);
      const pending=dirty(record);if(pending)next.pendingCount++;
      next.statusById[id]=record.conflicts.length?'conflict':record.base.role==='viewer'?'readonly':pending?(offline?'offline':'saving'):'synced';
      if(record.conflicts.length&&record.remote)next.conflicts.push({tripId:id,cloudId:record.base.cloudId,fields:record.conflicts,remote:record.remote});
      if(record.undo&&record.base.role!=='viewer'&&(!scope||scope===id))next.canUndo=true;
    }
    snapshot=next;for(const listener of listeners)listener();updateSubscription();
  };
  const recordId=(tripId:string)=>Object.keys(data?.records||{}).find(id=>data!.records[id].draft.id===tripId);
  const update=async(change:(current:CollaborationData)=>void,expectedEpoch=epoch)=>{
    const actor=actorId;if(!actor||expectedEpoch!==epoch)return false;
    const key=collaborationKey(actor);
    let changed=false;
    const next=await options.store.update(key,value=>{const current=value??emptyCollaboration(key);const before=structuredClone(current);change(current);changed=!sameValue(before,current);return current;});
    if(expectedEpoch!==epoch||actor!==actorId)return false;
    data=next;emit();if(changed)broadcast?.postMessage({actor});return true;
  };
  function updateSubscription(){
    const row=scope?Object.values(data?.records||{}).find(record=>record.draft.id===scope&&!record.revoked)?.base:null;
    const key=row&&remote?.subscribe?`${actorId}:${row.cloudId}:${row.channelEpoch}`:'';
    if(key===subscriptionKey)return;
    unsubscribe?.();unsubscribe=null;subscriptionKey=key;
    if(row&&key)unsubscribe=remote!.subscribe!(row,()=>{void refresh();});
  }
  async function timed<T>(promise:Promise<T>):Promise<T>{
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new CollaborationError('unavailable','The connection timed out. Your draft is safe and will retry.')),options.requestTimeoutMs??15000);})]);}
    finally{if(timeout)clearTimeout(timeout);}
  }
  function acceptRow(record:SharedRecord,row:SharedTrip){
    if(row.revision<record.base.revision)return;
    if(row.role==='viewer'){
      if(!dirty(record))record.draft=row.trip;
      record.base=row;record.pending=null;record.remote=null;record.conflicts=[];record.revoked=false;record.desiredDeleted=!!row.deletedAt;delete record.peerBase;delete record.serverRemote;return;
    }
    if(record.peerBase){record.serverRemote=row;record.base={...record.base,role:row.role,channelEpoch:row.channelEpoch};return;}
    if(row.deletedAt&&!record.desiredDeleted&&dirty(record)){
      record.remote=row;record.conflicts=[{path:'/$deleted',label:'Trip moved to Trash',kind:'delete',base:false,local:false,remote:true}];return;
    }
    if(record.pending){record.remote=row;return;}
    const merged=safeMerge(record.base.trip,record.draft,row.trip);
    record.remote=merged.conflicts.length?row:null;record.conflicts=merged.conflicts;
    if(!merged.conflicts.length){record.base=row;record.draft=canonicalCloudTrip(merged.trip);record.desiredDeleted=!!row.deletedAt;}
    // Permission changes always take effect, including when a conflict is open.
    record.base={...record.base,role:row.role,channelEpoch:row.channelEpoch};record.revoked=false;
  }
  function safeMerge(base:Trip,local:Trip,latest:Trip,choices:ConflictChoices={}){
    const merged=mergeTrips(base,local,latest,choices);
    try{canonicalCloudTrip(merged.trip);return merged;}catch{
      return {trip:structuredClone(local),conflicts:[...merged.conflicts,{path:'/$structure',label:'Related flight, stay or day changes',kind:'structure' as const,base:null,local:null,remote:null}]};
    }
  }
  async function refresh():Promise<void>{
    if(!actorId||!remote||typeof navigator!=='undefined'&&navigator.onLine===false)return;
    if(refreshing){refreshAgain=true;return refreshing;}
    const token=epoch,api=remote;
    refreshing=(async()=>{try{
      const rows=await timed(api.list());if(token!==epoch)return;offline=false;error=null;
      await update(current=>{
        const present=new Set(rows.map(row=>row.cloudId));
        for(const record of Object.values(current.records))if(!present.has(record.base.cloudId)){
          deferred.delete(record.base.cloudId);
          if(!dirty(record)){delete current.records[record.base.cloudId];continue;}
          record.revoked=true;record.pending=null;record.remote=null;record.conflicts=[];
        }
        for(const row of rows){const record=current.records[row.cloudId];
          if(!record){current.records[row.cloudId]=newSharedRecord(row);continue;}
          if(row.role!==record.base.role||row.channelEpoch!==record.base.channelEpoch||row.deletedAt!==record.base.deletedAt)deferred.delete(row.cloudId);
          if(editing&&scope===row.trip.id&&row.role===record.base.role&&row.channelEpoch===record.base.channelEpoch&&row.deletedAt===record.base.deletedAt&&row.revision>record.base.revision){deferred.set(row.cloudId,row);continue;}
          acceptRow(record,row);
        }
      },token);
      ready=true;emit();if(options.autoSync!==false)void sync();
    }catch(caught){if(token!==epoch)return;offline=true;error=caught instanceof Error?caught.message:'Could not refresh shared trips.';ready=true;emit();}
    finally{if(token===epoch){refreshing=null;if(refreshAgain){refreshAgain=false;void refresh();}}}})();
    return refreshing;
  }
  async function sync():Promise<void>{
    if(syncing)return syncing;if(!actorId||!remote||typeof navigator!=='undefined'&&navigator.onLine===false)return;
    const token=epoch,api=remote;
    syncing=(async()=>{
      for(let pass=0;pass<100&&token===epoch;pass++){
        let outgoing:SharedMutation|null=null;
        try{await update(current=>{
          const record=Object.values(current.records).find(r=>!r.revoked&&(!r.conflicts.length||r.pending)&&r.base.role!=='viewer'&&dirty(r));
          if(!record)return;
          if(!record.pending){const operation=!record.base.deletedAt&&!sameValue(record.draft,record.base.trip)?'save':record.desiredDeleted!==!!record.base.deletedAt?(record.desiredDeleted?'delete':'restore'):'save';
            record.pending={cloudId:record.base.cloudId,sourceTripId:record.base.sourceTripId,expectedRevision:record.base.revision,mutationId:uuid(),operation,...(operation==='save'?{trip:structuredClone(record.draft)}:{})};}
          outgoing=structuredClone(record.pending);
        },token);}catch(caught){error=caught instanceof Error?caught.message:'Could not store this change.';emit();break;}
        if(!outgoing||token!==epoch)break;
        const request=outgoing as SharedMutation;
        try{
          const result=await timed(api.mutate(request));if(token!==epoch)return;offline=false;error=null;let accepted=false;
          await update(current=>{const record=current.records[request.cloudId];if(!record||record.pending?.mutationId!==request.mutationId)return;accepted=true;
            const desiredBefore=record.desiredDeleted,baseDeleted=!!record.base.deletedAt;
            if(record.peerBase){record.pending=null;record.serverRemote=result.trip;return;}
            if(record.conflicts.length){
              record.pending=null;record.remote=result.trip;
              const reviewed=safeMerge(record.base.trip,record.draft,result.trip.trip);
              if(reviewed.conflicts.length)record.conflicts=reviewed.conflicts;
              return;
            }
            const merged=safeMerge(request.trip??record.base.trip,record.draft,result.trip.trip);
            record.pending=null;record.remote=merged.conflicts.length?result.trip:null;record.conflicts=merged.conflicts;
            if(result.trip.deletedAt&&request.operation==='save'&&request.trip&&!sameValue(request.trip,record.draft)){
              record.remote=result.trip;record.conflicts=[{path:'/$deleted',label:'Trip moved to Trash',kind:'delete',base:false,local:false,remote:true}];return;
            }
            if(merged.conflicts.length)record.base={...result.trip,trip:request.trip??record.base.trip};
            else {record.base=result.trip;record.draft=canonicalCloudTrip(merged.trip);}
            if(request.operation==='save'?desiredBefore===baseDeleted:desiredBefore===(request.operation==='delete'))record.desiredDeleted=!!result.trip.deletedAt;
          },token);if(accepted&&token===epoch){acknowledgedCount++;emit();}
        }catch(caught){if(token!==epoch)return;
          const problem=caught instanceof CollaborationError?caught:new CollaborationError('unavailable',caught instanceof Error?caught.message:'Could not sync this trip.');
          if(problem.code==='conflict'&&problem.current){
            await update(current=>{const record=current.records[request.cloudId];if(!record||record.pending?.mutationId!==request.mutationId)return;
              record.pending=null;
              if(record.peerBase){record.serverRemote=problem.current!;return;}
              if(request.operation!=='save'){
                record.remote=problem.current!;record.conflicts=[{path:'/$deleted',label:request.operation==='delete'?'Delete changed trip':'Restore changed trip',kind:'delete',base:!!record.base.deletedAt,local:record.desiredDeleted,remote:!!problem.current!.deletedAt}];
              }else acceptRow(record,problem.current!);
            },token);continue;
          }
          offline=problem.code==='unavailable';error=problem.message;
          if(problem.code==='revoked')await update(current=>{const record=current.records[request.cloudId];if(record){record.revoked=true;record.pending=null;}},token);
          emit();break;
        }
      }
    })().finally(()=>{if(token===epoch)syncing=null;});
    return syncing;
  }
  async function changeTrip(next:Trip):Promise<boolean>{
    const id=recordId(next.id),shown=id&&data?.records[id];
    if(!id||!shown||shown.revoked||shown.base.role==='viewer'||shown.conflicts.length||shown.desiredDeleted)return false;
    let value:Trip;try{value=canonicalCloudTrip(next);}catch(caught){error=caught instanceof Error?caught.message:'Invalid shared trip.';emit();return false;}
    const displayed=structuredClone(shown.draft);let accepted=false;
    try{await update(current=>{const record=current.records[id];if(!record||record.revoked||record.base.role==='viewer'||record.conflicts.length)return;
      const merged=safeMerge(displayed,value,record.draft);
      if(merged.conflicts.length){record.remote={...record.base,trip:record.draft};record.conflicts=merged.conflicts;record.peerBase=displayed;record.serverRemote=null;record.draft=value;return;}
      record.undo={before:structuredClone(record.draft),after:structuredClone(merged.trip)};
      record.draft=canonicalCloudTrip(merged.trip);accepted=true;
    });}catch(caught){error=caught instanceof Error?caught.message:'Could not save this draft.';emit();return false;}
    if(accepted&&options.autoSync!==false)void sync();return accepted;
  }
  /** Apply a stepper delta to the latest durable draft, including taps queued before a render. */
  async function adjustActivityDuration(tripId:string,activityId:string,delta:number):Promise<boolean>{
    if(!ready||!actorId||!Number.isSafeInteger(delta)||delta===0)return false;
    const token=epoch,actor=actorId,id=recordId(tripId),shown=id&&data?.records[id];
    if(!id||!shown||shown.revoked||shown.base.role==='viewer'||shown.conflicts.length||shown.desiredDeleted)return false;
    let accepted=false,changed=false;
    try{
      const completed=await update(current=>{
        // The storage transaction may have waited behind another tab or an account switch.
        if(token!==epoch||actor!==actorId||!ready)return;
        const record=current.records[id];
        if(!record||record.draft.id!==tripId||record.revoked||record.base.role==='viewer'||record.conflicts.length||record.desiredDeleted)return;
        const draft=structuredClone(record.draft),item=draft.days.flatMap(day=>day.items).find(activity=>activity.aid===activityId);
        if(!item||item.departureForFlightId)return;
        const duration=Math.max(15,Math.min(1440,item.duration+delta));
        if(duration===item.duration){accepted=true;return;}
        item.duration=duration;
        const next=canonicalCloudTrip(draft);
        record.undo={before:structuredClone(record.draft),after:structuredClone(next)};
        record.draft=next;accepted=true;changed=true;
      },token);
      if(!completed||token!==epoch||actor!==actorId)return false;
    }catch(caught){
      if(token===epoch&&actor===actorId){error=caught instanceof Error?caught.message:'Could not save this draft.';emit();}
      return false;
    }
    if(changed&&options.autoSync!==false)void sync();return accepted;
  }
  async function resolveConflict(tripId:string,choices:ConflictChoices):Promise<boolean>{
    const id=recordId(tripId);if(!id)return false;let accepted=false;
    await update(current=>{const record=current.records[id];if(!record?.remote||record.revoked||record.base.role==='viewer')return;
      if(record.pending){error='The previous save is still being checked. Reconnect and retry before resolving this conflict.';return;}
      if(record.conflicts.some(conflict=>!choices[conflict.path]))return;
      if(record.conflicts.some(conflict=>conflict.path==='/$structure')){
        if(choices['/$structure']==='local'){error='The related flight, stay or day changes need to be made again against the latest itinerary. Keep the saved structure first.';return;}
        record.draft=keepSavedStructure(record.base.trip,record.draft,record.remote.trip,choices,value=>{try{canonicalCloudTrip(value);return true;}catch{return false;}});
        record.base=record.remote;record.remote=null;record.conflicts=[];record.pending=null;delete record.peerBase;delete record.serverRemote;accepted=true;return;
      }
      if(record.conflicts.some(conflict=>conflict.path==='/days/$structure')&&choices['/days/$structure']==='local'){
        error='This stop moved between days. Keep the saved structure, then make your move again against the latest itinerary.';return;
      }
      if(record.conflicts.some(conflict=>conflict.path==='/$deleted')){
        if(choices['/$deleted']==='remote'){record.draft=record.remote.trip;record.desiredDeleted=!!record.remote.deletedAt;}
        record.base=record.remote;record.remote=null;record.conflicts=[];record.pending=null;accepted=true;return;
      }
      const merged=mergeTrips(record.peerBase??record.base.trip,record.draft,record.remote.trip,choices);
      if(merged.conflicts.length){record.conflicts=merged.conflicts;return;}
      try{record.draft=canonicalCloudTrip(merged.trip);}catch{error='These choices would break a flight, stay or day link. Keep the saved values and reapply the related change together.';return;}
      if(record.peerBase){
        const latest=record.serverRemote??record.base;delete record.peerBase;delete record.serverRemote;
        const combined=safeMerge(record.base.trip,record.draft,latest.trip);
        if(combined.conflicts.length){record.remote=latest;record.conflicts=combined.conflicts;return;}
        record.draft=canonicalCloudTrip(combined.trip);record.base=latest;record.remote=null;record.conflicts=[];record.pending=null;accepted=true;return;
      }
      record.base=record.remote;record.remote=null;record.conflicts=[];record.pending=null;accepted=true;
    });if(accepted&&options.autoSync!==false)void sync();return accepted;
  }
  async function undo(tripId:string|null=scope):Promise<boolean>{
    const id=tripId?recordId(tripId):Object.keys(data?.records||{}).find(key=>data!.records[key].undo);if(!id)return false;
    const record=data!.records[id];if(!record.undo||record.revoked||record.base.role==='viewer')return false;
    const merged=mergeTrips(record.undo.after,record.undo.before,record.draft);
    if(merged.conflicts.length){error='Your earlier change was edited again. Review the current itinerary before undoing it.';emit();return false;}
    const changed=await changeTrip(merged.trip);if(changed)await update(current=>{current.records[id].undo=null;});return changed;
  }
  async function setDeleted(tripId:string,value:boolean):Promise<boolean>{
    const id=recordId(tripId);if(!id)return false;let accepted=false;
    await update(current=>{const record=current.records[id];if(!record||record.revoked||record.base.role!=='owner'||record.conflicts.length)return;record.desiredDeleted=value;accepted=true;});
    if(accepted&&options.autoSync!==false)void sync();return accepted;
  }
  const onOnline=()=>{offline=false;void refresh().then(()=>sync());};
  const onOffline=()=>{offline=true;emit();};
  const onVisibility=()=>{if(typeof document==='undefined'||document.visibilityState==='visible')onFocus();};
  const onFocus=()=>{void refresh();};
  function stop(){if(timer)clearInterval(timer);timer=null;unsubscribe?.();unsubscribe=null;subscriptionKey='';broadcast?.close();broadcast=null;
    if(typeof window!=='undefined'){window.removeEventListener('online',onOnline);window.removeEventListener('focus',onFocus);window.removeEventListener('offline',onOffline);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',onVisibility);}}
  return {
    subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},getSnapshot:()=>snapshot,
    async setIdentity(nextActor:string|null,api:CollaborationRemote|null,authReady=true,authOffline=false){
      if(actorId!==(authReady?nextActor:null))acknowledgedCount=0;
      stop();const token=++epoch;actorId=authReady?nextActor:null;remote=authReady?api:null;data=null;ready=!actorId;error=null;offline=authOffline||typeof navigator!=='undefined'&&navigator.onLine===false;editing=false;deferred.clear();syncing=null;refreshing=null;refreshAgain=false;emit();
      if(!actorId)return;if(!validMutationId(actorId)){error='Sign in to open shared trips.';emit();return;}
      try{const loaded=await options.store.read(collaborationKey(actorId));if(token!==epoch)return;data=loaded??emptyCollaboration(collaborationKey(actorId));ready=true;emit();}
      catch(caught){error=caught instanceof Error?caught.message:'Shared drafts could not be opened.';emit();return;}
      if(options.autoSync!==false){
        if(typeof window!=='undefined'){window.addEventListener('online',onOnline);window.addEventListener('focus',onFocus);window.addEventListener('offline',onOffline);if(typeof document!=='undefined')document.addEventListener('visibilitychange',onVisibility);}
        if(typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'){broadcast=new BroadcastChannel(`daytrail-collaboration-${actorId}`);broadcast.onmessage=()=>{void options.store.read(collaborationKey(actorId!)).then(value=>{if(token===epoch&&value){data=value;emit();void sync();}});};}
        timer=setInterval(()=>{if(typeof document==='undefined'||document.visibilityState==='visible')void refresh();},30000);void refresh();
      }
    },
    async enable(sourceTripId:string,expectedRevision:number){if(!remote)return null;const token=epoch;try{const row=await remote.enable(sourceTripId,expectedRevision);if(token!==epoch)return null;
      await update(current=>{current.records[row.cloudId]=newSharedRecord(row);},token);return row.trip;
    }catch(caught){error=caught instanceof Error?caught.message:'Could not enable sharing.';emit();return null;}},
    changeTrip,adjustActivityDuration,resolveConflict,undo,refresh,sync,retry:async()=>{await refresh();await sync();},
    deleteTrip:(id:string)=>setDeleted(id,true),restore:(id:string)=>setDeleted(id,false),
    setScope(tripId:string|null){scope=tripId;emit();},
    setEditing(value:boolean){editing=value;if(!value&&deferred.size){const rows=[...deferred.values()];deferred.clear();void update(current=>{for(const row of rows){const record=current.records[row.cloudId];if(record&&!record.revoked&&record.base.role===row.role&&record.base.channelEpoch===row.channelEpoch)acceptRow(record,row);}}).then(()=>{if(options.autoSync!==false)void sync();}).catch(caught=>{error=caught instanceof Error?caught.message:'Could not update this trip.';emit();});}},
    async prepareSignOut(keepDrafts=false){if(keepDrafts)return true;await sync();return !Object.values(data?.records||{}).some(record=>dirty(record)&&!record.revoked);},
    dispose(){stop();epoch++;remote=null;},
  };
}
