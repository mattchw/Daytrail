import type {Trip} from '../model';
import {canonicalCloudTrip, validCloudId, validMutationId} from './codec';
import type {CloudMutation, CloudTrip} from './types';

export interface LocalTrip {
  trip: Trip;
  deletedAt: string | null;
  base: CloudTrip | null;
  /** Never change an issued payload. Later edits stay in trip until it is acknowledged. */
  pending: CloudMutation | null;
  conflict: boolean;
  remote: CloudTrip | null;
  archived?: boolean;
  sourceGuest?: {id: string; fingerprint: string};
}
export interface WorkspaceData {
  version: 2;
  key: string;
  records: Record<string, LocalTrip>;
  imports: {sourceId: string; fingerprint: string; cloudId: string}[];
  remoteLoaded: boolean;
  lease?: {holder: string; until: number};
}
export interface WorkspaceStore {
  read(key: string): Promise<WorkspaceData | null>;
  /** The callback is synchronous and runs within one read/write transaction. */
  update(key: string, change: (current: WorkspaceData | null) => WorkspaceData): Promise<WorkspaceData>;
  close?(): void;
}
export const emptyWorkspace = (key: string): WorkspaceData => ({version: 2, key, records: {}, imports: [], remoteLoaded: false});
export const newLocalTrip = (trip: Trip): LocalTrip => ({trip: canonicalCloudTrip(trip), deletedAt: null, base: null, pending: null, conflict: false, remote: null});
const clone = <T,>(value: T): T => structuredClone(value);
const validDate = (value: unknown) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Fail closed on damaged browser records; never overwrite them with an empty library. */
function validate(value: WorkspaceData | null, key: string): WorkspaceData | null {
  if (value === null) return null;
  const bad = () => { throw new Error('Saved workspace data could not be opened. Keep this browser data and your JSON backup for recovery.'); };
  if (!value || ![1,2].includes(value.version) || value.key !== key || !value.records || typeof value.records !== 'object'
    || Array.isArray(value.records) || !Array.isArray(value.imports) || typeof value.remoteLoaded !== 'boolean') bad();
  for (const [id, record] of Object.entries(value.records)) {
    if (!validCloudId(id) || !record || record.trip?.id !== id || !validDate(record.deletedAt)
      || typeof record.conflict !== 'boolean') bad();
    canonicalCloudTrip(record.trip);
    for (const saved of [record.base, record.remote]) if (saved !== null) {
      if (!saved || saved.trip?.id !== id || !Number.isSafeInteger(saved.revision) || saved.revision < 1
        || !validDate(saved.deletedAt) || !validDate(saved.updatedAt) || saved.updatedAt === null) bad();
      canonicalCloudTrip(saved.trip);
    }
    if (record.pending) {
      const pending = record.pending;
      if (pending.schemaVersion !== undefined && ![1,2].includes(pending.schemaVersion) || pending.tripId !== id || !validMutationId(pending.mutationId) || !Number.isSafeInteger(pending.expectedRevision)
        || pending.expectedRevision < 0 || !['create', 'save', 'delete', 'restore'].includes(pending.operation)) bad();
      if (pending.trip) { if (pending.trip.id !== id) bad(); canonicalCloudTrip(pending.trip); }
    }
    if (record.sourceGuest && (!validCloudId(record.sourceGuest.id) || typeof record.sourceGuest.fingerprint !== 'string')) bad();
  }
  for (const item of value.imports) if (!item || !validCloudId(item.sourceId) || !validCloudId(item.cloudId) || typeof item.fingerprint !== 'string') bad();
  if (value.lease && (typeof value.lease.holder !== 'string' || !Number.isFinite(value.lease.until))) bad();
  // Preserve issued request payloads and IDs exactly while upgrading the envelope.
  return {...value, version:2};
}

/** Each scope is one row, so a draft, its base revision, and its outbox change atomically. */
export function createIndexedWorkspaceStore(factory: IDBFactory | undefined = globalThis.indexedDB): WorkspaceStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) { reject(new Error('Device storage is unavailable. Allow site storage before saving trips.')); return; }
    const request = factory.open('daytrail.workspaces', 1);
    let finished = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('workspaces')) request.result.createObjectStore('workspaces', {keyPath: 'key'});
    };
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true;
      request.result.onversionchange = () => { request.result.close(); opened = null; };
      resolve(request.result);
    };
    request.onerror = () => { if (!finished) { finished = true; opened = null; reject(request.error || new Error('Device storage could not be opened.')); } };
    request.onblocked = () => { if (!finished) { finished = true; opened = null; reject(new Error('Close older Daytrail tabs, then retry opening device storage.')); } };
  });
  return {
    async read(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('workspaces', 'readonly');
        const request = transaction.objectStore('workspaces').get(key);
        request.onsuccess = () => { try { resolve(validate(request.result ?? null, key)); } catch (error) { reject(error); } };
        request.onerror = () => reject(request.error || new Error('Device storage could not be read.'));
        transaction.onabort = () => reject(transaction.error || new Error('Device storage could not be read.'));
      });
    },
    async update(key, change) {
      const db = await open();
      return new Promise((resolve, reject) => {
        // Strict durability is supported by current IndexedDB implementations;
        // use the standard transaction overload on older browsers.
        let transaction: IDBTransaction;
        try { transaction = db.transaction('workspaces', 'readwrite', {durability: 'strict'}); }
        catch { transaction = db.transaction('workspaces', 'readwrite'); }
        const objectStore = transaction.objectStore('workspaces');
        let next: WorkspaceData;
        const request = objectStore.get(key);
        request.onsuccess = () => {
          try {
            next = change(validate(request.result ?? null, key));
            next = validate(next, key)!;
            objectStore.put(next);
          } catch (error) { reject(error); transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(clone(next));
        transaction.onerror = () => reject(transaction.error || new Error('There is not enough device storage. Your previous saved trips are unchanged.'));
        transaction.onabort = () => reject(transaction.error || new Error('The change could not be saved on this device. Your previous saved trips are unchanged.'));
      });
    },
    close() { const current = opened; opened = null; void current?.then(db => db.close(), () => {}); },
  };
}

/** A transactional test adapter; production always uses IndexedDB. */
export function createMemoryWorkspaceStore(): WorkspaceStore {
  const values = new Map<string, WorkspaceData>();
  let queue = Promise.resolve();
  return {
    async read(key) { await queue; return clone(validate(values.get(key) ?? null,key)); },
    update(key, change) {
      const result = queue.then(() => {
        const next = validate(change(clone(validate(values.get(key) ?? null,key))), key)!;
        values.set(key, clone(next)); return clone(next);
      });
      queue = result.then(() => {}, () => {});
      return result;
    },
  };
}
