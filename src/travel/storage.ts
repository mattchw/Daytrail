import {validCloudId, validMutationId} from '../cloud/codec';
import {MAX_TRAVEL_MARKS, validTravelTarget} from './remote';
import type {TravelMark, TravelMutation, TravelState} from './types';

export interface LocalTravelMark {
  placeId: string;
  state: TravelState;
  base: TravelMark | null;
  pending: TravelMutation | null;
  conflict: boolean;
  remote: TravelMark | null;
  /** A server-rejected update stays durable until corrected or explicitly discarded. */
  error: string | null;
}
export interface TripProgress {
  marks: Record<string, LocalTravelMark>;
  targets: Record<string, string>;
  remoteLoaded: boolean;
  error: string | null;
  /** Personal device timing. Never uploaded with completion progress. */
  today?: Record<string, string>;
}
export interface TravelWorkspace {
  version: 1;
  key: string;
  trips: Record<string, TripProgress>;
  lease?: {holder: string; until: number};
}
export interface TravelStore {
  read(key: string): Promise<TravelWorkspace | null>;
  update(key: string, change: (previous: TravelWorkspace | null) => TravelWorkspace): Promise<TravelWorkspace>;
  close?(): void;
}
export const emptyTravelWorkspace = (key: string): TravelWorkspace => ({version: 1, key, trips: {}});
export const emptyTripProgress = (): TripProgress => ({marks: {}, targets: {}, remoteLoaded: false, error: null});
export const newLocalTravelMark = (placeId: string, state: TravelState): LocalTravelMark => ({placeId, state, base: null, pending: null, conflict: false, remote: null, error: null});
const clone = <T,>(value: T): T => structuredClone(value);
const validState = (target: string, state: unknown) => ['planned', 'done', 'skipped'].includes(String(state)) && !(target.startsWith('end:') && state === 'skipped');
const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);

/** No notes, provider details, or authentication tokens belong in progress storage. */
function validate(value: TravelWorkspace | null, key: string): TravelWorkspace | null {
  if (value === null) return null;
  const fail = () => { throw new Error('Travel progress could not be opened. Keep this browser data for recovery and retry.'); };
  if (!record(value) || value.version !== 1 || value.key !== key || !record(value.trips) || Object.keys(value.trips).length > 100) fail();
  for (const [tripId, trip] of Object.entries(value.trips)) {
    if (!validCloudId(tripId) || !record(trip) || !record(trip.marks) || !record(trip.targets)
      || Object.keys(trip.marks).length > MAX_TRAVEL_MARKS || Object.keys(trip.targets).length > 6130
      || typeof trip.remoteLoaded !== 'boolean' || trip.error !== null && typeof trip.error !== 'string') fail();
    if(trip.today){
      if(!record(trip.today)||Object.keys(trip.today).length>100)fail();
      for(const [dayId,raw] of Object.entries(trip.today)){
        if(!validCloudId(dayId)||typeof raw!=='string'||raw.length>14000)fail();
        try{const value=JSON.parse(raw),runtime=value.runtime;
          if(Object.keys(value).some(k=>!['ownerId','scope','runtime'].includes(k))||value.ownerId!==(key==='guest'?null:key.slice(8))||value.scope!==(key==='guest'?'guest':'account')||!runtime||runtime.schema!==1||runtime.tripId!==tripId||runtime.dayId!==dayId||Object.keys(runtime).some(k=>!['schema','tripId','dayId','date','timezone','phase','targetId','placeId','since','leaveAt','updatedAt','originArrivedAt','bypassedFreeIds'].includes(k)))fail();
          if(runtime.bypassedFreeIds!==undefined&&(!Array.isArray(runtime.bypassedFreeIds)||runtime.bypassedFreeIds.length>100||new Set(runtime.bypassedFreeIds).size!==runtime.bypassedFreeIds.length||runtime.bypassedFreeIds.some((id:unknown)=>!validTravelTarget(id)||!id.startsWith('free:'))))fail();
        }catch{fail();}
      }
    }
    for (const [targetId, placeId] of Object.entries(trip.targets)) if (!validTravelTarget(targetId) || !validCloudId(placeId)) fail();
    for (const [targetId, mark] of Object.entries(trip.marks)) {
      if (!validTravelTarget(targetId) || !record(mark) || !validCloudId(mark.placeId) || !validState(targetId, mark.state)
        || typeof mark.conflict !== 'boolean' || mark.error !== null && typeof mark.error !== 'string') fail();
      for (const saved of [mark.base, mark.remote]) if (saved !== null) {
        if (!saved || saved.targetId !== targetId || !validCloudId(saved.placeId) || !validState(targetId, saved.state)
          || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.updatedAt !== 'string'
          || !Number.isFinite(Date.parse(saved.updatedAt))) fail();
      }
      if (mark.pending) {
        const pending = mark.pending;
        if (pending.tripId !== tripId || pending.targetId !== targetId || !validCloudId(pending.placeId)
          || !validState(targetId, pending.state) || !validMutationId(pending.mutationId)
          || !Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision < 0) fail();
      }
    }
  }
  if (value.lease && (typeof value.lease.holder !== 'string' || !Number.isFinite(value.lease.until))) fail();
  return value;
}

/** Independent schema: older itinerary clients never rewrite travel progress. */
export function createIndexedTravelStore(factory: IDBFactory | undefined = globalThis.indexedDB): TravelStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) { reject(new Error('Device storage is unavailable. Allow site storage before recording travel progress.')); return; }
    const request = factory.open('daytrail.travel', 1); let finished = false;
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('workspaces')) request.result.createObjectStore('workspaces', {keyPath: 'key'}); };
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true; request.result.onversionchange = () => { request.result.close(); opened = null; }; resolve(request.result);
    };
    request.onerror = () => { if (!finished) { finished = true; opened = null; reject(request.error || new Error('Travel progress storage could not be opened.')); } };
    request.onblocked = () => { if (!finished) { finished = true; opened = null; reject(new Error('Close older Daytrail tabs, then retry opening travel progress.')); } };
  });
  return {
    async read(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('workspaces', 'readonly'), request = transaction.objectStore('workspaces').get(key);
        request.onsuccess = () => { try { resolve(validate(request.result ?? null, key)); } catch (error) { reject(error); } };
        request.onerror = () => reject(request.error || new Error('Travel progress could not be read.'));
        transaction.onabort = () => reject(transaction.error || new Error('Travel progress could not be read.'));
      });
    },
    async update(key, change) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let transaction: IDBTransaction;
        try { transaction = db.transaction('workspaces', 'readwrite', {durability: 'strict'}); }
        catch { transaction = db.transaction('workspaces', 'readwrite'); }
        const objectStore = transaction.objectStore('workspaces'), request = objectStore.get(key); let next: TravelWorkspace;
        request.onsuccess = () => {
          try { next = change(validate(request.result ?? null, key)); validate(next, key); objectStore.put(next); }
          catch (error) { reject(error); transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(clone(next));
        transaction.onerror = () => reject(transaction.error || new Error('Travel progress could not be saved on this device. Your previous progress is unchanged.'));
        transaction.onabort = () => reject(transaction.error || new Error('Travel progress could not be saved on this device. Your previous progress is unchanged.'));
      });
    },
    close() { const prior = opened; opened = null; void prior?.then(db => db.close(), () => {}); },
  };
}

export function createMemoryTravelStore(): TravelStore {
  const values = new Map<string, TravelWorkspace>(); let queue = Promise.resolve();
  return {
    async read(key) { await queue; return clone(values.get(key) ?? null); },
    update(key, change) {
      const result = queue.then(() => { const next = change(clone(values.get(key) ?? null)); validate(next, key); values.set(key, clone(next)); return clone(next); });
      queue = result.then(() => {}, () => {}); return result;
    },
  };
}
