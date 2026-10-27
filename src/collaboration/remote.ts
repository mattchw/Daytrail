import type {SupabaseClient} from '@supabase/supabase-js';
import {canonicalCloudTrip,validCloudId,validMutationId} from '../cloud/codec';
import {CollaborationError,sharedUIId,type CollaborationRemote,type SharedTrip,type SharedMutation,type CollaborationPeople,type CollaborationInvitation,type CollaborationActivity,type CollaborationInvitePreview} from './types';

const timestamp=(value:unknown):value is string=>typeof value==='string' && Number.isFinite(Date.parse(value));
function validInvitation(value:unknown):value is CollaborationInvitation & {token?:unknown} {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>;
  return validMutationId(row.id)&&typeof row.email==='string'&&row.email.length<=320&&['editor','viewer'].includes(String(row.role))&&timestamp(row.expires_at)
    &&(row.created_at===undefined||timestamp(row.created_at));
}
function remoteError(error:unknown):CollaborationError {
  if(error instanceof CollaborationError) return error;
  const value=error&&typeof error==='object'?error as {code?:string;status?:number;message?:string}:{};
  if(value.message==='Sign in with the invited Google account')return new CollaborationError('auth','Sign in with the Google account matching the invited email address.');
  if(value.message==='Invitation expired or unavailable')return new CollaborationError('invalid','This invitation has expired, was cancelled, or is no longer available. Ask the owner for a new link.');
  if(value.message==='Daytrail account mismatch')return new CollaborationError('auth','Your account changed. Sign in to the same account again.');
  if(value.code==='42501'||value.status===403) return new CollaborationError('revoked','You no longer have permission to make this change. Your unsaved draft is kept on this device.');
  if(['PGRST301','PGRST303'].includes(value.code||'')||value.status===401) return new CollaborationError('auth','Sign in to the same account again to sync this trip.');
  if(['42P01','42883','PGRST202','PGRST205'].includes(value.code||'')) return new CollaborationError('setup','Collaborative planning needs its database migration before it can be used.');
  if(['22023','23514','22P02','23505'].includes(value.code||'')) return new CollaborationError('invalid','This change could not be accepted. Check the trip details or invitation and try again.');
  return new CollaborationError('unavailable','Could not connect. Your draft is saved on this device and will retry when the connection returns.');
}
export function decodeSharedTrip(value:unknown,actorId:string):SharedTrip {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new CollaborationError('invalid','The shared trip response could not be verified.');
  const row=value as Record<string,unknown>;
  if(!validMutationId(row.cloud_trip_id)||!validMutationId(row.owner_id)||!validMutationId(row.channel_epoch)||!validCloudId(row.trip_id)
    ||!['owner','editor','viewer'].includes(String(row.role))||row.schema_version!==2||!Number.isSafeInteger(row.revision)||(row.revision as number)<1
    ||!timestamp(row.updated_at)||(row.deleted_at!==null&&!timestamp(row.deleted_at))
    ||(row.role==='owner')!==(row.owner_id===actorId)) throw new CollaborationError('invalid','The shared trip response could not be verified.');
  const trip=canonicalCloudTrip(row.document);
  if(trip.id!==row.trip_id) throw new CollaborationError('invalid','The shared trip identity could not be verified.');
  if(row.role!=='owner' && [...(trip.flights||[]),...(trip.stays||[])].some(booking=>['bookingReference','privateNotes','contact','bookingUrl','departureGate','arrivalGate'].some(key=>Object.hasOwn(booking,key)))) {
    throw new CollaborationError('invalid','Private booking details were present in a shared response. The trip has not been opened.');
  }
  return {trip:{...trip,id:sharedUIId(row.cloud_trip_id)},cloudId:row.cloud_trip_id,sourceTripId:row.trip_id,ownerId:row.owner_id,
    role:row.role as SharedTrip['role'],revision:row.revision as number,channelEpoch:row.channel_epoch,updatedAt:row.updated_at,deletedAt:row.deleted_at as string|null};
}
export function createCollaborationRemote(client:SupabaseClient,actorId:string):CollaborationRemote {
  if(!validMutationId(actorId)) throw new CollaborationError('auth','Sign in to use collaborative planning.');
  async function account() {
    const {data,error}=await client.auth.getSession(); if(error) throw remoteError(error);
    if(data.session?.user.id!==actorId) throw new CollaborationError('auth','Your account changed. Return to the same account to sync this draft.');
  }
  async function call(name:string,args:Record<string,unknown>={}) {
    try { await account(); const {data,error}=await client.rpc(`daytrail_collab_${name}`,{p_expected_actor_id:actorId,...args});
      if(error) throw error; await account(); return data;
    } catch(error) {throw remoteError(error);}
  }
  const scope=(id:string)=>{if(!validMutationId(id)) throw new CollaborationError('invalid','The shared trip ID is invalid.');return {p_cloud_trip_id:id};};
  return {
    async list() {
      const data=await call('list');
      if(!Array.isArray(data)||data.length>500) throw new CollaborationError('invalid','The shared trip list could not be verified.');
      const rows=data.map(row=>decodeSharedTrip(row,actorId));
      if(new Set(rows.map(row=>row.cloudId)).size!==rows.length) throw new CollaborationError('invalid','The shared trip list contains duplicate identities.');
      return rows;
    },
    async get(cloudId){return decodeSharedTrip(await call('get',scope(cloudId)),actorId);},
    async enable(sourceTripId,expectedRevision) {
      if(!validCloudId(sourceTripId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1) throw new CollaborationError('invalid','Save this trip to your account before inviting people.');
      const data=await call('enable',{p_trip_id:sourceTripId,p_expected_revision:expectedRevision});
      if(!data||!['ok','conflict'].includes(data.status)) throw new CollaborationError('invalid','The sharing response could not be verified.');
      const row=data.trip?decodeSharedTrip(data.trip,actorId):undefined;
      if(data.status==='conflict') throw new CollaborationError('conflict','The trip changed. Refresh its saved version before enabling sharing.',row);
      if(!row||row.sourceTripId!==sourceTripId||row.role!=='owner') throw new CollaborationError('invalid','The sharing response could not be verified.');
      return row;
    },
    async mutate(input:SharedMutation) {
      if(!validMutationId(input.mutationId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!validCloudId(input.sourceTripId)
        ||!['save','delete','restore'].includes(input.operation)||input.trip&&input.trip.id!==sharedUIId(input.cloudId)) throw new CollaborationError('invalid','The shared change is invalid.');
      const document=input.trip?canonicalCloudTrip({...input.trip,id:input.sourceTripId}):null;
      if((input.operation==='save')!==!!document) throw new CollaborationError('invalid','The shared change is invalid.');
      const data=await call('mutate',{...scope(input.cloudId),p_expected_revision:input.expectedRevision,p_mutation_id:input.mutationId,p_operation:input.operation,p_document:document});
      if(!data||!['ok','conflict'].includes(data.status)) throw new CollaborationError('invalid','The shared save response could not be verified.');
      const row=data.trip?decodeSharedTrip(data.trip,actorId):undefined;
      if(row&&(row.cloudId!==input.cloudId||row.sourceTripId!==input.sourceTripId)) throw new CollaborationError('invalid','The shared save identity could not be verified.');
      if(data.status==='conflict') throw new CollaborationError('conflict','This trip changed while you were editing.',row);
      if(!row||!Number.isSafeInteger(data.committed_revision)||data.committed_revision!==input.expectedRevision+1||row.revision<data.committed_revision) throw new CollaborationError('invalid','The shared save receipt could not be verified.');
      return {trip:row,committedRevision:data.committed_revision,replayed:data.replayed===true};
    },
    async people(cloudId) {
      const data=await call('people',scope(cloudId));
      if(!data||!Array.isArray(data.members)||data.members.length>500||!Array.isArray(data.invitations)||data.invitations.length>500
        ||data.members.some((member:Record<string,unknown>)=>!member||!validMutationId(member.user_id)||!['owner','editor','viewer'].includes(String(member.role))||typeof member.display_name!=='string'||member.display_name.length>500)
        ||data.invitations.some((invite:unknown)=>!validInvitation(invite))) throw new CollaborationError('invalid','The members list could not be verified.');
      return data as CollaborationPeople;
    },
    async invite(cloudId,email,role) {
      if(!['viewer','editor'].includes(role)||!email.trim()) throw new CollaborationError('invalid','Enter an email and invitation role.');
      const data=await call('invite',{...scope(cloudId),p_email:email.trim(),p_role:role});
      if(!validInvitation(data)||typeof data.token!=='string'||!data.token||data.token.length>512) throw new CollaborationError('invalid','The invitation response could not be verified.');
      return data as CollaborationInvitation & {token:string};
    },
    async cancelInvite(cloudId,invitationId){await call('cancel_invite',{...scope(cloudId),p_invitation_id:invitationId});},
    async accept(token){return decodeSharedTrip(await call('accept',{p_token:token}),actorId);},
    async previewInvite(token){
      const data=await call('preview_invite',{p_token:token});
      if(!data||typeof data.trip_name!=='string'||data.trip_name.length>500||typeof data.owner_name!=='string'||data.owner_name.length>500
        ||!['viewer','editor'].includes(data.role)||typeof data.email!=='string'||data.email.length>320||!timestamp(data.expires_at))throw new CollaborationError('invalid','The invitation details could not be verified.');
      return data as CollaborationInvitePreview;
    },
    async member(cloudId,userId,role){await call('member',{...scope(cloudId),p_user_id:userId,p_role:role});},
    async leave(cloudId){await call('leave',scope(cloudId));},
    async activity(cloudId) {
      const data=await call('activity',scope(cloudId));
      if(!Array.isArray(data)||data.length>200||data.some(item=>!item||!validMutationId(item.id)||(item.actor_id!==null&&!validMutationId(item.actor_id))||typeof item.actor_name!=='string'||item.actor_name.length>500
        ||typeof item.kind!=='string'||item.kind.length>100||!Number.isSafeInteger(item.revision)||item.revision<1||!timestamp(item.created_at))) throw new CollaborationError('invalid','The recent activity could not be verified.');
      return data as CollaborationActivity[];
    },
    subscribe(trip,onChange) {
      const channel=client.channel(`daytrail:${trip.cloudId}:${trip.channelEpoch}`,{config:{private:true}})
        .on('broadcast',{event:'trip_changed'},()=>onChange()).subscribe(status=>{if(status==='SUBSCRIBED')onChange();});
      return ()=>{void client.removeChannel(channel);};
    },
  };
}
