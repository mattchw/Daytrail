import {useEffect, useRef, useState} from 'react';
import type {Trip} from '../model';
import CollaborationPanel, {CollaborationInvitationPanel, CollaborationStatus, type CollaborationCreatedInvite, type CollaborationInvitationState, type CollaborationSaveStatus} from '../components/CollaborationPanel';
import {CollaborationError, type CollaborationRemote, type SharedTripMetadata, type CollaborationPeople, type CollaborationActivity, type CollaborationInvitePreview} from './types';

const activityLabel:Record<string,string>={sharing_enabled:'enabled collaborative planning',saved:'updated the itinerary',deleted:'moved the trip to Trash',restored:'restored the trip',member_joined:'joined the trip',member_changed:'changed a permission',member_removed:'removed a member',member_left:'left the trip'};
export function ShareWorkspace({trip,metadata,remote,actorId,accountEmail,authError,status,savedToCloud,readyToEnable,hasPendingChanges,onEnable,onSignIn,onSaveToCloud,onSnapshot,onRefresh,onLeave,onDelete}:{
  trip:Trip;metadata?:SharedTripMetadata;remote:CollaborationRemote|null;actorId:string|null;accountEmail?:string;
  authError?:string|null;status?:CollaborationSaveStatus;savedToCloud:boolean;readyToEnable:boolean;hasPendingChanges:boolean;onEnable:()=>Promise<void>;onSignIn:()=>Promise<void>;
  onSaveToCloud:()=>void;onSnapshot:()=>void;onRefresh:()=>Promise<void>;onLeave:()=>void;onDelete?:()=>Promise<void>;
}) {
  const [people,setPeople]=useState<CollaborationPeople>({members:[],invitations:[]}),[activity,setActivity]=useState<CollaborationActivity[]>([]);
  const [created,setCreated]=useState<CollaborationCreatedInvite|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
  const generation=useRef(0);
  useEffect(()=>{const token=++generation.current;setError('');setPeople({members:[],invitations:[]});
    if(remote&&metadata){setBusy(true);void Promise.all([remote.people(metadata.cloudId),remote.activity(metadata.cloudId)]).then(([members,events])=>{if(token===generation.current){setPeople(members);setActivity(events);}}).catch(reason=>{if(token===generation.current)setError(reason instanceof Error?reason.message:'Could not load people.');}).finally(()=>{if(token===generation.current)setBusy(false);});}
    return()=>{generation.current++;};
  },[remote,metadata?.cloudId,metadata?.channelEpoch,metadata?.revision]);
  async function reload(){if(!remote||!metadata)return;const token=generation.current;const [members,events]=await Promise.all([remote.people(metadata.cloudId),remote.activity(metadata.cloudId)]);if(token===generation.current){setPeople(members);setActivity(events);}await onRefresh();}
  async function invite(email:string,role:'viewer'|'editor'){if(!remote||!metadata)return;const token=generation.current;const invitation=await remote.invite(metadata.cloudId,email,role);if(token!==generation.current)return;const url=new URL(location.pathname,location.origin);url.hash='invite='+invitation.token;setCreated({url:url.href,email:invitation.email,role:invitation.role,expiresAt:invitation.expires_at});await reload();}
  return <><CollaborationPanel tripName={trip.name} signedIn={!!actorId} accountEmail={accountEmail} enabled={!!metadata} role={metadata?.role} savedToCloud={savedToCloud} readyToEnable={readyToEnable} busy={busy} error={error||authError} createdInvite={created}
    members={people.members.map(member=>({id:member.user_id,displayName:member.display_name,role:member.role,isYou:member.user_id===actorId}))}
    invitations={people.invitations.map(invite=>({id:invite.id,email:invite.email,role:invite.role,expiresAt:invite.expires_at}))}
    onEnable={onEnable} onSignIn={onSignIn} onSaveToCloud={onSaveToCloud} onSnapshot={onSnapshot} onCreateInvite={invite}
    onChangeRole={async(id,role)=>{if(remote&&metadata){await remote.member(metadata.cloudId,id,role);await reload();}}}
    onRemoveMember={async id=>{if(remote&&metadata){await remote.member(metadata.cloudId,id,null);await reload();}}}
    onCancelInvite={async id=>{if(remote&&metadata){await remote.cancelInvite(metadata.cloudId,id);setCreated(null);await reload();}}}
    onLeave={async()=>{if(hasPendingChanges)throw Error('Save or download your unsent changes before leaving.');if(remote&&metadata){await remote.leave(metadata.cloudId);await onRefresh();onLeave();}}}/>
    {metadata&&activity.length>0&&<CollaborationStatus role={metadata.role} status={status||(metadata.role==='viewer'?'readonly':'synced')} revision={metadata.revision} activities={activity.map(event=>({id:event.id,actorName:event.actor_name,summary:activityLabel[event.kind]||'updated this trip',createdAt:event.created_at}))}/>}
    {metadata?.role==='owner'&&onDelete&&<div className="dt-collab-section">{confirmDelete?<><p>Move this shared trip to Trash for everyone? You can restore it from your trip library.</p><button className="button" onClick={()=>setConfirmDelete(false)}>Keep trip</button><button className="button" onClick={()=>void onDelete().catch(reason=>setError(reason instanceof Error?reason.message:'Could not move trip to Trash.'))}>Move shared trip to Trash</button></>:<button className="text-button" onClick={()=>setConfirmDelete(true)}>Move shared trip to Trash</button>}</div>}
  </>;
}

export function InvitationWorkspace({token,remote,accountEmail,authError,loading,onSignIn,onSwitchAccount,onAccepted,onDismiss}:{token:string;remote:CollaborationRemote|null;accountEmail?:string;authError?:string|null;loading:boolean;onSignIn:()=>Promise<void>;onSwitchAccount:()=>Promise<void>;onAccepted:(trip:Trip)=>Promise<void>;onDismiss:()=>void}) {
  const [problem,setProblem]=useState<CollaborationInvitationState|null>(null),[error,setError]=useState('');
  const [preview,setPreview]=useState<CollaborationInvitePreview|null>(null),[checking,setChecking]=useState(false),[attempt,setAttempt]=useState(0);
  const validToken=/^[A-Za-z0-9_-]{32,256}$/.test(token);
  const fail=(reason:unknown)=>{const message=reason instanceof Error?reason.message:'Could not check this invitation.';setError(message);setProblem(/different Google account|invited Google account|invited email address|wrong account/i.test(message)?'wrong-account':reason instanceof CollaborationError&&reason.code==='invalid'?'unavailable':'error');};
  useEffect(()=>{let current=true;setProblem(null);setError('');setPreview(null);if(!remote||!validToken||loading){setChecking(false);return;}setChecking(true);void remote.previewInvite(token).then(result=>{if(current)setPreview(result);}).catch(reason=>{if(current)fail(reason);}).finally(()=>{if(current)setChecking(false);});return()=>{current=false;};},[remote,token,validToken,loading,attempt]);
  const state:CollaborationInvitationState=!validToken?'unavailable':loading||checking?'loading':!remote?'signed-out':problem||(!preview?'loading':'ready');
  async function accept(){if(!remote)return;setError('');try{const result=await remote.accept(token);await onAccepted(result.trip);}catch(reason){fail(reason);}}
  return <CollaborationInvitationPanel state={state} token={token} tripName={preview?.trip_name} ownerName={preview?.owner_name} role={preview?.role} expiresAt={preview?.expires_at} accountEmail={accountEmail} error={error||authError} onSignIn={onSignIn} onSwitchAccount={onSwitchAccount} onAccept={accept} onRetry={()=>setAttempt(value=>value+1)} onDismiss={onDismiss}/>;
}
