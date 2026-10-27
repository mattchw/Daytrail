import type { SupabaseClient } from '@supabase/supabase-js';
import { validCloudId, validMutationId } from '../cloud/codec';
import { TravelError, type TravelMark, type TravelMutation, type TravelRemote, type TravelState } from './types';

export const MAX_TRAVEL_MARKS = 10_000;
export function validTravelTarget(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const colon = value.indexOf(':');
  return ['activity', 'end', 'flight'].includes(value.slice(0, colon)) && validCloudId(value.slice(colon + 1));
}
const validState = (value: unknown): value is TravelState => value === 'planned' || value === 'done' || value === 'skipped';
const invalid = () => new TravelError('invalid', 'This travel update could not be verified. Your progress remains on this device.');
function remoteError(error: unknown): TravelError {
  if (error instanceof TravelError) return error;
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
  if (value.code === '42501' || value.code === 'PGRST301' || value.code === 'PGRST303' || value.status === 401 || value.status === 403) return new TravelError('auth', 'Sign in to the same account to save your travel progress.');
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(String(value.code))) return new TravelError('setup', 'Cloud travel progress is not set up yet. Your progress remains on this device.');
  if (['22023', '23514', '22P02', '22P05', '22001'].includes(String(value.code))) return new TravelError('invalid', 'This trip or stop has changed. Refresh the itinerary before saving this travel update. Your progress remains on this device.');
  return new TravelError('unavailable', 'Travel progress could not sync. Your progress is on this device and can retry when the connection returns.');
}
function decodeMark(value: unknown, ownerId: string, tripId: string): TravelMark {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (row.owner_id !== ownerId) throw new TravelError('auth', 'Your account changed. Sign in to the same account to save your travel progress.');
  if (row.trip_id !== tripId || !validTravelTarget(row.target_id) || !validCloudId(row.place_id)
    || !validState(row.state) || row.target_id.startsWith('end:') && row.state === 'skipped'
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || typeof row.updated_at !== 'string' || row.updated_at.length > 49
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.updated_at)
    || !Number.isFinite(Date.parse(row.updated_at))) throw invalid();
  return { targetId: row.target_id, placeId: row.place_id, state: row.state, revision: row.revision as number, updatedAt: row.updated_at };
}

/** Share the existing Supabase client. The RPC independently verifies this account. */
export function createTravelRemote(client: SupabaseClient, expectedOwnerId: string): TravelRemote {
  if (!validMutationId(expectedOwnerId)) throw new TravelError('auth', 'Sign in to save your travel progress.');
  async function checkAccount() {
    const { data, error } = await client.auth.getSession();
    if (error) throw remoteError(error);
    if (data.session?.user.id !== expectedOwnerId) throw new TravelError('auth', 'Your account changed. Sign in to the same account to save your travel progress.');
  }
  return {
    async list(tripId: string) {
      try {
        if (!validCloudId(tripId)) throw invalid();
        await checkAccount();
        const cloudId=tripId.startsWith('collab-')?tripId.slice(7):null;
        if(cloudId&&!validMutationId(cloudId))throw invalid();
        const { data, error } = await client.rpc(cloudId?'daytrail_collab_list_travel_marks':'daytrail_list_travel_marks', cloudId?{p_expected_actor_id:expectedOwnerId,p_cloud_trip_id:cloudId}:{ p_expected_owner_id: expectedOwnerId, p_trip_id: tripId });
        if (error) throw error;
        await checkAccount();
        if (!Array.isArray(data) || data.length > MAX_TRAVEL_MARKS) throw invalid();
        const marks = data.map(row => decodeMark(row, expectedOwnerId, tripId));
        if (new Set(marks.map(mark => mark.targetId)).size !== marks.length) throw invalid();
        return marks;
      } catch (error) { throw remoteError(error); }
    },
    async mutate(input: TravelMutation) {
      try {
        if (!validCloudId(input.tripId) || !validTravelTarget(input.targetId) || !validCloudId(input.placeId)
          || !validState(input.state) || input.targetId.startsWith('end:') && input.state === 'skipped'
          || !validMutationId(input.mutationId) || !Number.isSafeInteger(input.expectedRevision)
          || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw invalid();
        await checkAccount();
        const cloudId=input.tripId.startsWith('collab-')?input.tripId.slice(7):null;
        if(cloudId&&!validMutationId(cloudId))throw invalid();
        const { data, error } = await client.rpc(cloudId?'daytrail_collab_mutate_travel_mark':'daytrail_mutate_travel_mark', {
          ...(cloudId?{p_expected_actor_id:expectedOwnerId,p_cloud_trip_id:cloudId}:{p_expected_owner_id: expectedOwnerId, p_trip_id: input.tripId}),
          p_target_id: input.targetId, p_place_id: input.placeId, p_state: input.state,
          p_expected_revision: input.expectedRevision, p_mutation_id: input.mutationId,
        });
        if (error) throw error;
        await checkAccount();
        if (!data || typeof data !== 'object' || !['ok', 'conflict'].includes(data.status)) throw invalid();
        if (data.status === 'conflict') {
          const current = data.mark === null ? null : decodeMark(data.mark, expectedOwnerId, input.tripId);
          if (current && current.targetId !== input.targetId) throw invalid();
          throw new TravelError('conflict', 'This stop’s progress changed on another device. Choose which status to keep.', current);
        }
        const mark = decodeMark(data.mark, expectedOwnerId, input.tripId);
        if (mark.targetId !== input.targetId || mark.placeId !== input.placeId || mark.state !== input.state
          || mark.revision !== input.expectedRevision + 1) throw invalid();
        return mark;
      } catch (error) { throw remoteError(error); }
    },
  };
}
