import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalCloudTrip, cloudTripFingerprint, decodeCloudTrip, MAX_CLOUD_TRIPS, validCloudId, validMutationId, usesBookingSchema } from './codec';
import { CloudError, type CloudMutation, type CloudRemote } from './types';

const columns = 'owner_id,trip_id,schema_version,document,revision,updated_at,deleted_at';
function remoteError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
  if (value.code === '42501' || value.code === 'PGRST301' || value.code === 'PGRST303' || value.status === 401 || value.status === 403) return new CloudError('auth', 'Sign in to the same account again to continue syncing.');
  if (['42P01', '42883', 'PGRST202', 'PGRST205', '0A000'].includes(String(value.code))) return new CloudError('setup', 'Cloud saving is not available for this app yet. Your changes remain on this device.');
  if (['22023','23514','22P02','22P05','22001'].includes(String(value.code))) return new CloudError('invalid', 'Cloud saving could not accept this change. Check trip size and the 100-trip limit, including Trash. Your local changes are safe.');
  return new CloudError('unavailable', 'Could not reach cloud saving. Your changes are on this device and will retry when the connection returns.');
}

/** Uses the auth singleton; never creates a second client or accepts an owner from a draft. */
export function createCloudRemote(client: SupabaseClient, expectedOwnerId: string): CloudRemote {
  if (!validMutationId(expectedOwnerId)) throw new CloudError('auth', 'Sign in to continue syncing.');
  async function checkAccount() {
    const { data, error } = await client.auth.getSession();
    if (error) throw remoteError(error);
    if (data.session?.user.id !== expectedOwnerId) throw new CloudError('auth', 'Your account changed. Sign in to the same account to continue syncing.');
  }
  return {
    async list() {
      try {
        await checkAccount();
        const { data, error } = await client.from('daytrail_trips').select(columns).eq('owner_id', expectedOwnerId).order('trip_id').limit(MAX_CLOUD_TRIPS + 1);
        if (error) throw error;
        await checkAccount();
        if (!Array.isArray(data) || data.length > MAX_CLOUD_TRIPS) throw new CloudError('invalid', 'The cloud trip list could not be opened safely. Your local trips have not changed.');
        const rows = data.map(row => decodeCloudTrip(row, expectedOwnerId));
        if (new Set(rows.map(row => row.trip.id)).size !== rows.length) throw new CloudError('invalid', 'The cloud trip list could not be opened safely.');
        return rows;
      } catch (error) { throw remoteError(error); }
    },
    async mutate(input: CloudMutation) {
      try {
        if (input.schemaVersion !== undefined && ![1,2].includes(input.schemaVersion) || !validCloudId(input.tripId) || !validMutationId(input.mutationId) || !Number.isSafeInteger(input.expectedRevision)
          || input.expectedRevision < 0 || !['create', 'save', 'delete', 'restore'].includes(input.operation)
          || (input.operation === 'create' ? input.expectedRevision !== 0 : input.expectedRevision < 1)) throw new CloudError('invalid', 'This cloud change is invalid. Your local trips have not changed.');
        const document = input.trip === undefined ? null : canonicalCloudTrip(input.trip);
        if ((input.operation === 'create' || input.operation === 'save') ? !document || document.id !== input.tripId : document !== null) throw new CloudError('invalid', 'This cloud change is invalid. Your local trips have not changed.');
        if ((input.schemaVersion ?? 1) === 1 && document && usesBookingSchema(document)) throw new CloudError('invalid', 'This pending change uses an unsupported trip format. Your local changes are safe.');
        await checkAccount();
        const { data, error } = await client.rpc('daytrail_mutate_trip', {
          p_expected_owner_id: expectedOwnerId,
          p_trip_id: input.tripId,
          p_expected_revision: input.expectedRevision,
          p_mutation_id: input.mutationId,
          p_operation: input.operation,
          p_document: document,
          p_schema_version: input.schemaVersion ?? 1,
        });
        if (error) throw error;
        await checkAccount();
        if (!data || typeof data !== 'object' || !['ok', 'conflict'].includes(data.status)) throw new CloudError('invalid', 'The cloud save response could not be verified. Your local changes are safe.');
        if (data.status === 'conflict') {
          const current = data.trip ? decodeCloudTrip(data.trip, expectedOwnerId) : undefined;
          if (current && current.trip.id !== input.tripId) throw new CloudError('invalid', 'The cloud save response could not be verified.');
          throw new CloudError('conflict', 'This trip changed on another device. Choose which version to keep.', current);
        }
        const result = decodeCloudTrip(data.trip, expectedOwnerId);
        if (result.trip.id !== input.tripId || result.revision !== input.expectedRevision + 1
          || (input.operation === 'delete' ? result.deletedAt === null : result.deletedAt !== null)
          || document && cloudTripFingerprint(result.trip) !== cloudTripFingerprint(document)) throw new CloudError('invalid', 'The cloud save response could not be verified. Your local changes are safe.');
        return result;
      } catch (error) { throw remoteError(error); }
    },
  };
}
