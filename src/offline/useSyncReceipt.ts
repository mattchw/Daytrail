import {useEffect,useState} from 'react';
export interface SyncReceiptInput {identity:string;online:boolean;verified:boolean;pendingCount:number;blocked:boolean;acknowledgedCount:number}
export interface SyncReceipt {message:string;at:number}
export interface SyncReceiptState {identity:string;baseline:number;waiting:boolean;receipt:SyncReceipt|null}
export function initialSyncReceipt(input:SyncReceiptInput):SyncReceiptState{return{identity:input.identity,baseline:input.acknowledgedCount,waiting:(!input.online||!input.verified)&&input.pendingCount>0,receipt:null};}
/** Counters are incremented only after a server acknowledgement is durably accepted.
 * A smaller queue alone never constitutes evidence that anything was uploaded. */
export function reduceSyncReceipt(state:SyncReceiptState,input:SyncReceiptInput,now=Date.now()):SyncReceiptState {
  if(state.identity!==input.identity||input.acknowledgedCount<state.baseline)return initialSyncReceipt(input);
  if(!input.online||!input.verified)return{...state,baseline:input.acknowledgedCount,waiting:state.waiting||input.pendingCount>0,receipt:null};
  if(state.waiting&&!input.blocked&&input.pendingCount===0&&input.acknowledgedCount>state.baseline)return{...state,baseline:input.acknowledgedCount,waiting:false,receipt:{message:'Back online · Changes synced',at:now}};
  return state;
}
export function useSyncReceipt(input:SyncReceiptInput){
  const [state,setState]=useState(()=>initialSyncReceipt(input));
  useEffect(()=>{setState(previous=>reduceSyncReceipt(previous,input));},[input.identity,input.online,input.verified,input.pendingCount,input.blocked,input.acknowledgedCount]);
  const receipt=state.identity===input.identity&&input.online&&input.verified&&!input.blocked?state.receipt:null;
  return{receipt,dismiss:()=>setState(previous=>({...previous,receipt:null}))};
}
