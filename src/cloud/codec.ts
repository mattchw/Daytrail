import { isTrip, type Trip } from '../model';
import { canonicalTrip } from '../tripBackup';
import { CloudError, type CloudTrip } from './types';

export const CLOUD_SCHEMA_VERSION = 2;
export const MAX_CLOUD_TRIPS = 100;
export const MAX_CLOUD_BYTES = 4 * 1024 * 1024;
export const validCloudId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
export const validMutationId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const invalid = () => new CloudError('invalid', 'This trip could not be safely saved. Keep a backup of your changes and try again.');

/** Hydrated provider data and arbitrary attached fields never cross this boundary. */
export function canonicalCloudTrip(value: unknown): Trip {
  if (!isTrip(value)) throw invalid();
  const trip = canonicalTrip(value);
  // PostgreSQL JSONB cannot represent NUL or lone UTF-16 surrogates. Reject them
  // locally instead of queuing a mutation the server can never accept.
  const pending: unknown[] = [trip];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(item)) throw invalid();
    if (item && typeof item === 'object') pending.push(...Object.values(item));
  }
  if (new TextEncoder().encode(JSON.stringify(trip)).byteLength > MAX_CLOUD_BYTES) {
    throw new CloudError('invalid', 'This trip is too large for cloud saving. Your changes are still on this device.');
  }
  return trip;
}

/** A v1 receipt must remain byte-equivalent and cannot conceal v2 booking fields. */
export function usesBookingSchema(trip:Trip):boolean {
  return trip.flights !== undefined || trip.stays !== undefined || trip.days.some(day =>
    day.timezone !== undefined || day.startStayId !== undefined || day.endStayId !== undefined || day.endFlightId !== undefined
    || day.endMode === 'flight' || day.items.some(item => item.flightId !== undefined || item.departureForFlightId !== undefined || item.mode === 'flight'));
}

/** Canonical JSON is enough for local equality; the database hashes requests itself. */
export function cloudTripFingerprint(trip: Trip): string {
  return JSON.stringify(canonicalCloudTrip(trip));
}

function stableJSON(value: unknown, depth = 0): string {
  if (depth > 24) throw invalid();
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => stableJSON(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid();
      return JSON.stringify(key) + ':' + stableJSON((value as Record<string, unknown>)[key], depth + 1);
    }).join(',') + '}';
  }
  throw invalid();
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length < 50
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** Server rows are untrusted too. Never rewrite an unsupported schema as an older version. */
export function decodeCloudTrip(value: unknown, expectedOwnerId: string): CloudTrip {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (row.owner_id !== expectedOwnerId) throw new CloudError('auth', 'Your account changed. Sign in again to continue syncing.');
  if (row.schema_version !== 1 && row.schema_version !== CLOUD_SCHEMA_VERSION) throw new CloudError('setup', 'This cloud trip needs a newer version of Daytrail. Reload the app before editing it.');
  if (!validCloudId(row.trip_id) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || !timestamp(row.updated_at) || row.deleted_at !== null && !timestamp(row.deleted_at)) throw invalid();
  const trip = canonicalCloudTrip(row.document);
  if (row.schema_version === 1 && usesBookingSchema(trip)) throw invalid();
  if (trip.id !== row.trip_id || stableJSON(row.document) !== stableJSON(trip)) throw invalid();
  return { trip, revision: row.revision as number, updatedAt: row.updated_at, deletedAt: row.deleted_at as string | null };
}
