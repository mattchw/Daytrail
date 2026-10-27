import type {TodayCommit,TodayPersistence} from '../today/persistence';
import type {Trip} from '../model';
import {travelTargetReferences} from './model';
import {TravelError, type TravelMark, type TravelMutation, type TravelRemote, type TravelState} from './types';
import {emptyTravelWorkspace, emptyTripProgress, newLocalTravelMark, type LocalTravelMark, type TravelStore, type TravelWorkspace} from './storage';

export type TravelSaveStatus = 'local' | 'saving' | 'syncing' | 'saved' | 'offline' | 'auth' | 'conflict' | 'failed' | 'setup';
export interface TravelContext {
  ownerId: string | null;
  scope: 'guest' | 'account';
  trip: Trip | null;
  enabled: boolean;
  authReady: boolean;
  authOffline?: boolean;
  tripCloudReady: boolean;
  /** Only acknowledged, non-conflicted itinerary IDs are safe for progress requests. */
  cloudReadyTripIds?: string[];
}
export interface TravelSnapshot {
  ownerId: string | null;
  scope: 'guest' | 'account';
  tripId: string | null;
  referenceKey: string;
  marks: Record<string, TravelState>;
  ready: boolean;
  status: TravelSaveStatus;
  error: string | null;
  pendingCount: number;
  acknowledgedCount: number;
  pendingTripIds: string[];
  conflicts: {targetId: string; placeId: string; local: TravelState; remote: TravelMark | null; rejected: boolean}[];
  busy: boolean;
  canUndo: boolean;
}
interface Options {
  store: TravelStore;
  autoSync?: boolean;
  online?: () => boolean;
  uuid?: () => string;
  now?: () => number;
  requestTimeoutMs?: number;
}
interface UndoEntry {key: string; tripId: string; targetId: string; before: {placeId: string; state: TravelState}; after: string}
const clone = <T,>(value: T): T => structuredClone(value);
const fingerprint = (value: {placeId: string; state: TravelState}) => JSON.stringify([value.placeId, value.state]);
// Include absence and acknowledged revisions: the same displayed state can
// still represent a newer decision made in another tab.
const markVersion = (value: LocalTravelMark | undefined) => value
  ? JSON.stringify([value.placeId, value.state, value.base?.revision ?? null, value.conflict, value.remote?.revision ?? null, value.error]) : null;
const dirty = (value: LocalTravelMark) => !value.base || fingerprint(value) !== fingerprint(value.base);
const fromRemote = (value: TravelMark): LocalTravelMark => ({placeId: value.placeId, state: value.state, base: clone(value), pending: null, conflict: false, remote: null, error: null});
const isWaiting = (value: LocalTravelMark) => !!value.pending || value.conflict || !!value.error || dirty(value);
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Travel progress could not be saved. Please retry.';

/** One owner-scoped controller keeps pending progress from every opened trip. */
export function createTravelController(options: Options) {
  const {store} = options, uuid = options.uuid || (() => crypto.randomUUID()), now = options.now || Date.now;
  const online = options.online || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const automatic = options.autoSync !== false;
  let context: TravelContext = {ownerId: null, scope: 'guest', trip: null, enabled: false, authReady: false, tripCloudReady: false};
  let ownerId: string | null = null, remote: TravelRemote | null = null, guest: TravelWorkspace | null = null, account: TravelWorkspace | null = null;
  let initialized = false, disposed = false, epoch = 0, selection = 0, writing = 0, syncing = false, refreshes = 0, acknowledgedCount = 0;
  let error: string | null = null, errorCode: string | null = null, guestError: string | null = null;
  let localQueue: Promise<unknown> = Promise.resolve(), undoEntries: UndoEntry[] = [], failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, pollTimer: ReturnType<typeof setInterval> | undefined;
  let connected = false, channel: BroadcastChannel | null = null;
  const inRefresh = new Map<string, Promise<void>>(), listeners = new Set<() => void>();
  const accountKey = () => ownerId ? 'account:' + ownerId : null;
  const currentKey = () => context.scope === 'guest' ? 'guest' : accountKey();
  const currentData = () => context.scope === 'guest' ? guest : account;
  const tripId = () => context.trip?.id || null;
  const currentTrip = () => tripId() ? currentData()?.trips[tripId()!] : undefined;
  const still = (token: number, owner: string | null) => !disposed && epoch === token && ownerId === owner;
  const readyIds = () => new Set(context.cloudReadyTripIds || (context.tripCloudReady && context.trip ? [context.trip.id] : []));
  const pendingTrips = () => Object.entries(account?.trips || {}).filter(([, trip]) => Object.values(trip.marks).some(isWaiting));
  const pendingCount = () => pendingTrips().reduce((sum, [, trip]) => sum + Object.values(trip.marks).filter(isWaiting).length, 0);
  const validUndo = (entry: UndoEntry) => {
    const mark = currentTrip()?.marks[entry.targetId];
    return entry.key === currentKey() && entry.tripId === tripId() && !!mark && !mark.conflict && !mark.error
      && fingerprint(mark) === entry.after && currentTrip()?.targets[entry.targetId] === mark.placeId;
  };
  const invalidateUndo = (key: string, id: string, target: string) => { undoEntries = undoEntries.filter(entry => entry.key !== key || entry.tripId !== id || entry.targetId !== target); };
  let snapshot: TravelSnapshot;
  function emit() {
    if (disposed) return;
    const trip = currentTrip(), markEntries = Object.entries(trip?.marks || {});
    const marks = Object.fromEntries(Object.entries(trip?.targets || {}).map(([id, placeId]) => {
      const saved = trip?.marks[id]; return [id, saved?.placeId === placeId ? saved.state : 'planned'];
    })) as Record<string, TravelState>;
    const conflicts = markEntries.filter(([, value]) => value.conflict || value.error).map(([targetId, value]) => ({targetId, placeId: value.placeId, local: value.state, remote: value.remote, rejected: !!value.error}));
    const count = pendingCount();
    const selectedError = context.scope === 'guest' ? guestError || error : error || trip?.error || markEntries.find(([, value]) => value.error)?.[1].error || null;
    let status: TravelSaveStatus = context.scope === 'guest' ? 'local' : 'saved';
    if (context.scope === 'account') {
      if (!online() || errorCode === 'unavailable') status = 'offline';
      else if (count || context.trip && !trip?.remoteLoaded) status = 'syncing';
      if (conflicts.length) status = 'conflict';
      if (errorCode === 'auth' || errorCode === 'setup') status = errorCode;
    }
    if (selectedError && (errorCode === 'storage' || !['auth', 'setup', 'unavailable'].includes(errorCode || '') && !conflicts.length)) status = 'failed';
    if (writing) status = 'saving';
    snapshot = {ownerId, scope: context.scope, tripId: tripId(), referenceKey: JSON.stringify(Object.entries(trip?.targets || {})), marks,
      ready: initialized && context.enabled && !!trip && (context.scope === 'guest' ? !guestError : !!ownerId
        && (trip.remoteLoaded || !online() || !context.tripCloudReady || !!markEntries.length || !!selectedError)),
      status, error: selectedError, pendingCount: count, acknowledgedCount, pendingTripIds: pendingTrips().map(([id]) => id),
      conflicts, busy: writing > 0 || syncing || refreshes > 0, canUndo: undoEntries.some(validUndo)};
    for (const listener of listeners) listener();
  }
  emit();
  function report(reason: unknown, fallback = 'storage') { error = message(reason); errorCode = reason instanceof TravelError ? reason.code : fallback; emit(); }
  function clearError() { error = null; errorCode = null; }
  function clearRemoteError() { if (!['storage', 'setup', 'invalid'].includes(errorCode || '')) clearError(); }
  const notify = (key: string) => channel?.postMessage({key});
  function adopt(data: TravelWorkspace, external = false) {
    const previous = data.key === 'guest' ? guest : account;
    if (external) for (const [id, trip] of Object.entries(previous?.trips || {})) for (const [target, mark] of Object.entries(trip.marks)) {
      const next = data.trips[id]?.marks[target];
      const revisionChanged = next?.base?.revision !== mark.base?.revision && !(next?.base && matchesPending(mark, next.base));
      if (!next || fingerprint(mark) !== fingerprint(next) || revisionChanged || next.conflict || next.error) invalidateUndo(data.key, id, target);
    }
    if (data.key === 'guest') guest = data;
    else if (data.key === accountKey()) account = data;
    emit();
  }
  function nextMutation(id: string, targetId: string, mark: LocalTravelMark): TravelMutation | null {
    if (mark.pending || mark.conflict || mark.error || !dirty(mark)) return mark.pending;
    return {tripId: id, targetId, placeId: mark.placeId, state: mark.state, expectedRevision: mark.base?.revision || 0, mutationId: uuid()};
  }
  function connect() {
    if (!automatic || connected || typeof window === 'undefined') return;
    connected = true;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('daytrail.travel.changes.v1');
      channel.onmessage = event => { if (event.data?.key === 'guest' || event.data?.key === accountKey()) void reload().then(() => scheduleSync()).catch(report); };
    }
    window.addEventListener('focus', onFocus); window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
  }
  const onFocus = () => { void reload().then(() => refresh()).catch(report); };
  const onOnline = () => { failures = 0; if (errorCode === 'unavailable') clearError(); emit(); void refresh(); scheduleSync(); };
  const onOffline = () => emit();
  const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };

  async function setContext(next: TravelContext, service: TravelRemote | null) {
    disposed = false;
    const effectiveOwner = next.authReady ? next.ownerId : null;
    const identityChanged = ownerId !== effectiveOwner;
    const oldKey = accountKey();
    if (identityChanged || !initialized) { epoch++; initialized = false; inRefresh.clear(); refreshes = 0; syncing = false; clearTimeout(retryTimer); retryTimer = undefined; clearError(); }
    if (identityChanged) { acknowledgedCount=0;account = null; undoEntries = []; }
    if (context.scope !== next.scope || context.trip?.id !== next.trip?.id) undoEntries = [];
    ownerId = effectiveOwner; remote = effectiveOwner ? service : null; context = next;
    const token = epoch, owner = ownerId, choice = ++selection, key = currentKey(), id = tripId();
    const targets = next.trip ? travelTargetReferences(next.trip) : {};
    emit(); connect();
    try {
      let local: TravelWorkspace | null = null, localError: string | null = null;
      try { local = await store.update('guest', previous => previous || emptyTravelWorkspace('guest')); }
      catch (reason) { localError = message(reason); }
      const accountScope = owner ? 'account:' + owner : null;
      let saved = accountScope ? await store.update(accountScope, previous => previous || emptyTravelWorkspace(accountScope)) : null;
      if (key && id) {
        const updated = await store.update(key, previous => {
          const data = previous || emptyTravelWorkspace(key);
          if (!still(token, owner) || choice !== selection) return data;
          const trip = data.trips[id] || emptyTripProgress(); trip.targets = targets; data.trips[id] = trip; return data;
        });
        if (key === 'guest') { local = updated; localError = null; } else saved = updated;
      }
      if (!still(token, owner) || choice !== selection) return snapshot;
      guest = local; guestError = localError; account = saved; initialized = true;
      if (owner && !remote && !next.authOffline) { error = 'Cloud travel progress is not configured. Your progress can stay on this device.'; errorCode = 'setup'; }
      emit();
      if (oldKey && oldKey !== accountKey()) void store.update(oldKey, previous => {
        const data = previous || emptyTravelWorkspace(oldKey);
        for (const trip of Object.values(data.trips)) { trip.marks = Object.fromEntries(Object.entries(trip.marks).filter(([, mark]) => isWaiting(mark))); trip.remoteLoaded = false; }
        delete data.lease; return data;
      }).catch(() => {});
      if (automatic) { void refresh(); scheduleSync(); }
    } catch (reason) { if (still(token, owner) && choice === selection) { initialized = false; report(reason); } }
    return snapshot;
  }
  async function reload() {
    const token = epoch, owner = ownerId, key = accountKey();
    const values = await Promise.allSettled([store.read('guest'), key ? store.read(key) : Promise.resolve(null)]);
    if (!still(token, owner)) return;
    if (values[0].status === 'fulfilled') { guestError = null; if (values[0].value) adopt(values[0].value, true); }
    else guestError = message(values[0].reason);
    // A broken device-only library must not stop the independent account outbox.
    if (values[1].status === 'fulfilled') { if (values[1].value) adopt(values[1].value, true); }
    else { report(values[1].reason); throw values[1].reason; }
    emit();
  }
  function localAction(task: (key: string, id: string, token: number) => Promise<void>): Promise<void> {
    const key = currentKey(), id = tripId(), token = epoch;
    if (!snapshot.ready || !key || !id) return Promise.reject(new Error('Wait for this trip’s progress to finish opening.'));
    writing++; emit();
    const result = localQueue.then(async () => {
      if (!still(token, ownerId) || key !== currentKey() || id !== tripId()) throw new Error('The selected trip changed. Try the action again in the current trip.');
      await task(key, id, token);
    });
    localQueue = result.then(() => {}, () => {});
    return result.catch(reason => { if (token === epoch && !disposed) report(reason); throw reason; }).finally(() => { writing--; emit(); scheduleSync(); });
  }
  function setState(targetId: string, state: TravelState) {
    return localAction(async (key, id, token) => {
      const placeId = currentTrip()?.targets[targetId];
      if (!placeId || !['planned', 'done', 'skipped'].includes(state) || targetId.startsWith('end:') && state === 'skipped') throw new Error('This stop is no longer available for that action.');
      let entry: UndoEntry | null = null;
      const saved = await store.update(key, previous => {
        const data = previous || emptyTravelWorkspace(key), trip = data.trips[id];
        if (!trip || trip.targets[targetId] !== placeId) throw new Error('This stop changed in another tab. Review the itinerary before recording progress.');
        const before = trip.marks[targetId], displayed = currentTrip()?.marks[targetId];
        if (before?.conflict) throw new Error('Choose which progress to keep before updating this stop.');
        if (markVersion(before) !== markVersion(displayed)) throw new TravelError('conflict', 'Progress changed in another tab. Review the current status before trying again.');
        const mark = before ? clone(before) : newLocalTravelMark(placeId, state);
        if (mark.error) { mark.error = null; mark.pending = null; }
        mark.placeId = placeId; mark.state = state;
        if (key !== 'guest') mark.pending = nextMutation(id, targetId, mark);
        trip.marks[targetId] = mark; trip.error = null;
        if (!before || fingerprint(before) !== fingerprint(mark)) entry = {key, tripId: id, targetId, before: before && before.placeId === placeId ? {placeId: before.placeId, state: before.state} : {placeId, state: 'planned'}, after: fingerprint(mark)};
        return data;
      });
      if (token === epoch) { if (entry) undoEntries = [...undoEntries, entry].slice(-40); clearError(); adopt(saved); notify(key); }
    });
  }
  const todayPersistence:TodayPersistence={
    async read(dayId){
      const key=currentKey(),id=tripId(),token=epoch;
      if(!key||!id||!snapshot.ready)throw new Error('Wait for this trip’s progress to finish opening.');
      const saved=await store.read(key);
      if(token!==epoch||key!==currentKey()||id!==tripId())throw new Error('The selected trip changed. Open Today again.');
      return saved?.trips[id]?.today?.[dayId]||null;
    },
    commit(change:TodayCommit){return localAction(async(key,id,token)=>{
      if(!context.trip?.days.some(day=>day.id===change.dayId))throw new Error('This day is no longer in the trip.');
      const saved=await store.update(key,previous=>{
        const data=previous||emptyTravelWorkspace(key),trip=data.trips[id];
        if(!trip||(trip.today?.[change.dayId]||null)!==change.previous)throw new Error('Today changed in another tab. Reopen Today before continuing.');
        if(change.mark){const {targetId,previous:expected,expected:state}=change.mark,placeId=trip.targets[targetId];
          if(!placeId||!['planned','done','skipped'].includes(state)||targetId.startsWith('end:')&&state==='skipped')throw new Error('This stop is no longer available for that action.');
          const before=trip.marks[targetId];
          if(before?.conflict||before?.error||(before?.placeId===placeId?before.state:'planned')!==expected||markVersion(before)!==markVersion(currentTrip()?.marks[targetId]))throw new Error('Progress changed elsewhere. Review Today before continuing.');
          const mark=before?clone(before):newLocalTravelMark(placeId,state);mark.placeId=placeId;mark.state=state;
          if(key!=='guest')mark.pending=nextMutation(id,targetId,mark);trip.marks[targetId]=mark;trip.error=null;
        }
        trip.today??={};if(change.next===null)delete trip.today[change.dayId];else trip.today[change.dayId]=change.next;
        return data;
      });
      if(token===epoch){clearError();adopt(saved);notify(key);}
    });}
  };
  function undo() {
    return localAction(async (key, id, token) => {
      const entry = [...undoEntries].reverse().find(validUndo); if (!entry) return;
      const saved = await store.update(key, previous => {
        const data = previous || emptyTravelWorkspace(key), trip = data.trips[id], mark = trip?.marks[entry.targetId];
        if (!mark || mark.conflict || mark.error || fingerprint(mark) !== entry.after || trip.targets[entry.targetId] !== entry.before.placeId) throw new Error('This stop changed elsewhere. Its previous Undo is no longer available.');
        if (markVersion(mark) !== markVersion(currentTrip()?.marks[entry.targetId])) throw new TravelError('conflict', 'Progress changed in another tab. Review the current status before trying Undo again.');
        mark.placeId = entry.before.placeId; mark.state = entry.before.state;
        if (key !== 'guest') mark.pending = nextMutation(id, entry.targetId, mark); return data;
      });
      if (token === epoch) { undoEntries = undoEntries.filter(value => value !== entry); clearError(); adopt(saved); notify(key); }
    });
  }
  function matchesPending(mark: LocalTravelMark, remoteMark: TravelMark) {
    return !!mark.pending && remoteMark.revision === mark.pending.expectedRevision + 1 && fingerprint(remoteMark) === fingerprint(mark.pending);
  }
  async function receiveRows(id: string, rows: TravelMark[], token: number, owner: string) {
    if (!still(token, owner)) return;
    const key = 'account:' + owner, invalidated: string[] = [];
    const saved = await store.update(key, previous => {
      const data = previous || emptyTravelWorkspace(key); if (!still(token, owner)) return data;
      const trip = data.trips[id] || emptyTripProgress();
      for (const row of rows) {
        const mark = trip.marks[row.targetId];
        if (!mark) { trip.marks[row.targetId] = fromRemote(row); continue; }
        if (row.revision <= (mark.base?.revision || 0) || row.revision <= (mark.remote?.revision || 0)) continue;
        if (matchesPending(mark, row)) {
          mark.base = clone(row); mark.pending = null; mark.conflict = false; mark.remote = null; mark.error = null;
          mark.pending = nextMutation(id, row.targetId, mark);
        } else {
          invalidated.push(row.targetId);
          if (isWaiting(mark)) { mark.conflict = true; mark.remote = clone(row); mark.pending = null; mark.error = null; }
          else trip.marks[row.targetId] = fromRemote(row);
        }
      }
      trip.remoteLoaded = true; trip.error = null; data.trips[id] = trip; return data;
    });
    if (still(token, owner)) { for (const target of invalidated) invalidateUndo(key, id, target); clearRemoteError(); adopt(saved); notify(key); }
  }
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TravelError('unavailable', 'Travel progress is taking longer to sync. Your device copy is safe; retry when connected.')), options.requestTimeoutMs || 20_000); })]); }
    finally { clearTimeout(timer); }
  }
  async function refresh() {
    const token = epoch, owner = ownerId, service = remote, id = tripId();
    if (!owner || !service || disposed || !online() || !id || context.scope !== 'account' || !readyIds().has(id)) { emit(); return; }
    const refreshKey = token + ':' + id;
    if (inRefresh.has(refreshKey)) return inRefresh.get(refreshKey);
    refreshes++; emit();
    const promise = (async () => {
      try { await receiveRows(id, await bounded(service.list(id)), token, owner); }
      catch (reason) { if (still(token, owner)) report(reason, 'unavailable'); }
      finally { if (still(token, owner)) { refreshes--; inRefresh.delete(refreshKey); emit(); scheduleSync(); } }
    })();
    inRefresh.set(refreshKey, promise); return promise;
  }
  function scheduleSync(backoff = false) {
    if (!automatic || disposed || syncing || retryTimer || !ownerId || !remote || !online() || ['auth', 'setup', 'invalid', 'storage'].includes(errorCode || '')) return;
    const delay = backoff ? Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)) : 100;
    retryTimer = setTimeout(() => { retryTimer = undefined; void sync(); }, delay);
  }
  async function sync() {
    const token = epoch, owner = ownerId, service = remote;
    if (!owner || !service || disposed || syncing || !online() || ['auth', 'setup', 'invalid', 'storage'].includes(errorCode || '')) return;
    const key = 'account:' + owner, holder = uuid(); let leased = false, backoff = false, heartbeat: ReturnType<typeof setInterval> | undefined;
    syncing = true; emit();
    try {
      const data = await store.update(key, previous => {
        const value = previous || emptyTravelWorkspace(key);
        if (!value.lease || value.lease.until <= now()) value.lease = {holder, until: now() + 30_000}; return value;
      });
      leased = data.lease?.holder === holder;
      if (!leased) { backoff = true; return; }
      heartbeat = setInterval(() => { void store.update(key, previous => {
        const value = previous || emptyTravelWorkspace(key); if (still(token, owner) && value.lease?.holder === holder) value.lease.until = now() + 30_000; return value;
      }).catch(() => {}); }, 10_000);
      for (let request = 0; request < 100 && still(token, owner); request++) {
        const latest = await store.read(key); if (!latest || latest.lease?.holder !== holder) break;
        const permitted = readyIds(); let mutation: TravelMutation | null = null;
        for (const [id, trip] of Object.entries(latest.trips)) {
          if (!permitted.has(id)) continue;
          const mark = Object.values(trip.marks).find(value => value.pending && !value.conflict && !value.error);
          if (mark?.pending) { mutation = clone(mark.pending); break; }
        }
        if (!mutation) break;
        const sent = mutation;
        try {
          const acknowledged = await bounded(service.mutate(sent)); if (!still(token, owner)) break;let accepted=false;
          const saved = await store.update(key, previous => {
            const value = previous || emptyTravelWorkspace(key), mark = value.trips[sent.tripId]?.marks[sent.targetId];
            if (!still(token, owner) || mark?.pending?.mutationId !== sent.mutationId) return value;
            accepted=true;mark.base = clone(acknowledged); mark.pending = null; mark.conflict = false; mark.remote = null; mark.error = null;
            mark.pending = nextMutation(sent.tripId, sent.targetId, mark); return value;
          });
          if (still(token, owner)) { if(accepted)acknowledgedCount++;clearRemoteError(); failures = 0; adopt(saved); notify(key); }
        } catch (reason) {
          if (!still(token, owner)) break;
          if (reason instanceof TravelError && (reason.code === 'conflict' || reason.code === 'invalid')) {
            const saved = await store.update(key, previous => {
              const value = previous || emptyTravelWorkspace(key), mark = value.trips[sent.tripId]?.marks[sent.targetId];
              if (!still(token, owner) || mark?.pending?.mutationId !== sent.mutationId) return value;
              if (reason.code === 'conflict') { mark.conflict = true; mark.remote = reason.current ? clone(reason.current) : null; mark.pending = null; }
              else if (fingerprint(mark) !== fingerprint(sent)) {
                // The server rejected the old intent, so a newer local intent can
                // safely replace it. Unknown/lost acknowledgements never do this.
                mark.pending = null; mark.error = null; mark.pending = nextMutation(sent.tripId, sent.targetId, mark);
              } else mark.error = reason.message;
              return value;
            });
            invalidateUndo(key, sent.tripId, sent.targetId); adopt(saved); notify(key);
          } else { report(reason, 'unavailable'); backoff = true; break; }
        }
      }
    } catch (reason) { if (still(token, owner)) report(reason); }
    finally {
      clearInterval(heartbeat);
      if (leased) await store.update(key, previous => { const value = previous || emptyTravelWorkspace(key); if (value.lease?.holder === holder) delete value.lease; return value; }).catch(() => {});
      if (still(token, owner)) {
        syncing = false; emit();
        const permitted = readyIds();
        if (Object.entries(account?.trips || {}).some(([id, trip]) => permitted.has(id) && Object.values(trip.marks).some(mark => mark.pending && !mark.conflict && !mark.error))) scheduleSync(backoff || errorCode === 'unavailable');
      }
    }
  }
  function resolveConflict(targetId: string, choice: 'remote' | 'local') {
    return localAction(async (key, id, token) => {
      if (key === 'guest') return;
      const saved = await store.update(key, previous => {
        const data = previous || emptyTravelWorkspace(key), trip = data.trips[id], mark = trip?.marks[targetId];
        if (!mark || !mark.conflict && !mark.error) return data;
        const targetPlace = trip.targets[targetId], newest = mark.remote || mark.base;
        if (choice === 'local' && (!targetPlace || targetPlace !== mark.placeId)) throw new Error('This stop’s location changed. Use the saved progress, then record the new stop separately.');
        if (choice === 'local' && mark.conflict && !mark.remote) throw new Error('The newest progress is unavailable. Refresh before keeping your version.');
        if (choice === 'remote') {
          if (mark.conflict && !mark.remote) throw new Error('The newest progress is unavailable. Refresh before choosing it.');
          if (newest) trip.marks[targetId] = fromRemote(newest); else delete trip.marks[targetId];
        } else {
          mark.base = newest ? clone(newest) : null; mark.pending = null; mark.conflict = false; mark.remote = null; mark.error = null;
          mark.pending = nextMutation(id, targetId, mark);
        }
        return data;
      });
      if (token === epoch) { invalidateUndo(key, id, targetId); clearError(); adopt(saved); notify(key); }
    });
  }
  async function prepareSignOut(keepDrafts: boolean) {
    await localQueue;
    if (errorCode === 'storage') throw new Error('Travel progress has not been confirmed on this device. Keep this page open and retry before signing out.');
    const key = accountKey(), saved = key ? await store.read(key) : null;
    if (saved) account = saved;
    if (!keepDrafts && pendingCount()) throw new Error('Some travel progress has not synced. Stay signed in or keep the drafts on this device.');
    emit();
  }
  async function retry() {
    const requestedOwner = ownerId;
    clearError(); failures = 0; clearTimeout(retryTimer); retryTimer = undefined;
    if (!initialized || guestError) await setContext(context, remote);
    if (ownerId !== requestedOwner || disposed) return;
    const token = epoch, owner = ownerId, key = accountKey();
    await reload(); if (!still(token, owner)) return;
    await refresh(); if (!still(token, owner)) return;
    if (key) {
      const saved = await store.update(key, previous => {
        const data = previous || emptyTravelWorkspace(key);
        if (!still(token, owner)) return data;
        for (const trip of Object.values(data.trips)) for (const mark of Object.values(trip.marks)) mark.error = null;
        return data;
      });
      if (!still(token, owner)) return;
      adopt(saved);
    }
    await sync();
  }
  function dispose() {
    disposed = true; epoch++; clearTimeout(retryTimer); retryTimer = undefined; clearInterval(pollTimer); pollTimer = undefined;
    initialized = false; syncing = false; refreshes = 0; inRefresh.clear();
    channel?.close(); channel = null; connected = false;
    if (typeof window !== 'undefined') { window.removeEventListener('focus', onFocus); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); document.removeEventListener('visibilitychange', onVisibility); }
    store.close?.();
  }
  return {getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setContext, setState, todayPersistence, undo, refresh, retry, sync, reload, resolveConflict, prepareSignOut, dispose};
}
