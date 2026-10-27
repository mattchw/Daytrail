import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile = (path, modules = {}) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match)).toString('base64');
const modelURL = compile('../model.ts'), backupURL = compile('../tripBackup.ts', {'./model': modelURL});
const cloudTypesURL = compile('../cloud/types.ts'), codecURL = compile('../cloud/codec.ts', {'../model': modelURL, '../tripBackup': backupURL, './types': cloudTypesURL});
const typesURL = compile('./types.ts'), travelModelURL = compile('./model.ts');
const remoteURL = compile('./remote.ts', {'../cloud/codec': codecURL, './types': typesURL});
const storageURL = compile('./storage.ts', {'../cloud/codec': codecURL, './remote': remoteURL});
const controllerURL = compile('./controller.ts', {'./model': travelModelURL, './types': typesURL, './storage': storageURL});
const {createTravelController} = await import(controllerURL);
const {createMemoryTravelStore, emptyTravelWorkspace, emptyTripProgress, newLocalTravelMark} = await import(storageURL);
const {seedTrip} = await import(modelURL), {TravelError} = await import(typesURL);
const clone = value => structuredClone(value), stamp = '2026-10-26T12:00:00.000Z';
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const key = 'account:' + owner, target = 'activity:a1';
const trip = (id = 'trip-one') => ({...seedTrip(), id});
const mark = (state = 'planned', revision = 1, placeId = 'fushimi', targetId = target) => ({targetId, placeId, state, revision, updatedAt: stamp});
const context = (value = trip(), extra = {}) => ({ownerId: owner, scope: 'account', trip: value, enabled: true, authReady: true, tripCloudReady: true, cloudReadyTripIds: value ? [value.id] : [], ...extra});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
function fakeRemote(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([id, values]) => [id, new Map(values.map(value => [value.targetId, clone(value)]))]));
  const receipts = new Map(), calls = [];
  const remote = {rows, calls, beforeMutate: null, afterMutate: null, onList: null,
    async list(id) { return remote.onList ? remote.onList(id) : clone([...(rows.get(id)?.values() || [])]); },
    async mutate(input) {
      calls.push(clone(input)); if (remote.beforeMutate) await remote.beforeMutate(input);
      const values = rows.get(input.tripId) || new Map(), current = values.get(input.targetId), receiptKey = input.tripId + ':' + input.targetId;
      if (receipts.get(receiptKey) === input.mutationId) return clone(current);
      if ((current?.revision || 0) !== input.expectedRevision) throw new TravelError('conflict', 'Changed elsewhere', current ? clone(current) : null);
      const saved = {targetId: input.targetId, placeId: input.placeId, state: input.state, revision: input.expectedRevision + 1, updatedAt: stamp};
      values.set(input.targetId, saved); rows.set(input.tripId, values); receipts.set(receiptKey, input.mutationId);
      if (remote.afterMutate) await remote.afterMutate(input); return clone(saved);
    },
  };
  return remote;
}
const active = new Set();
function controller(options = {}) { const value = createTravelController({store: createMemoryTravelStore(), autoSync: false, requestTimeoutMs: 500, ...options}); active.add(value); return value; }
async function opened(remote = fakeRemote(), options = {}, value = context()) {
  const progress = controller(options); await progress.setContext(value, remote); await progress.refresh(); return {progress, remote};
}
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}: ${(error?.stack || String(error)).replace(/data:text\/javascript;base64,[^ )]+/g, '[compiled module]')}`); }
  finally { for (const value of active) value.dispose(); active.clear(); }
}

await check('guest progress persists separately and is never uploaded at sign-in', async () => {
  const store = createMemoryTravelStore(), progress = controller({store}), remote = fakeRemote();
  await progress.setContext(context(trip(), {ownerId: null, scope: 'guest'}), null);
  await progress.setState(target, 'done'); assert.equal(progress.getSnapshot().status, 'local');
  await progress.setContext(context(), remote); await progress.refresh(); await progress.sync();
  assert.equal(progress.getSnapshot().marks[target], 'planned'); assert.equal(remote.calls.length, 0);
  await progress.setContext(context(trip(), {scope: 'guest'}), remote);
  assert.equal(progress.getSnapshot().marks[target], 'done');
  const next = controller({store}); await next.setContext(context(trip(), {ownerId: null, scope: 'guest'}), null);
  assert.equal(next.getSnapshot().marks[target], 'done');
});
await check('progress is published only after local persistence and failed storage never changes the displayed mark', async () => {
  const memory = createMemoryTravelStore(); let fail = false;
  const store = {read: id => memory.read(id), update: (...args) => fail ? Promise.reject(new Error('Device storage full')) : memory.update(...args)};
  const {progress} = await opened(undefined, {store}); fail = true;
  await assert.rejects(progress.setState(target, 'done'), /storage full/);
  assert.equal(progress.getSnapshot().marks[target], 'planned'); assert.equal(progress.getSnapshot().status, 'failed');
  await assert.rejects(progress.prepareSignOut(true), /not been confirmed/);
  fail = false; await progress.retry(); await progress.setState(target, 'done');
  assert.equal(progress.getSnapshot().marks[target], 'done');
});
await check('initial storage failure recovers on retry without changing the trip workspace', async () => {
  const memory = createMemoryTravelStore(); let fail = true;
  const store = {read: id => memory.read(id), update: (...args) => fail ? Promise.reject(new Error('Blocked storage')) : memory.update(...args)};
  const progress = controller({store}); await progress.setContext(context(), fakeRemote());
  assert.equal(progress.getSnapshot().ready, false); fail = false; await progress.retry();
  assert.equal(progress.getSnapshot().ready, true);
});
await check('first offline opening permits durable progress and waits for itinerary acknowledgement before syncing', async () => {
  let online = false; const {progress, remote} = await opened(undefined, {online: () => online});
  assert.equal(progress.getSnapshot().ready, true); await progress.setState(target, 'done');
  await progress.sync(); assert.equal(remote.calls.length, 0); assert.equal(progress.getSnapshot().status, 'offline');
  online = true; await progress.setContext(context(trip(), {tripCloudReady: false, cloudReadyTripIds: []}), remote); await progress.sync();
  assert.equal(remote.calls.length, 0);
  await progress.setContext(context(), remote); await progress.retry();
  assert.equal(remote.calls[0].expectedRevision, 0); assert.equal(progress.getSnapshot().pendingCount, 0);
});
await check('edits during an in-flight save preserve its payload and send the next desired state at the acknowledged revision', async () => {
  const {progress, remote} = await opened(); const started = deferred(), release = deferred();
  remote.beforeMutate = async () => { remote.beforeMutate = null; started.resolve(); await release.promise; };
  await progress.setState(target, 'done'); const syncing = progress.sync(); await started.promise;
  await progress.setState(target, 'skipped'); assert.equal(remote.calls[0].state, 'done');
  release.resolve(); await syncing;
  assert.deepEqual(remote.calls.map(value => [value.expectedRevision, value.state]), [[0, 'done'], [1, 'skipped']]);
  assert.equal(progress.getSnapshot().marks[target], 'skipped'); assert.equal(progress.getSnapshot().pendingCount, 0);
});
await check('reload retries the exact mutation after a lost acknowledgement', async () => {
  const store = createMemoryTravelStore(), {progress, remote} = await opened(undefined, {store});
  remote.afterMutate = () => { remote.afterMutate = null; throw new TravelError('unavailable', 'Lost acknowledgement'); };
  await progress.setState(target, 'done'); await progress.sync(); const mutationId = remote.calls[0].mutationId;
  progress.dispose(); const next = controller({store}); await next.setContext(context(), remote); await next.sync();
  assert.equal(remote.calls[1].mutationId, mutationId); assert.equal(remote.rows.get('trip-one').get(target).revision, 1);
  assert.equal(next.getSnapshot().pendingCount, 0);
});
await check('all previously opened trip drafts count toward sign-out and can sync from the dashboard', async () => {
  const {progress, remote} = await opened(); await progress.setState(target, 'done');
  await progress.setContext(context(trip('trip-two'), {cloudReadyTripIds: ['trip-one', 'trip-two']}), remote); await progress.refresh();
  await progress.setState(target, 'skipped');
  assert.equal(progress.getSnapshot().pendingCount, 2); assert.deepEqual(progress.getSnapshot().pendingTripIds, ['trip-one', 'trip-two']);
  await assert.rejects(progress.prepareSignOut(false), /not synced/); await progress.prepareSignOut(true);
  await progress.setContext(context(null, {enabled: false, cloudReadyTripIds: ['trip-one', 'trip-two']}), remote); await progress.sync();
  assert.equal(progress.getSnapshot().pendingCount, 0); assert.equal(remote.calls.length, 2); await progress.prepareSignOut(false);
});
await check('late responses from A cannot appear in B and A drafts stay in the original account', async () => {
  const store = createMemoryTravelStore(), {progress, remote} = await opened(undefined, {store});
  const started = deferred(), release = deferred(); remote.beforeMutate = async () => { started.resolve(); await release.promise; };
  await progress.setState(target, 'done'); const syncing = progress.sync(); await started.promise;
  const b = fakeRemote({'trip-one': [mark('skipped')]}); await progress.setContext(context(trip(), {ownerId: other}), b); await progress.refresh();
  release.resolve(); await syncing;
  assert.equal(progress.getSnapshot().marks[target], 'skipped');
  assert.ok((await store.read(key)).trips['trip-one'].marks[target].pending);
  assert.equal((await store.read('account:' + other)).trips['trip-one'].marks[target].state, 'skipped');
});
await check('late list response cannot replace progress in another account', async () => {
  const progress = controller(), remote = fakeRemote(), response = deferred(); remote.onList = () => response.promise;
  await progress.setContext(context(), remote); const fetching = progress.refresh();
  await progress.setContext(context(trip(), {ownerId: other}), fakeRemote()); await progress.refresh();
  response.resolve([mark('done')]); await fetching; assert.equal(progress.getSnapshot().marks[target], 'planned');
});
await check('a shared transactional lease prevents duplicate writes across tabs', async () => {
  const store = createMemoryTravelStore(), remote = fakeRemote();
  const first = (await opened(remote, {store})).progress, second = (await opened(remote, {store})).progress;
  await first.setState(target, 'done'); await second.reload(); const started = deferred(), release = deferred();
  remote.beforeMutate = async () => { started.resolve(); await release.promise; };
  const saving = first.sync(); await started.promise; await second.sync(); assert.equal(remote.calls.length, 1);
  release.resolve(); await saving; await second.reload(); assert.equal(second.getSnapshot().pendingCount, 0);
});
await check('a stale tab cannot overwrite a mark that was absent when it last rendered', async () => {
  const store = createMemoryTravelStore(), remote = fakeRemote();
  const first = (await opened(remote, {store})).progress, second = (await opened(remote, {store})).progress;
  await first.setState(target, 'done');
  await assert.rejects(second.setState(target, 'skipped'), /changed in another tab/);
  const saved = (await store.read(key)).trips['trip-one'].marks[target];
  assert.equal(saved.state, 'done'); assert.equal(saved.pending.state, 'done');
  await second.reload(); await second.setState(target, 'skipped'); await second.sync();
  assert.equal(remote.rows.get('trip-one').get(target).state, 'skipped');
});
await check('a stale tab reviews newer acknowledged revisions even when the visible state matches', async () => {
  const store = createMemoryTravelStore(), remote = fakeRemote({'trip-one': [mark('planned')]});
  const first = (await opened(remote, {store})).progress, second = (await opened(remote, {store})).progress;
  remote.rows.get('trip-one').set(target, mark('planned', 2)); await first.refresh();
  await assert.rejects(second.setState(target, 'done'), /changed in another tab/);
  assert.equal((await store.read(key)).trips['trip-one'].marks[target].state, 'planned');
  await second.reload(); await second.setState(target, 'done'); await second.sync();
  assert.equal(remote.calls[0].expectedRevision, 2);
});
await check('rapid queued changes from the same tab remain serial and preserve both acknowledged intents', async () => {
  const {progress, remote} = await opened();
  await Promise.all([progress.setState(target, 'done'), progress.setState(target, 'skipped')]);
  await progress.sync();
  assert.deepEqual(remote.calls.map(value => [value.expectedRevision, value.state]), [[0, 'done'], [1, 'skipped']]);
});
await check('unreadable guest progress does not block independent account reload, retry, or syncing', async () => {
  const memory = createMemoryTravelStore(); let broken = true;
  const store = {read: id => id === 'guest' && broken ? Promise.reject(new Error('Corrupt guest progress')) : memory.read(id),
    update: (id, change) => id === 'guest' && broken ? Promise.reject(new Error('Corrupt guest progress')) : memory.update(id, change)};
  const {progress, remote} = await opened(undefined, {store});
  assert.equal(progress.getSnapshot().ready, true); assert.equal(progress.getSnapshot().error, null);
  await progress.setState(target, 'done'); await progress.reload(); await progress.retry();
  assert.equal(progress.getSnapshot().pendingCount, 0); assert.equal(progress.getSnapshot().status, 'saved');
  assert.equal(remote.calls.length, 1);
  await progress.setContext(context(trip(), {scope: 'guest'}), remote);
  assert.equal(progress.getSnapshot().ready, false); assert.match(progress.getSnapshot().error, /Corrupt guest/);
  broken = false; await progress.retry(); assert.equal(progress.getSnapshot().ready, true);
});
await check('disposing and reopening the same controller supports effect remounts without a loading deadlock', async () => {
  const {progress, remote} = await opened(); await progress.setState(target, 'done'); progress.dispose();
  await progress.setContext(context(), remote); await progress.refresh(); await progress.sync();
  assert.equal(progress.getSnapshot().ready, true); assert.equal(progress.getSnapshot().status, 'saved');
  assert.equal(progress.getSnapshot().marks[target], 'done'); assert.equal(progress.getSnapshot().pendingCount, 0);
});
await check('a timed-out save keeps its exact mutation for retry and cannot publish a late acknowledgement', async () => {
  const {progress, remote} = await opened(undefined, {requestTimeoutMs: 15});
  const release = deferred(); remote.afterMutate = () => release.promise;
  await progress.setState(target, 'done'); await progress.sync();
  const mutationId = remote.calls[0].mutationId;
  assert.equal(progress.getSnapshot().pendingCount, 1); assert.equal(progress.getSnapshot().status, 'offline');
  release.resolve(); await Promise.resolve(); assert.equal(progress.getSnapshot().pendingCount, 1);
  remote.afterMutate = null; await progress.sync();
  assert.equal(remote.calls[1].mutationId, mutationId); assert.equal(progress.getSnapshot().pendingCount, 0);
});
await check('an expired tab lease is recoverable', async () => {
  let now = 0; const store = createMemoryTravelStore(), {progress, remote} = await opened(undefined, {store, now: () => now});
  await progress.setState(target, 'done'); await store.update(key, value => ({...value, lease: {holder: 'crashed-tab', until: 30_000}}));
  await progress.sync(); assert.equal(remote.calls.length, 0); now = 31_000; await progress.sync(); assert.equal(remote.calls.length, 1);
});
await check('place replacement ignores old completion while retaining its revision for the new place', async () => {
  const {progress, remote} = await opened(fakeRemote({'trip-one': [mark('done', 7)]}));
  const updated = trip(); updated.days[0].items[0].placeId = 'kiyomizu';
  await progress.setContext(context(updated), remote);
  assert.equal(progress.getSnapshot().marks[target], 'planned');
  await progress.setState(target, 'done'); await progress.sync();
  assert.equal(remote.calls[0].placeId, 'kiyomizu'); assert.equal(remote.calls[0].expectedRevision, 7);
  await progress.undo(); assert.equal(progress.getSnapshot().marks[target], 'planned');
});
await check('reordering and moving a visit preserves progress while duplicate trip IDs start fresh', async () => {
  const {progress, remote} = await opened(fakeRemote({'trip-one': [mark('done')]}));
  const moved = trip(); moved.days[1].items.push(moved.days[0].items.shift()); await progress.setContext(context(moved), remote);
  assert.equal(progress.getSnapshot().marks[target], 'done');
  const duplicate = clone(moved); duplicate.id = 'duplicate-trip'; await progress.setContext(context(duplicate), remote); await progress.refresh();
  assert.equal(progress.getSnapshot().marks[target], 'planned');
});
await check('endpoints support done and planned but reject skipped', async () => {
  const {progress, remote} = await opened(); await assert.rejects(progress.setState('end:d1', 'skipped'), /no longer available/);
  await progress.retry(); await progress.setState('end:d1', 'done'); await progress.sync();
  assert.equal(remote.calls[0].placeId, 'hotel'); await progress.setState('end:d1', 'planned'); await progress.sync();
  assert.equal(remote.rows.get('trip-one').get('end:d1').state, 'planned');
});
await check('concurrent same-stop progress stays conflicted until an explicit choice', async () => {
  const remote = fakeRemote({'trip-one': [mark('planned')]}), {progress} = await opened(remote);
  await progress.setState(target, 'done'); remote.rows.get('trip-one').set(target, mark('skipped', 2)); await progress.sync();
  assert.equal(progress.getSnapshot().marks[target], 'done'); assert.equal(progress.getSnapshot().conflicts[0].remote.state, 'skipped');
  assert.equal(progress.getSnapshot().status, 'conflict');
  await progress.resolveConflict(target, 'local'); await progress.sync();
  assert.equal(remote.calls[1].expectedRevision, 2); assert.equal(remote.rows.get('trip-one').get(target).state, 'done');
});
await check('choosing remote resolves a conflict without another mutation and old lists cannot roll back', async () => {
  const remote = fakeRemote({'trip-one': [mark('planned')]}), {progress} = await opened(remote);
  await progress.setState(target, 'done'); remote.rows.get('trip-one').set(target, mark('skipped', 5)); await progress.refresh();
  remote.rows.get('trip-one').set(target, mark('planned', 3)); await progress.refresh();
  assert.equal(progress.getSnapshot().conflicts[0].remote.revision, 5);
  await progress.resolveConflict(target, 'remote'); await progress.sync();
  assert.equal(progress.getSnapshot().marks[target], 'skipped'); assert.equal(remote.calls.length, 0);
});
await check('reference rejection preserves the old intent and a corrected mark can supersede a known rejected request', async () => {
  const {progress, remote} = await opened(); await progress.setState(target, 'done');
  remote.beforeMutate = () => { throw new TravelError('invalid', 'This stop changed'); };
  await progress.sync(); assert.equal(progress.getSnapshot().pendingCount, 1); assert.equal(progress.getSnapshot().conflicts.length, 1);
  const updated = trip(); updated.days[0].items[0].placeId = 'kiyomizu'; await progress.setContext(context(updated), remote);
  assert.equal(progress.getSnapshot().marks[target], 'planned');
  remote.beforeMutate = null; await progress.setState(target, 'done'); await progress.sync();
  assert.equal(remote.calls[1].placeId, 'kiyomizu'); assert.equal(progress.getSnapshot().pendingCount, 0);
});
await check('a rejected new mark may be explicitly discarded without a remote row or another mutation', async () => {
  const {progress, remote} = await opened(); await progress.setState(target, 'done');
  remote.beforeMutate = () => { throw new TravelError('invalid', 'This stop changed'); };
  await progress.sync(); assert.equal(progress.getSnapshot().conflicts[0].rejected, true);
  assert.equal(progress.getSnapshot().conflicts[0].remote, null);
  await progress.resolveConflict(target, 'remote'); await progress.sync();
  assert.equal(progress.getSnapshot().marks[target], 'planned'); assert.equal(progress.getSnapshot().pendingCount, 0);
  assert.equal(remote.calls.length, 1);
});
await check('rejecting an in-flight old reference permits the newer durable reference to sync next', async () => {
  const {progress, remote} = await opened(); const started = deferred(), release = deferred();
  remote.beforeMutate = async () => { remote.beforeMutate = null; started.resolve(); await release.promise; throw new TravelError('invalid', 'This stop changed'); };
  await progress.setState(target, 'done'); const saving = progress.sync(); await started.promise;
  const updated = trip(); updated.days[0].items[0].placeId = 'kiyomizu'; await progress.setContext(context(updated), remote);
  await progress.setState(target, 'done'); release.resolve(); await saving;
  assert.deepEqual(remote.calls.map(value => [value.placeId, value.expectedRevision]), [['fushimi', 0], ['kiyomizu', 0]]);
  assert.equal(progress.getSnapshot().pendingCount, 0); assert.equal(progress.getSnapshot().marks[target], 'done');
});
await check('Undo supports multiple local steps without reverting unrelated stop progress', async () => {
  const {progress, remote} = await opened(); await progress.setState(target, 'done'); await progress.setState(target, 'skipped');
  await progress.undo(); assert.equal(progress.getSnapshot().marks[target], 'done'); assert.equal(progress.getSnapshot().canUndo, true);
  remote.rows.set('trip-one', new Map([['activity:a2', mark('done', 1, 'kiyomizu', 'activity:a2')]])); await progress.refresh();
  await progress.undo(); assert.equal(progress.getSnapshot().marks[target], 'planned'); assert.equal(progress.getSnapshot().marks['activity:a2'], 'done');
});
await check('external revision invalidates Undo only for the changed target', async () => {
  const {progress, remote} = await opened(); await progress.setState(target, 'done'); await progress.sync();
  assert.equal(progress.getSnapshot().canUndo, true); remote.rows.get('trip-one').set(target, mark('skipped', 2)); await progress.refresh();
  assert.equal(progress.getSnapshot().canUndo, false); await progress.undo(); assert.equal(progress.getSnapshot().marks[target], 'skipped');
});
await check('Undo cannot revert a newer same-state acknowledgement received by another tab', async () => {
  const store = createMemoryTravelStore(), remote = fakeRemote();
  const first = (await opened(remote, {store})).progress, second = (await opened(remote, {store})).progress;
  await first.setState(target, 'done'); await first.sync();
  remote.rows.get('trip-one').set(target, mark('done', 2)); await second.refresh();
  await assert.rejects(first.undo(), /changed in another tab/);
  assert.equal((await store.read(key)).trips['trip-one'].marks[target].state, 'done');
  await first.reload(); assert.equal(first.getSnapshot().canUndo, false);
});
await check('schema/auth failures preserve drafts and remain visible until explicit retry', async () => {
  for (const code of ['setup', 'auth']) {
    const {progress, remote} = await opened(); await progress.setState(target, 'done');
    remote.beforeMutate = () => { throw new TravelError(code, 'Action required'); }; await progress.sync();
    assert.equal(progress.getSnapshot().status, code); remote.beforeMutate = null; await progress.sync(); assert.equal(remote.calls.length, 1);
    await progress.retry(); assert.equal(progress.getSnapshot().pendingCount, 0);
  }
});
await check('sign-out hides account progress, removes clean cache, and preserves only durable pending work', async () => {
  const store = createMemoryTravelStore(), {progress, remote} = await opened(undefined, {store});
  await progress.setState(target, 'done'); await progress.sync(); await progress.setState('activity:a2', 'skipped');
  await progress.prepareSignOut(true); await progress.setContext(context(trip(), {ownerId: null, scope: 'guest'}), null);
  assert.equal(progress.getSnapshot().marks[target], 'planned');
  const saved = await store.read(key); assert.equal(saved.trips['trip-one'].marks[target], undefined);
  assert.equal(saved.trips['trip-one'].marks['activity:a2'].state, 'skipped');
  await progress.setContext(context(), remote); await progress.refresh(); await progress.sync(); await progress.prepareSignOut(false);
});
await check('no notes or provider content is stored with progress and malformed mutation IDs fail closed', async () => {
  const store = createMemoryTravelStore(), {progress} = await opened(undefined, {store}); await progress.setState(target, 'done');
  const text = JSON.stringify(await store.read(key));
  assert.equal(text.includes('Start early'), false); assert.equal(text.includes('Fushimi Inari'), false); assert.equal(text.includes('googlePlaceId'), false);
  await assert.rejects(store.update('bad', () => {
    const data = emptyTravelWorkspace('bad'), record = emptyTripProgress();
    record.marks[target] = {...newLocalTravelMark('fushimi', 'done'), pending: {tripId: 'trip-one', targetId: target, placeId: 'fushimi', state: 'done', expectedRevision: 0, mutationId: 'bad'}};
    data.trips['trip-one'] = record; return data;
  }), /could not be opened/);
  assert.equal(await store.read('bad'), null);
});
const flightTrip = () => {
  const value=trip(); value.startDate='2027-05-14';
  value.flights=[{id:'flight-one',fromPlaceId:'nijo',toPlaceId:'gion',departure:{date:'2027-05-14',time:'23:00',timezone:'Europe/London'},arrival:{date:'2027-05-15',time:'20:00',timezone:'Asia/Tokyo'},bookingReference:'PRIVATE-FLIGHT'}];
  value.days[0]={...value.days[0],startPlaceId:'nijo',items:[{aid:'landing',placeId:'gion',duration:0,fixed:null,mode:'flight',flightId:'flight-one',note:''}]};
  return value;
};
await check('landing uses one stable cloud progress identity across departure and arrival days',async()=>{
  const value=flightTrip(), store=createMemoryTravelStore(), remote=fakeRemote(), {progress}=await opened(remote,{store},context(value));
  assert.equal(progress.getSnapshot().marks['flight:flight-one'],'planned');
  await progress.setState('flight:flight-one','done'); await progress.sync();
  assert.equal(remote.calls[0].targetId,'flight:flight-one'); assert.equal(remote.calls[0].placeId,'gion');
  assert.equal(remote.calls.length,1); assert.equal(progress.getSnapshot().marks['activity:landing'],undefined);
  assert.equal(JSON.parse(progress.getSnapshot().referenceKey).filter(([id])=>id==='flight:flight-one').length,1);
  const reopened=controller({store}); await reopened.setContext(context(value),remote); await reopened.refresh();
  assert.equal(reopened.getSnapshot().marks['flight:flight-one'],'done');
  const durable=JSON.stringify(await store.read(key)); assert.equal(durable.includes('PRIVATE-FLIGHT'),false);
});
await check('changing flight arrival airport ignores prior landing while retaining its revision',async()=>{
  const value=flightTrip(), remote=fakeRemote({'trip-one':[mark('done',4,'gion','flight:flight-one')]}), {progress}=await opened(remote,{},context(value));
  assert.equal(progress.getSnapshot().marks['flight:flight-one'],'done');
  value.flights[0].toPlaceId='fushimi'; value.days[0].items[0].placeId='fushimi';
  await progress.setContext(context(value),remote); assert.equal(progress.getSnapshot().marks['flight:flight-one'],'planned');
  await progress.setState('flight:flight-one','done'); await progress.sync();
  assert.equal(remote.calls[0].expectedRevision,4); assert.equal(remote.calls[0].placeId,'fushimi');
});
await check('flight skip and Undo preserve itinerary and booking details',async()=>{
  const value=flightTrip(), before=clone(value), {progress}=await opened(undefined,{},context(value));
  await progress.setState('flight:flight-one','skipped'); assert.equal(progress.getSnapshot().marks['flight:flight-one'],'skipped');
  await progress.undo(); assert.equal(progress.getSnapshot().marks['flight:flight-one'],'planned'); assert.deepEqual(value,before);
});
const timing=(value=trip(),phase='visit')=>JSON.stringify({ownerId:owner,scope:'account',runtime:{schema:1,tripId:value.id,dayId:value.days[0].id,date:'2026-10-27',timezone:'UTC',phase,targetId:target,placeId:'fushimi',since:1,leaveAt:2,updatedAt:1}});
await check('Today timing and completion mark commit atomically in the travel outbox',async()=>{
  const store=createMemoryTravelStore(),{progress}=await opened(undefined,{store});const value=trip(),raw=timing(value);
  await progress.todayPersistence.commit({dayId:value.days[0].id,previous:null,next:raw,mark:{targetId:target,previous:'planned',expected:'done'}});
  const saved=await store.read(key);assert.equal(saved.trips[value.id].today[value.days[0].id],raw);assert.equal(saved.trips[value.id].marks[target].state,'done');assert.equal(await progress.todayPersistence.read(value.days[0].id),raw);
});
await check('Today quota failure preserves both the earlier mark and timestamp',async()=>{
  const memory=createMemoryTravelStore();let fail=false;const store={read:memory.read,update:(...args)=>fail?Promise.reject(new Error('Storage quota exceeded')):memory.update(...args)};
  const {progress}=await opened(undefined,{store});fail=true;const value=trip();await assert.rejects(progress.todayPersistence.commit({dayId:value.days[0].id,previous:null,next:timing(value),mark:{targetId:target,previous:'planned',expected:'done'}}),/quota/);
  assert.equal(progress.getSnapshot().marks[target],'planned');assert.equal((await memory.read(key)).trips[value.id].today,undefined);
});
await check('Today rejects concurrent timestamp edits before changing progress',async()=>{
  const store=createMemoryTravelStore(),{progress}=await opened(undefined,{store});const value=trip(),raw=timing(value);await progress.todayPersistence.commit({dayId:value.days[0].id,previous:null,next:raw});
  await assert.rejects(progress.todayPersistence.commit({dayId:value.days[0].id,previous:null,next:raw,mark:{targetId:target,previous:'planned',expected:'done'}}),/another tab/);assert.equal(progress.getSnapshot().marks[target],'planned');
});
await check('offline prepared account can open and edit progress without a remote',async()=>{
  const store=createMemoryTravelStore(),progress=controller({store,online:()=>false});await progress.setContext(context(trip(),{authOffline:true}),null);await progress.setState(target,'done');assert.equal(progress.getSnapshot().marks[target],'done');assert.equal(progress.getSnapshot().error,null);assert.equal(progress.getSnapshot().status,'offline');
});
await check('account switching never exposes another account Today timing',async()=>{
  const store=createMemoryTravelStore(),{progress}=await opened(undefined,{store});const value=trip();await progress.todayPersistence.commit({dayId:value.days[0].id,previous:null,next:timing(value)});
  await progress.setContext(context(value,{ownerId:other}),fakeRemote());await progress.refresh();assert.equal(await progress.todayPersistence.read(value.days[0].id),null);
});
console.log(`\n${passed} travel persistence checks passed; ${failed} failed.`);
if (failed) process.exitCode = 1;
