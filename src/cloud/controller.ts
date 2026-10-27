import type {Trip} from '../model';
import {canonicalCloudTrip, cloudTripFingerprint, CLOUD_SCHEMA_VERSION, MAX_CLOUD_TRIPS, MAX_CLOUD_BYTES} from './codec';
import {CloudError, type CloudRemote, type CloudTrip, type CloudMutation} from './types';
import {emptyWorkspace, newLocalTrip, type LocalTrip, type WorkspaceData, type WorkspaceStore} from './storage';

export type WorkspaceScope = 'guest' | 'account';
export type WorkspaceStatus = 'local' | 'saving' | 'syncing' | 'saved' | 'offline' | 'auth' | 'conflict' | 'failed' | 'setup';
export interface WorkspaceSnapshot {
  trips: Trip[];
  guestTrips: Trip[];
  ready: boolean;
  scope: WorkspaceScope;
  ownerId: string | null;
  error: string | null;
  status: WorkspaceStatus;
  statusById: Record<string, WorkspaceStatus>;
  updatedAtById: Record<string, string>;
  revisionById: Record<string, number>;
  trash: CloudTrip[];
  conflicts: {id: string; local: Trip; remote: CloudTrip | null}[];
  canUndo: boolean;
  pendingCount: number;
  /** Successful server mutations acknowledged in this controller session. */
  acknowledgedCount: number;
  busy: boolean;
  remoteUpdatesPending: boolean;
}
interface UndoEntry { key: string; changes: {id: string; before: {trip: Trip; deletedAt: string | null} | null; after: string}[] }
interface Options {
  store: WorkspaceStore;
  initialGuestTrips: Trip[];
  initialGuestError?: string | null;
  autoSync?: boolean;
  now?: () => number;
  uuid?: () => string;
  online?: () => boolean;
  /** Shorter values are useful for deterministic transport-failure tests. */
  requestTimeoutMs?: number;
}
const GUEST = 'guest';
const clone = <T,>(value: T): T => structuredClone(value);
const visible = (data: WorkspaceData | null) => Object.values(data?.records || {}).filter(record => !record.deletedAt && !record.archived).map(record => record.trip);
const desiredFingerprint = (record: LocalTrip) => JSON.stringify([cloudTripFingerprint(record.trip), !!record.deletedAt]);
const dirty = (record: LocalTrip) => !record.base ? !record.deletedAt : !!record.deletedAt !== !!record.base.deletedAt || !record.deletedAt && cloudTripFingerprint(record.trip) !== cloudTripFingerprint(record.base.trip);
const cloudRecord = (saved: CloudTrip): LocalTrip => ({trip: clone(saved.trip), deletedAt: saved.deletedAt, base: clone(saved), pending: null, conflict: false, remote: null});
const message = (error: unknown) => error instanceof Error ? error.message : 'The workspace could not be saved. Please try again.';
/** Revisions, receipts and leases can advance without replacing anything in an editor. */
const editorFingerprint = (data: WorkspaceData | null) => JSON.stringify(Object.entries(data?.records || {})
  .filter(([, record]) => !record.archived || record.conflict)
  .sort(([first], [second]) => first.localeCompare(second))
  .map(([id, record]) => [id, record.archived ? null : [cloudTripFingerprint(record.trip), record.deletedAt],
    record.conflict ? [cloudTripFingerprint(record.trip), record.remote ? [cloudTripFingerprint(record.remote.trip), record.remote.deletedAt] : null] : null]));

/** The only owner of trip persistence. UI actions and network acknowledgements meet here. */
export function createWorkspaceController(options: Options) {
  const {store} = options, now = options.now || Date.now, uuid = options.uuid || (() => crypto.randomUUID());
  const online = options.online || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const automatic = options.autoSync !== false, holder = uuid();
  const listeners = new Set<() => void>();
  let guest: WorkspaceData | null = null, account: WorkspaceData | null = null;
  let ownerId: string | null = null, remote: CloudRemote | null = null, scope: WorkspaceScope = 'guest';
  let initialized = false, disposed = false, epoch = 0, editing = false, acknowledgedCount = 0;
  const deferredWorkspaces = new Map<string, WorkspaceData>();
  let error: string | null = null, errorCode: string | null = null, writing = 0, syncing = false, refreshing = false;
  let undoEntries: UndoEntry[] = [], localQueue: Promise<unknown> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined, pollTimer: ReturnType<typeof setInterval> | undefined;
  let failures = 0, connected = false, guestError: string | null = null, channel: BroadcastChannel | null = null, refreshPromise: Promise<WorkspaceSnapshot> | null = null;
  const accountKey = () => ownerId ? 'account:' + ownerId : null;
  const key = () => scope === 'guest' ? GUEST : accountKey();
  const selected = () => scope === 'guest' ? guest : account;
  const still = (token: number, owner: string | null) => !disposed && token === epoch && ownerId === owner;
  const durableAccount = () => deferredWorkspaces.get(accountKey() || '') || account;
  const workCount = () => Object.values(durableAccount()?.records || {}).filter(record => record.pending || record.conflict || dirty(record)).length;
  const queuedCount = () => Object.values(durableAccount()?.records || {}).filter(record => record.pending && !record.conflict).length;
  const invalidateUndo = (changedKey: string, ids: string[]) => { undoEntries = undoEntries.filter(entry => entry.key !== changedKey || !entry.changes.some(change => ids.includes(change.id))); };
  const validUndo = (entry: UndoEntry) => entry.key === key() && entry.changes.every(change => {
    const current = selected()?.records[change.id];
    return !!current && !current.conflict && desiredFingerprint(current) === change.after;
  });
  const perStatus = (record?: LocalTrip): WorkspaceStatus => {
    if (writing) return 'saving';
    if (scope === 'guest') return errorCode === 'storage' || guestError ? 'failed' : 'local';
    if (record?.conflict) return 'conflict';
    if (errorCode === 'storage' || errorCode === 'invalid') return 'failed';
    if (errorCode === 'auth') return 'auth';
    if (errorCode === 'setup') return 'setup';
    if (!online() || errorCode === 'unavailable') return 'offline';
    if (!account?.remoteLoaded) return 'syncing';
    if (record && (record.pending || dirty(record))) return !online() || errorCode === 'unavailable' ? 'offline' : 'syncing';
    return 'saved';
  };
  let snapshot: WorkspaceSnapshot;
  function emit() {
    if (disposed) return;
    const data = selected(), trips = visible(data), records = Object.values(account?.records || {});
    const statusById = Object.fromEntries(trips.map(trip => [trip.id, perStatus(data?.records[trip.id])]));
    const conflicts = records.filter(record => record.conflict).map(record => ({id: record.trip.id, local: record.trip, remote: record.remote}));
    let status = perStatus();
    if (scope === 'account' && !writing && !errorCode) status = conflicts.length ? 'conflict' : !online() ? 'offline' : workCount() || !account?.remoteLoaded ? 'syncing' : 'saved';
    snapshot = {
      trips, guestTrips: visible(guest), ready: initialized && (scope === 'guest' ? !!guest && !guestError : !!account && (account.remoteLoaded || !online() || !!Object.keys(account.records).length || !!error)),
      scope, ownerId, error: scope === 'guest' ? guestError || error : error, status, statusById,
      updatedAtById: Object.fromEntries(records.filter(record => record.base).map(record => [record.trip.id, record.base!.updatedAt])),
      revisionById: Object.fromEntries(records.filter(record => record.base).map(record => [record.trip.id, record.base!.revision])),
      trash: Object.values(data?.records || {}).filter(record => record.deletedAt && !record.archived).map(record => ({trip: record.trip, revision: record.base?.revision || 0, updatedAt: record.base?.updatedAt || record.deletedAt!, deletedAt: record.deletedAt})),
      conflicts, canUndo: undoEntries.some(validUndo), pendingCount: workCount(), acknowledgedCount, busy: !!writing || syncing || refreshing,
      remoteUpdatesPending: deferredWorkspaces.size > 0,
    };
    for (const listener of listeners) listener();
  }
  emit();
  const notifyPeers = (changedKey: string) => channel?.postMessage({key: changedKey});
  function adopt(data: WorkspaceData, external = false) {
    const previous = data.key === GUEST ? guest : account;
    if (external && editing && editorFingerprint(previous) !== editorFingerprint(data)) { deferredWorkspaces.set(data.key, data); emit(); return; }
    deferredWorkspaces.delete(data.key);
    if (external) {
      invalidateUndo(data.key, Object.keys(previous?.records || {}).filter(id => !data.records[id] || desiredFingerprint(previous!.records[id]) !== desiredFingerprint(data.records[id]) || data.records[id].conflict));
    }
    if (data.key === GUEST) guest = data;
    else if (data.key === accountKey()) account = data;
    emit();
  }
  function report(reason: unknown, fallback = 'storage') {
    error = message(reason); errorCode = reason instanceof CloudError ? reason.code : fallback; emit();
  }
  function cleanError() { error = null; errorCode = null; }
  function cleanRemoteError() {
    // A successful fetch cannot prove that a failed local write was saved.
    // Schema/validation errors also need an explicit retry after correction.
    if (errorCode !== 'storage' && errorCode !== 'setup' && errorCode !== 'invalid') cleanError();
  }
  function nextMutation(record: LocalTrip): CloudMutation | null {
    if (record.conflict || record.pending || !dirty(record)) return record.pending;
    const base = record.base;
    if (!base && record.deletedAt) return null;
    const operation: CloudMutation['operation'] = !base ? 'create' : record.deletedAt ? 'delete' : base.deletedAt ? 'restore' : 'save';
    // Already deleted records have no further server work, even if a hidden local draft differs.
    if (base?.deletedAt && record.deletedAt) return null;
    return {tripId: record.trip.id, expectedRevision: base?.revision || 0, mutationId: uuid(), schemaVersion: CLOUD_SCHEMA_VERSION, operation,
      ...(operation === 'create' || operation === 'save' ? {trip: canonicalCloudTrip(record.trip)} : {})};
  }
  function assertTrips(trips: Trip[]) {
    if (!Array.isArray(trips) || trips.length > MAX_CLOUD_TRIPS || new Set(trips.map(trip => trip.id)).size !== trips.length) throw new Error('Keep up to 100 trips with unique IDs. Your saved plans have not changed.');
    const clean = trips.map(canonicalCloudTrip);
    if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > MAX_CLOUD_BYTES) throw new Error('These trips exceed the 4 MB workspace limit. Export a backup before removing older trips.');
    return clean;
  }
  function assertCapacity(state: WorkspaceData) {
    if (Object.keys(state.records).length > MAX_CLOUD_TRIPS) throw new Error('Your workspace can hold 100 trips including Trash. Export a backup before adding more trips.');
    assertTrips(Object.values(state.records).map(record => record.trip));
  }
  function localAction<T>(task: (capturedKey: string, token: number) => Promise<T>): Promise<T> {
    const capturedKey = key(), token = epoch;
    if (!initialized || !capturedKey || capturedKey === GUEST && guestError) return Promise.reject(new Error(guestError || 'Wait for this workspace to finish opening.'));
    writing += 1; emit();
    const result = localQueue.then(async () => {
      if (disposed || token !== epoch || key() !== capturedKey) throw new Error('The workspace changed. Try the action again in the current account.');
      return task(capturedKey, token);
    });
    localQueue = result.then(() => {}, () => {});
    return result.catch(reason => { if (token === epoch && !disposed) report(reason); throw reason; })
      .finally(() => { writing -= 1; emit(); scheduleSync(); });
  }
  async function ensureGuest() {
    const data = await store.update(GUEST, previous => {
      if (previous) return previous;
      if (options.initialGuestError) throw new Error(options.initialGuestError);
      const fresh = emptyWorkspace(GUEST);
      for (const trip of assertTrips(options.initialGuestTrips)) fresh.records[trip.id] = newLocalTrip(trip);
      return fresh;
    });
    return data;
  }
  async function reload() {
    const token = epoch, owner = ownerId;
    const [local, saved] = await Promise.all([store.read(GUEST), accountKey() ? store.read(accountKey()!) : Promise.resolve(null)]);
    if (!still(token, owner)) return;
    if (local) adopt(local, true);
    if (saved) adopt(saved, true);
    emit();
  }
  function connect() {
    if (!automatic || typeof window === 'undefined' || connected) return;
    connected = true;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('daytrail.workspace.changes.v1');
      channel.onmessage = event => {
        if (event.data?.key !== GUEST && event.data?.key !== accountKey()) return;
        void reload().then(() => scheduleSync()).catch(reason => report(reason));
      };
    }
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
  }
  const onFocus = () => { void reload().then(() => refresh()).catch(reason => report(reason)); };
  const onOnline = () => { failures = 0; cleanError(); emit(); void refresh(); scheduleSync(); };
  const onOffline = () => emit();
  const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };

  async function setIdentity(nextOwner: string | null, nextRemote: CloudRemote | null, authReady = true, authOffline = false) {
    disposed = false;
    const changed = ownerId !== (authReady ? nextOwner : null);
    const oldKey = accountKey();
    const token = ++epoch;
    ownerId = authReady ? nextOwner : null; remote = authReady ? nextRemote : null;
    const owner = ownerId, nextKey = owner ? 'account:' + owner : null;
    if(changed)acknowledgedCount=0;
    if (changed || !ownerId) { scope = ownerId ? 'account' : 'guest'; undoEntries = []; account = null; }
    initialized = false; syncing = false; refreshing = false; refreshPromise = null; deferredWorkspaces.clear();
    clearTimeout(retryTimer); retryTimer = undefined; cleanError(); emit(); connect();
    try {
      let local: WorkspaceData | null = null;
      let localError: string | null = null;
      try { local = await ensureGuest(); } catch (reason) { localError = message(reason); }
      const saved = nextKey ? await store.update(nextKey, previous => previous || emptyWorkspace(nextKey)) : null;
      if (token !== epoch || disposed) return snapshot;
      guest = local; guestError = localError; account = saved; initialized = true;
      if (owner && !remote && !authOffline) { error = 'Cloud saving is not configured. Your device trips are still available.'; errorCode = 'setup'; }
      emit();
      // Signed-out caches cannot become a guest library. Keep only durable pending drafts.
      if (oldKey && oldKey !== accountKey()) void store.update(oldKey, previous => {
        const old = previous || emptyWorkspace(oldKey);
        old.records = Object.fromEntries(Object.entries(old.records).filter(([, record]) => record.pending || record.conflict || dirty(record)));
        old.remoteLoaded = false; delete old.lease; return old;
      }).catch(() => {});
      if (automatic && ownerId) { void refresh(); scheduleSync(); }
    } catch (reason) { if (token === epoch) { initialized = false; report(reason); } }
    return snapshot;
  }

  function changeTrips(change: (current: Trip[]) => Trip[], _label?: string) {
    return localAction(async (capturedKey, token) => {
      const changes: UndoEntry['changes'] = [];
      const data = await store.update(capturedKey, previous => {
        const state = previous || emptyWorkspace(capturedKey);
        const next = assertTrips(change(clone(visible(state))));
        const nextIds = new Set(next.map(trip => trip.id));
        const touched = new Set<string>();
        for (const trip of next) {
          const before = state.records[trip.id];
          if (before && !before.deletedAt && !before.archived && cloudTripFingerprint(before.trip) === cloudTripFingerprint(trip)) continue;
          const record = before ? clone(before) : newLocalTrip(trip);
          record.trip = trip; record.deletedAt = null; record.archived = false;
          if (capturedKey !== GUEST) record.pending = nextMutation(record);
          state.records[trip.id] = record; touched.add(trip.id);
          changes.push({id: trip.id, before: before ? {trip: clone(before.trip), deletedAt: before.deletedAt} : null, after: desiredFingerprint(record)});
        }
        for (const [id, before] of Object.entries(state.records)) {
          if (touched.has(id) || nextIds.has(id) || before.deletedAt || before.archived) continue;
          const record = clone(before); record.deletedAt = new Date(now()).toISOString();
          if (capturedKey !== GUEST) record.pending = nextMutation(record);
          state.records[id] = record;
          changes.push({id, before: {trip: clone(before.trip), deletedAt: before.deletedAt}, after: desiredFingerprint(record)});
        }
        if (editing) for (const change of changes) {
          const displayed = selected()?.records[change.id];
          if (displayed && change.before && (cloudTripFingerprint(displayed.trip) !== cloudTripFingerprint(change.before.trip) || displayed.deletedAt !== change.before.deletedAt)) {
            throw new Error('This trip changed in another tab while you were editing. Keep a copy of your text, close the editor, and review the latest trip before trying again.');
          }
        }
        assertCapacity(state);
        return state;
      });
      if (token === epoch) {
        if (changes.length) undoEntries = [...undoEntries, {key: capturedKey, changes}].slice(-30);
        cleanError(); adopt(data); notifyPeers(capturedKey);
      }
      return snapshot;
    });
  }
  const replaceTrips = (next: Trip[], label?: string) => changeTrips(() => next, label);
  function undo() {
    return localAction(async (capturedKey, token) => {
      const entry = [...undoEntries].reverse().find(validUndo);
      if (!entry) return snapshot;
      const data = await store.update(capturedKey, previous => {
        if (!previous) throw new Error('The workspace is unavailable. Reload before undoing.');
        for (const change of entry.changes) {
          const current = previous.records[change.id];
          if (!current || current.conflict || desiredFingerprint(current) !== change.after) throw new Error('This trip changed elsewhere. The earlier undo is no longer available.');
          current.trip = clone(change.before?.trip || current.trip);
          current.deletedAt = change.before ? change.before.deletedAt : new Date(now()).toISOString();
          if (capturedKey !== GUEST) current.pending = nextMutation(current);
        }
        return previous;
      });
      if (token === epoch) { undoEntries = undoEntries.filter(value => value !== entry); cleanError(); adopt(data); notifyPeers(capturedKey); }
      return snapshot;
    });
  }
  async function setScope(next: WorkspaceScope) {
    await localQueue;
    if (next === 'account' && !ownerId) throw new Error('Sign in to open your account trips.');
    scope = next; undoEntries = []; editing = false; emit();
    await reload(); if (next === 'account') void refresh();
    return snapshot;
  }

  function matchesPending(record: LocalTrip, row: CloudTrip) {
    const pending = record.pending;
    if (!pending || row.revision !== pending.expectedRevision + 1) return false;
    if (pending.operation === 'delete') return !!row.deletedAt;
    if (row.deletedAt) return false;
    const expected = pending.trip || record.base?.trip;
    return !!expected && cloudTripFingerprint(row.trip) === cloudTripFingerprint(expected);
  }
  function receiveRow(state: WorkspaceData, row: CloudTrip) {
    const record = state.records[row.trip.id];
    if (!record) { state.records[row.trip.id] = cloudRecord(row); return; }
    if (record.base && row.revision <= record.base.revision) return;
    if (record.remote && row.revision <= record.remote.revision) return;
    if (matchesPending(record, row)) {
      record.base = clone(row); record.pending = null; record.conflict = false; record.remote = null;
      record.pending = nextMutation(record);
    } else if (record.pending || dirty(record) || record.conflict) {
      record.conflict = true; record.remote = clone(row); record.pending = null;
    } else {
      const replacement = cloudRecord(row); replacement.sourceGuest = record.sourceGuest; state.records[row.trip.id] = replacement;
    }
  }
  async function receiveRows(rows: CloudTrip[], token: number, owner: string) {
    if (!still(token, owner)) return;
    const changedKey = 'account:' + owner;
    const externallyChanged: string[] = [];
    const data = await store.update(changedKey, previous => {
      const state = previous || emptyWorkspace(changedKey);
      if (!still(token, owner)) return state;
      for (const row of rows) {
        const old = state.records[row.trip.id];
        if (old && row.revision > (old.base?.revision || 0) && !matchesPending(old, row)) externallyChanged.push(row.trip.id);
        receiveRow(state, row);
      }
      state.remoteLoaded = true;
      // Absence is never interpreted as a deletion: the server returns tombstones.
      return state;
    });
    // Merge through revision checks first, then hold only visible replacements.
    // This acknowledges our own writes while protecting open editors from peers.
    if (still(token, owner)) { cleanRemoteError(); invalidateUndo(changedKey, externallyChanged); adopt(data, true); notifyPeers(changedKey); await archiveAcknowledged(data, token, owner); }
  }
  async function bounded<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([request, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new CloudError('unavailable', 'Cloud saving took too long. Your device copy is safe; retry when the connection returns.')), options.requestTimeoutMs || 20_000); })]);
    } finally { clearTimeout(timer); }
  }
  function refresh(): Promise<WorkspaceSnapshot> {
    if (refreshPromise) return refreshPromise;
    const token = epoch, owner = ownerId, service = remote;
    if (!owner || !service || disposed) return Promise.resolve(snapshot);
    if (!online()) { emit(); return Promise.resolve(snapshot); }
    refreshing = true; emit();
    const result = (async () => {
      try { await receiveRows(await bounded(service.list()), token, owner); failures = 0; }
      catch (reason) { if (still(token, owner)) { report(reason, 'unavailable'); scheduleSync(true); } }
      finally { if (still(token, owner)) { refreshing = false; refreshPromise = null; emit(); scheduleSync(); } }
      return snapshot;
    })();
    refreshPromise = result; return result;
  }
  async function archiveAcknowledged(data: WorkspaceData, token: number, owner: string) {
    const sources = Object.values(data.records).filter(record => record.base && !record.base.deletedAt && record.sourceGuest);
    if (!sources.length || !still(token, owner)) return;
    const saved = await store.update(GUEST, previous => {
      const state = previous || emptyWorkspace(GUEST);
      if (!still(token, owner)) return state;
      for (const record of sources) {
        const source = record.sourceGuest!, existing = state.records[source.id];
        if (existing && !existing.deletedAt && cloudTripFingerprint(existing.trip) === source.fingerprint) existing.archived = true;
      }
      return state;
    });
    if (still(token, owner)) { adopt(saved, true); notifyPeers(GUEST); }
  }

  function scheduleSync(backoff = false) {
    if (!automatic || disposed || !ownerId || !remote || syncing || !online() || ['auth', 'setup', 'invalid', 'storage'].includes(errorCode || '')) return;
    if (retryTimer) return;
    const delay = backoff ? Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)) : 100;
    retryTimer = setTimeout(() => { retryTimer = undefined; void sync(); }, delay);
  }
  async function sync() {
    const token = epoch, owner = ownerId, service = remote;
    if (!owner || !service || disposed || syncing || !online() || ['auth', 'setup', 'invalid', 'storage'].includes(errorCode || '')) return snapshot;
    const changedKey = 'account:' + owner;
    syncing = true; emit();
    let hasLease = false, backoff = false, heartbeat: ReturnType<typeof setInterval> | undefined;
    const leaseHolder = holder + ':' + token + ':' + uuid();
    try {
      const leased = await store.update(changedKey, previous => {
        const state = previous || emptyWorkspace(changedKey);
        if (!state.lease || state.lease.until <= now()) state.lease = {holder: leaseHolder, until: now() + 30_000};
        return state;
      });
      hasLease = leased.lease?.holder === leaseHolder;
      if (!hasLease) { backoff = true; return snapshot; }
      heartbeat = setInterval(() => {
        void store.update(changedKey, previous => {
          const state = previous || emptyWorkspace(changedKey);
          if (still(token, owner) && state.lease?.holder === leaseHolder) state.lease.until = now() + 30_000;
          return state;
        }).catch(() => {});
      }, 10_000);
      for (let requests = 0; requests < 100 && still(token, owner); requests++) {
        const current = await store.read(changedKey);
        if (!current || current.lease?.holder !== leaseHolder) break;
        const record = Object.values(current.records).find(value => value.pending && !value.conflict);
        if (!record?.pending) break;
        const mutation = clone(record.pending);
        try {
          const acknowledged = await bounded(service.mutate(mutation));let accepted=false;
          if (!still(token, owner)) break;
          const saved = await store.update(changedKey, previous => {
            const state = previous || emptyWorkspace(changedKey), latest = state.records[mutation.tripId];
            if (!still(token, owner) || !latest || latest.pending?.mutationId !== mutation.mutationId) return state;
            accepted=true;latest.base = clone(acknowledged); latest.pending = null; latest.conflict = false; latest.remote = null;
            latest.pending = nextMutation(latest); state.remoteLoaded = true; return state;
          });
          if (still(token, owner)) { if(accepted)acknowledgedCount++;cleanRemoteError(); failures = 0; adopt(saved, true); notifyPeers(changedKey); await archiveAcknowledged(saved, token, owner); }
        } catch (reason) {
          if (!still(token, owner)) break;
          if (reason instanceof CloudError && reason.code === 'conflict') {
            const saved = await store.update(changedKey, previous => {
              const state = previous || emptyWorkspace(changedKey), latest = state.records[mutation.tripId];
              if (still(token, owner) && latest?.pending?.mutationId === mutation.mutationId) { latest.conflict = true; latest.remote = reason.current ? clone(reason.current) : null; latest.pending = null; }
              return state;
            });
            adopt(saved, true); notifyPeers(changedKey);
          } else { report(reason, 'unavailable'); backoff = true; break; }
        }
      }
    } catch (reason) { if (still(token, owner)) report(reason); }
    finally {
      clearInterval(heartbeat);
      if (hasLease) await store.update(changedKey, previous => { const state = previous || emptyWorkspace(changedKey); if (state.lease?.holder === leaseHolder) delete state.lease; return state; }).catch(() => {});
      if (still(token, owner)) { syncing = false; emit(); if (queuedCount()) scheduleSync(backoff || errorCode === 'unavailable'); }
    }
    return snapshot;
  }

  function migrateGuest(ids: string[]) {
    return localAction(async (_capturedKey, token) => {
      const owner = ownerId;
      if (!owner) throw new Error('Sign in before saving device trips to your account.');
      const local = await store.read(GUEST);
      const sources = [...new Set(ids)].map(id => local?.records[id]).filter((record): record is LocalTrip => !!record && !record.deletedAt && !record.archived);
      if (sources.length !== new Set(ids).size) throw new Error('A selected device trip changed. Review the list and try again.');
      let addedCount = 0, skippedCount = 0;
      const saved = await store.update('account:' + owner, previous => {
        const state = previous || emptyWorkspace('account:' + owner);
        for (const source of sources) {
          const fingerprint = cloudTripFingerprint(source.trip);
          if (state.imports.some(item => item.sourceId === source.trip.id && item.fingerprint === fingerprint)) { skippedCount++; continue; }
          if (Object.keys(state.records).length >= MAX_CLOUD_TRIPS) throw new Error('Your account can hold 100 trips including Trash. No selected trips were copied.');
          const trip = canonicalCloudTrip(source.trip); trip.id = uuid();
          const record = newLocalTrip(trip); record.sourceGuest = {id: source.trip.id, fingerprint}; record.pending = nextMutation(record);
          state.records[trip.id] = record; state.imports.push({sourceId: source.trip.id, fingerprint, cloudId: trip.id}); addedCount++;
        }
        assertCapacity(state);
        return state;
      });
      if (still(token, owner)) { scope = 'account'; undoEntries = []; cleanError(); adopt(saved); notifyPeers(saved.key); }
      return {addedCount, skippedCount};
    });
  }
  function resolveConflict(id: string, choice: 'remote' | 'copy') {
    return localAction(async (_capturedKey, token) => {
      const owner = ownerId;
      if (!owner) throw new Error('Sign in to resolve this trip.');
      const changedKey = 'account:' + owner;
      const data = await store.update(changedKey, previous => {
        const state = previous || emptyWorkspace(changedKey), record = state.records[id];
        if (!record?.conflict) return state;
        if (!record.remote && choice === 'remote') throw new Error('The newest saved version is unavailable. Refresh before choosing it.');
        if (choice === 'copy') {
          if (Object.keys(state.records).length >= MAX_CLOUD_TRIPS) throw new Error('There is no room for another trip. Export your local version before resolving this conflict.');
          const trip = canonicalCloudTrip(record.trip); trip.id = uuid(); trip.name = trip.name.slice(0, 145) + ' (my changes)';
          const copy = newLocalTrip(trip); copy.pending = nextMutation(copy); state.records[trip.id] = copy;
        }
        if (record.remote) state.records[id] = cloudRecord(record.remote);
        else delete state.records[id];
        assertCapacity(state);
        return state;
      });
      if (still(token, owner)) { cleanError(); undoEntries = undoEntries.filter(entry => !entry.changes.some(change => change.id === id)); adopt(data); notifyPeers(changedKey); }
      return snapshot;
    });
  }
  function restore(id: string) {
    return localAction(async (capturedKey, token) => {
      const owner = ownerId;
      const data = await store.update(capturedKey, previous => {
        const state = previous || emptyWorkspace(capturedKey), record = state.records[id];
        if (record) { record.deletedAt = null; if (capturedKey !== GUEST) record.pending = nextMutation(record); }
        return state;
      });
      if (still(token, owner)) { cleanError(); adopt(data); notifyPeers(data.key); }
      return snapshot;
    });
  }
  async function setEditing(value: boolean) {
    editing = value;
    if (value) return;
    try {
      if (deferredWorkspaces.size) await reload();
    } catch (reason) { report(reason); }
    emit();
  }
  async function prepareSignOut(keepDrafts: boolean) {
    await localQueue;
    if (errorCode === 'storage') throw new Error('Device saving failed. Keep this tab open and resolve it before signing out.');
    const latest = accountKey() ? await store.read(accountKey()!) : null;
    if (latest) {account = latest; deferredWorkspaces.delete(latest.key);}
    if (!keepDrafts && workCount()) throw new Error('Some account changes have not synced. Wait for saving or choose to keep these drafts on this device.');
    emit(); return snapshot;
  }
  async function retry() {
    cleanError(); failures = 0; clearTimeout(retryTimer); retryTimer = undefined;
    if (!initialized || guestError) await setIdentity(ownerId, remote);
    await reload(); await refresh(); return sync();
  }
  function dispose() {
    disposed = true; epoch++; clearTimeout(retryTimer); retryTimer = undefined; clearInterval(pollTimer); pollTimer = undefined;
    channel?.close(); channel = null; connected = false;
    if (typeof window !== 'undefined') { window.removeEventListener('focus', onFocus); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); document.removeEventListener('visibilitychange', onVisibility); }
    store.close?.();
  }
  return {getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setIdentity, setScope, changeTrips, replaceTrips, undo, refresh, retry, sync, reload, migrateGuest, resolveConflict, restore, setEditing, prepareSignOut, dispose};
}
