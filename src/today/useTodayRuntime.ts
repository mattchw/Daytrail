import type {TodayPersistence} from './persistence';
import {useEffect,useRef,useState} from 'react';
import type {Place,Trip} from '../model';
import {targetState,type TravelMark,type TravelMarks} from '../travel/model';
import {todayPlanSignature,todayStateSignature,type TodayOptions,type TodayProjection,type TodayRuntime} from './model';
import {planTodayAction} from './actions';
import {parseTodayRuntime,serializeTodayRuntime,todayStorageKey,type TodayIdentity} from './storage';

interface Options {persistence?:TodayPersistence;ownerId:string|null;scope:'guest'|'account';trip:Trip;dayIndex:number;places:Record<string,Place>;marks:TravelMarks;hoursByPlace?:TodayOptions['hoursByPlace'];onSetState:(targetId:string,state:TravelMark)=>Promise<void>;enabled:boolean}
interface UndoEntry {runtime:TodayRuntime|null;targetId?:string;previous?:TravelMark;expected?:TravelMark;signature:string;stateSignature:string}
export function useTodayRuntime(options:Options){
  const identity:TodayIdentity={ownerId:options.scope==='guest'?null:options.ownerId,scope:options.scope,tripId:options.trip.id,dayId:options.trip.days[options.dayIndex].id};
  const key=todayStorageKey(identity),storedRaw=useRef<string|null>(null),latest=useRef(options);latest.current=options;
  const activeKey=useRef(key);activeKey.current=key;
  const [state,setState]=useState<{key:string;runtime:TodayRuntime|null;ready:boolean;error:string|null}>({key,runtime:null,ready:false,error:null});
  const [busy,setBusy]=useState(false),busyRef=useRef(false),undoRef=useRef<UndoEntry|null>(null),[canUndo,setCanUndo]=useState(false);
  const stateRef=useRef(state);stateRef.current=state;
  // Invalidate pending work synchronously, including an account/day switch away
  // and back before an awaited progress write settles.
  const context=useRef({key,enabled:options.enabled,generation:0});
  if(context.current.key!==key||context.current.enabled!==options.enabled){
    context.current={key,enabled:options.enabled,generation:context.current.generation+1};
    busyRef.current=false;undoRef.current=null;
  }
  const renderGeneration=context.current.generation;
  useEffect(()=>()=>{context.current.generation++;busyRef.current=false;},[]);
  const validOperation=(actionKey:string,generation:number)=>activeKey.current===actionKey&&context.current.generation===generation&&latest.current.enabled;
  const progressSignature=(current:Options,runtime:TodayRuntime|null,mark?:{targetId:string;state:TravelMark})=>todayStateSignature({...current,runtime,marks:mark?{...current.marks,[mark.targetId]:mark.state}:current.marks});
  useEffect(()=>{
    let cancelled=false;
    undoRef.current=null;setCanUndo(false);busyRef.current=false;setBusy(false);storedRaw.current=null;
    if(options.persistence){
      setState({key,runtime:null,ready:false,error:null});
      void (async()=>{
        let raw=await options.persistence!.read(identity.dayId);
        if(cancelled)return;
        if(!raw){let legacy:string|null=null;try{legacy=localStorage.getItem(key);}catch{/* An unavailable legacy store does not block IndexedDB. */}
          if(legacy&&parseTodayRuntime(legacy,identity)){await options.persistence!.commit({dayId:identity.dayId,previous:null,next:legacy});raw=legacy;try{localStorage.removeItem(key);}catch{/* Already migrated durably. */}}
        }
        if(cancelled)return;storedRaw.current=raw;setState({key,runtime:parseTodayRuntime(raw,identity),ready:true,error:null});
      })().catch(error=>{if(!cancelled)setState({key,runtime:null,ready:false,error:error instanceof Error?error.message:'Today timing could not be opened.'});});
    }else{
      let runtime:TodayRuntime|null=null,error:string|null=null;
      try{const raw=localStorage.getItem(key);storedRaw.current=raw;runtime=parseTodayRuntime(raw,identity);}catch{error='Live timing is available for this session; this browser could not save it.';}
      setState({key,runtime,ready:true,error});
    }
    return()=>{cancelled=true;};
    // The storage key contains every identity input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,options.persistence,!!options.persistence&&options.enabled]);
  const persist=(runtime:TodayRuntime|null,actionKey:string)=>{
    if(activeKey.current!==actionKey)return;
    let error:string|null=null;
    if(!latest.current.persistence)try{if(runtime)localStorage.setItem(actionKey,serializeTodayRuntime(runtime,identity));else localStorage.removeItem(actionKey);}catch{error='Live timing is available for this session; this browser could not save it.';}
    const next={key:actionKey,runtime,ready:true,error};stateRef.current=next;setState(next);
  };
  const act=async(projection:TodayProjection,kind:'leave'|'arrive'|'extend',minutes=15):Promise<void>=>{
    const current=latest.current,actionKey=activeKey.current,generation=context.current.generation,now=Date.now();
    if(key!==actionKey||renderGeneration!==generation||!current.enabled||busyRef.current||stateRef.current.key!==actionKey||!stateRef.current.ready||!projection.canAct)return;
    const result=planTodayAction({...current,runtime:stateRef.current.runtime,now},projection,kind,minutes),{signature,runtime,mark,previous:existing}=result;
    const beforeSignature=progressSignature(current,existing);
    busyRef.current=true;setBusy(true);
    try{
      if(current.persistence){const raw=serializeTodayRuntime(runtime,identity);await current.persistence.commit({dayId:identity.dayId,previous:storedRaw.current,next:raw,...(mark?{mark}: {})});if(validOperation(actionKey,generation))storedRaw.current=raw;}
      else if(mark)await current.onSetState(mark.targetId,mark.expected);
      if(!validOperation(actionKey,generation)||todayPlanSignature(latest.current.trip,latest.current.dayIndex)!==signature)return;
      // React may not have rendered our own mark yet. Accept either side of that
      // write, but never another progress change that happened while waiting.
      if(mark&&![mark.previous,mark.expected].includes(targetState(latest.current.marks,mark.targetId)))return;
      if(progressSignature(latest.current,stateRef.current.runtime,mark?{targetId:mark.targetId,state:mark.previous}:undefined)!==beforeSignature)return;
      const expectedSignature=progressSignature(current,runtime,mark?{targetId:mark.targetId,state:mark.expected}:undefined);
      undoRef.current={runtime:existing,signature,stateSignature:expectedSignature,...mark};setCanUndo(true);persist(runtime,actionKey);
    }catch(error){if(validOperation(actionKey,generation))setState(value=>({...value,error:error instanceof Error?error.message:'Could not update progress. Try again.'}));throw error;}
    finally{if(context.current.generation===generation){busyRef.current=false;setBusy(false);}}
  };
  const undo=async():Promise<void>=>{
    const previous=undoRef.current,current=latest.current,actionKey=activeKey.current,generation=context.current.generation;
    if(key!==actionKey||renderGeneration!==generation||!previous||!current.enabled||busyRef.current)return;
    if(previous.signature!==todayPlanSignature(current.trip,current.dayIndex)){undoRef.current=null;setCanUndo(false);return;}
    if(progressSignature(current,stateRef.current.runtime)!==previous.stateSignature){undoRef.current=null;setCanUndo(false);return;}
    busyRef.current=true;setBusy(true);
    try{
      if(current.persistence){const raw=previous.runtime?serializeTodayRuntime(previous.runtime,identity):null;await current.persistence.commit({dayId:identity.dayId,previous:storedRaw.current,next:raw,...(previous.targetId?{mark:{targetId:previous.targetId,previous:previous.expected!,expected:previous.previous!}}:{})});if(validOperation(actionKey,generation))storedRaw.current=raw;}
      else if(previous.targetId)await current.onSetState(previous.targetId,previous.previous!);
      if(!validOperation(actionKey,generation)||previous.signature!==todayPlanSignature(latest.current.trip,latest.current.dayIndex))return;
      if(previous.targetId&&![previous.previous,previous.expected].includes(targetState(latest.current.marks,previous.targetId)))return;
      if(progressSignature(latest.current,stateRef.current.runtime,previous.targetId?{targetId:previous.targetId,state:previous.expected!}:undefined)!==previous.stateSignature)return;
      persist(previous.runtime,actionKey);undoRef.current=null;setCanUndo(false);
    }catch(error){if(validOperation(actionKey,generation))setState(value=>({...value,error:error instanceof Error?error.message:'Could not undo progress. Try again.'}));throw error;}
    finally{if(context.current.generation===generation){busyRef.current=false;setBusy(false);}}
  };
  const undoEntry=undoRef.current,undoValid=Boolean(undoEntry&&undoEntry.signature===todayPlanSignature(options.trip,options.dayIndex)&&progressSignature(options,state.runtime)===undoEntry.stateSignature);
  return {runtime:state.key===key?state.runtime:null,ready:state.key===key&&state.ready,error:state.key===key?state.error:null,busy:busy&&busyRef.current,canUndo:options.enabled&&state.key===key&&canUndo&&undoValid,
    leaveNow:(projection:TodayProjection)=>act(projection,'leave'),arrived:(projection:TodayProjection)=>act(projection,'arrive'),stayLonger:(projection:TodayProjection,minutes=15)=>act(projection,'extend',minutes),undo};
}
