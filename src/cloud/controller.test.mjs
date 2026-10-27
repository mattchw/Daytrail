import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// The same dependency URL is reused so Error classes have one module identity.
const compile = (path, modules = {}) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match)).toString('base64');
const modelUrl = compile('../model.ts');
const backupUrl = compile('../tripBackup.ts', {'./model': modelUrl});
const typesUrl = compile('./types.ts');
const codecUrl = compile('./codec.ts', {'../model': modelUrl, '../tripBackup': backupUrl, './types': typesUrl});
const storageUrl = compile('./storage.ts', {'./codec': codecUrl});
const controllerUrl = compile('./controller.ts', {'./codec': codecUrl, './types': typesUrl, './storage': storageUrl});
const {createWorkspaceController} = await import(controllerUrl);
const {createMemoryWorkspaceStore, emptyWorkspace} = await import(storageUrl);
const {seedTrip} = await import(modelUrl);
const {CloudError} = await import(typesUrl);
const clone = value => structuredClone(value);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const accountKey = 'account:' + owner;
const stamp = '2026-10-26T12:00:00.000Z';
const trip = (id = 'trip-one', name = 'Kyoto') => ({...seedTrip(), id, name});
const saved = (value = trip(), revision = 1, deletedAt = null) => ({trip: clone(value), revision, updatedAt: stamp, deletedAt});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

function fakeRemote(initial = []) {
  const rows = new Map(initial.map(row => [row.trip.id, clone(row)]));
  const receipts = new Map(), calls = [];
  const api = {
    rows, calls, beforeMutate: null, afterMutate: null, onList: null,
    async list() { return api.onList ? api.onList() : clone([...rows.values()]); },
    async mutate(input) {
      calls.push(clone(input));
      if (api.beforeMutate) await api.beforeMutate(input);
      const current = rows.get(input.tripId), receipt = receipts.get(input.tripId);
      if (receipt?.mutationId === input.mutationId) return clone(current);
      if ((!current && input.expectedRevision !== 0) || (current && current.revision !== input.expectedRevision)) {
        throw new CloudError('conflict', 'A newer saved version exists.', current && clone(current));
      }
      const next = {trip: clone(input.trip || current.trip), revision: input.expectedRevision + 1, updatedAt: stamp,
        deletedAt: input.operation === 'delete' ? stamp : null};
      rows.set(input.tripId, next); receipts.set(input.tripId, clone(input));
      if (api.afterMutate) await api.afterMutate(input);
      return clone(next);
    },
  };
  return api;
}
const active = new Set();
function controller(options = {}) {
  const value = createWorkspaceController({store: createMemoryWorkspaceStore(), initialGuestTrips: [trip('guest-trip', 'Device holiday')], autoSync: false, requestTimeoutMs: 500, ...options});
  active.add(value); return value;
}
async function opened(remote = fakeRemote([saved()]), options = {}) {
  const workspace = controller(options);
  await workspace.setIdentity(owner, remote); await workspace.refresh();
  return {workspace, remote};
}
const rename = (workspace, name, id = 'trip-one') => workspace.changeTrips(trips => trips.map(value => value.id === id ? {...value, name} : value));
let passed = 0, failed = 0;
async function check(name, action) {
  try { await action(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}: ${(error?.stack || String(error)).replace(/data:text\/javascript;base64,[^ )]+/g, '[compiled module]')}`); }
  finally { for (const value of active) value.dispose(); active.clear(); }
}

await check('device library is durable, account starts separately, and no guest trip uploads automatically', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote(), workspace = controller({store});
  await workspace.setIdentity(null, null);
  assert.equal(workspace.getSnapshot().trips[0].id, 'guest-trip');
  await workspace.setIdentity(owner, remote);
  assert.equal(workspace.getSnapshot().status, 'syncing');
  assert.equal(workspace.getSnapshot().ready, false);
  await workspace.refresh(); await workspace.sync();
  assert.deepEqual(workspace.getSnapshot().trips, []);
  assert.equal(workspace.getSnapshot().status, 'saved');
  assert.equal(remote.calls.length, 0);
  await workspace.setScope('guest');
  assert.equal(workspace.getSnapshot().trips.length, 1);
  const next = controller({store, initialGuestTrips: []});
  await next.setIdentity(null, null);
  assert.equal(next.getSnapshot().trips[0].name, 'Device holiday');
});

await check('invalid legacy data is not overwritten or seeded and does not block the account library', async () => {
  const store = createMemoryWorkspaceStore(), workspace = controller({store, initialGuestError: 'Recover the original JSON first.'});
  await workspace.setIdentity(null, null);
  assert.equal(workspace.getSnapshot().ready, false);
  assert.match(workspace.getSnapshot().error, /Recover/);
  assert.equal(await store.read('guest'), null);
  await assert.rejects(workspace.changeTrips(() => [trip()]), /Recover/);
  await workspace.setIdentity(owner, fakeRemote([saved()])); await workspace.refresh();
  assert.equal(workspace.getSnapshot().ready, true);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Kyoto');
  assert.equal(await store.read('guest'), null);
});

await check('first offline account visit accepts durable drafts and reconnects with create revision zero', async () => {
  let online = false;
  const remote = fakeRemote(), workspace = controller({online: () => online});
  await workspace.setIdentity(owner, remote);
  assert.equal(workspace.getSnapshot().ready, true);
  assert.equal(workspace.getSnapshot().status, 'offline');
  await workspace.changeTrips(() => [trip()]);
  assert.equal(workspace.getSnapshot().pendingCount, 1);
  await workspace.sync(); assert.equal(remote.calls.length, 0);
  online = true; await workspace.retry();
  assert.equal(remote.calls[0].expectedRevision, 0);
  assert.equal(workspace.getSnapshot().status, 'saved');
});

await check('a failed local transaction never publishes edits and retry recovers initial storage failure', async () => {
  const memory = createMemoryWorkspaceStore(); let fail = true;
  const store = {read: key => memory.read(key), update: (...args) => fail ? Promise.reject(new Error('Quota failed')) : memory.update(...args)};
  const workspace = controller({store});
  await workspace.setIdentity(null, null);
  assert.equal(workspace.getSnapshot().ready, false);
  fail = false; await workspace.retry();
  assert.equal(workspace.getSnapshot().ready, true);
  fail = true;
  await assert.rejects(rename(workspace, 'Unsaved', 'guest-trip'), /Quota/);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Device holiday');
  assert.equal(workspace.getSnapshot().status, 'failed');
  await assert.rejects(workspace.prepareSignOut(true), /Device saving failed/);
});

await check('queued functional changes read the latest committed local state', async () => {
  const {workspace} = await opened();
  await Promise.all([
    workspace.changeTrips(values => values.map(value => ({...value, name: 'Latest name'}))),
    workspace.changeTrips(values => values.map(value => ({...value, destination: 'Osaka, Japan'}))),
  ]);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Latest name');
  assert.equal(workspace.getSnapshot().trips[0].destination, 'Osaka, Japan');
});

await check('edits during an in-flight request retain an immutable payload and send the next revision', async () => {
  const {workspace, remote} = await opened();
  const started = deferred(), release = deferred();
  remote.beforeMutate = async () => { remote.beforeMutate = null; started.resolve(); await release.promise; };
  await rename(workspace, 'First edit'); const syncing = workspace.sync(); await started.promise;
  await rename(workspace, 'Second edit');
  assert.equal(remote.calls[0].trip.name, 'First edit');
  assert.equal(workspace.getSnapshot().trips[0].name, 'Second edit');
  release.resolve(); await syncing;
  assert.deepEqual(remote.calls.map(call => [call.expectedRevision, call.trip.name]), [[1, 'First edit'], [2, 'Second edit']]);
  assert.equal(workspace.getSnapshot().pendingCount, 0);
  assert.equal(remote.rows.get('trip-one').trip.name, 'Second edit');
});

await check('reload retries the same durable mutation ID after a lost acknowledgement', async () => {
  const store = createMemoryWorkspaceStore(); const {workspace, remote} = await opened(undefined, {store});
  remote.afterMutate = async () => { remote.afterMutate = null; throw new CloudError('unavailable', 'Connection lost'); };
  await rename(workspace, 'Persisted on the server'); await workspace.sync();
  assert.equal(workspace.getSnapshot().status, 'offline');
  const firstId = remote.calls[0].mutationId;
  workspace.dispose();
  const next = controller({store}); await next.setIdentity(owner, remote); await next.sync();
  assert.equal(remote.calls[1].mutationId, firstId);
  assert.equal(next.getSnapshot().pendingCount, 0);
  assert.equal(remote.rows.get('trip-one').revision, 2);
});

await check('late account A acknowledgement cannot appear in B and A pending changes remain scoped', async () => {
  const store = createMemoryWorkspaceStore(), {workspace, remote} = await opened(undefined, {store});
  const started = deferred(), release = deferred();
  remote.beforeMutate = async () => { started.resolve(); await release.promise; };
  await rename(workspace, 'Private A edit'); const syncing = workspace.sync(); await started.promise;
  await workspace.setIdentity(other, fakeRemote([saved(trip('b-trip', 'B holiday'))])); await workspace.refresh();
  release.resolve(); await syncing;
  assert.deepEqual(workspace.getSnapshot().trips.map(value => value.name), ['B holiday']);
  const old = await store.read(accountKey);
  assert.equal(old.records['trip-one'].trip.name, 'Private A edit');
  assert.ok(old.records['trip-one'].pending);
  assert.equal((await store.read('account:' + other)).records['trip-one'], undefined);
});

await check('late account A list cannot enter B after identity switches', async () => {
  const remote = fakeRemote(), workspace = controller(), response = deferred();
  remote.onList = () => response.promise;
  await workspace.setIdentity(owner, remote); const refreshing = workspace.refresh();
  await workspace.setIdentity(other, fakeRemote([saved(trip('b-trip', 'B holiday'))])); await workspace.refresh();
  response.resolve([saved(trip('a-private', 'Private A'))]); await refreshing;
  assert.deepEqual(workspace.getSnapshot().trips.map(value => value.id), ['b-trip']);
});

await check('two tabs share an atomic lease and only one issues the pending mutation', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote([saved()]);
  const first = (await opened(remote, {store})).workspace;
  const second = (await opened(remote, {store})).workspace;
  await rename(first, 'One server write'); await second.reload();
  const started = deferred(), release = deferred();
  remote.beforeMutate = async () => { started.resolve(); await release.promise; };
  const one = first.sync(); await started.promise; await second.sync();
  assert.equal(remote.calls.length, 1);
  release.resolve(); await one; await second.reload();
  assert.equal(second.getSnapshot().pendingCount, 0);
  assert.equal(second.getSnapshot().trips[0].name, 'One server write');
});

await check('an abandoned lease is recoverable after its bounded expiration', async () => {
  let now = 10_000; const store = createMemoryWorkspaceStore();
  const {workspace, remote} = await opened(undefined, {store, now: () => now});
  await rename(workspace, 'Recovered draft');
  await store.update(accountKey, state => ({...state, lease: {holder: 'crashed-tab', until: now + 30_000}}));
  await workspace.sync(); assert.equal(remote.calls.length, 0);
  now += 31_000; await workspace.sync();
  assert.equal(remote.calls.length, 1);
  assert.equal(workspace.getSnapshot().pendingCount, 0);
});

await check('clean remote updates refresh, stale lists cannot roll back, and dirty conflicts keep both versions', async () => {
  const {workspace, remote} = await opened();
  remote.rows.set('trip-one', saved(trip('trip-one', 'Remote two'), 2)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().trips[0].name, 'Remote two');
  remote.rows.set('trip-one', saved(trip('trip-one', 'Stale'), 1)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().trips[0].name, 'Remote two');
  await rename(workspace, 'My offline edit');
  remote.rows.set('trip-one', saved(trip('trip-one', 'Other device'), 3)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().trips[0].name, 'My offline edit');
  assert.equal(workspace.getSnapshot().conflicts[0].remote.trip.name, 'Other device');
  await workspace.sync(); assert.equal(remote.calls.length, 0);
  await workspace.resolveConflict('trip-one', 'copy'); await workspace.sync();
  assert.equal(workspace.getSnapshot().conflicts.length, 0);
  assert.deepEqual(workspace.getSnapshot().trips.map(value => value.name).sort(), ['My offline edit (my changes)', 'Other device']);
});

await check('use saved version resolves a conflict without issuing an overwrite', async () => {
  const {workspace, remote} = await opened();
  await rename(workspace, 'My draft'); remote.rows.set('trip-one', saved(trip('trip-one', 'Saved elsewhere'), 2));
  await workspace.sync(); assert.equal(workspace.getSnapshot().conflicts.length, 1);
  await workspace.resolveConflict('trip-one', 'remote'); await workspace.sync();
  assert.equal(workspace.getSnapshot().trips[0].name, 'Saved elsewhere');
  assert.equal(remote.calls.length, 1);
});

await check('missing conflict details cannot silently discard a local draft', async () => {
  const {workspace, remote} = await opened();
  remote.beforeMutate = () => { throw new CloudError('conflict', 'New version unavailable'); };
  await rename(workspace, 'Keep this'); await workspace.sync();
  await assert.rejects(workspace.resolveConflict('trip-one', 'remote'), /unavailable/);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Keep this');
});

await check('editing guard defers clean refresh and rejects edits over another tab’s newer local draft', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote([saved()]);
  const {workspace} = await opened(remote, {store});
  await workspace.setEditing(true);
  remote.rows.set('trip-one', saved(trip('trip-one', 'New remote title'), 2)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().trips[0].name, 'Kyoto');
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  await workspace.setEditing(false);
  assert.equal(workspace.getSnapshot().trips[0].name, 'New remote title');
  const second = (await opened(remote, {store})).workspace;
  await workspace.setEditing(true); await rename(second, 'Second tab');
  await assert.rejects(rename(workspace, 'First stale editor'), /another tab/);
  assert.equal((await store.read(accountKey)).records['trip-one'].trip.name, 'Second tab');
});

await check('unchanged focus reloads and polls do not announce external edits while an editor is open', async () => {
  const store = createMemoryWorkspaceStore(), {workspace} = await opened(undefined, {store});
  await workspace.setEditing(true);
  await workspace.reload(); await workspace.refresh(); await workspace.reload();
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
  await store.update(accountKey, state => ({...state, lease: {holder: 'another-tab', until: 9999999999999}}));
  await workspace.reload();
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Kyoto');
});

await check('a poll acknowledges a lost own-save receipt without deferring or replacing the edited draft', async () => {
  const {workspace, remote} = await opened();
  await rename(workspace, 'My saved booking');
  remote.afterMutate = async () => {remote.afterMutate = null; throw new CloudError('unavailable', 'Acknowledgement lost');};
  await workspace.sync(); assert.equal(workspace.getSnapshot().pendingCount, 1);
  await workspace.setEditing(true); await workspace.refresh();
  assert.equal(workspace.getSnapshot().pendingCount, 0);
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
  assert.equal(workspace.getSnapshot().status, 'saved');
  assert.equal(workspace.getSnapshot().trips[0].name, 'My saved booking');
  assert.equal(workspace.getSnapshot().canUndo, true);
  assert.equal(remote.calls.length, 1);
});

await check('another tab’s acknowledgement updates queue metadata without an external-change banner', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote([saved()]);
  const first = (await opened(remote, {store})).workspace;
  await rename(first, 'Shared durable draft');
  const second = controller({store}); await second.setIdentity(owner, remote);
  await second.setEditing(true); await first.sync(); await second.reload();
  assert.equal(second.getSnapshot().pendingCount, 0);
  assert.equal(second.getSnapshot().remoteUpdatesPending, false);
  assert.equal(second.getSnapshot().trips[0].name, 'Shared durable draft');
});

await check('actual remote editor changes persist monotonically and cannot be overwritten by a stale form', async () => {
  const store = createMemoryWorkspaceStore(), {workspace, remote} = await opened(undefined, {store});
  await workspace.setEditing(true);
  remote.rows.set('trip-one', saved(trip('trip-one', 'Newest remote plan'), 4)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().trips[0].name, 'Kyoto');
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  assert.equal((await store.read(accountKey)).records['trip-one'].base.revision, 4);
  remote.rows.set('trip-one', saved(trip('trip-one', 'Older remote response'), 2)); await workspace.refresh();
  assert.equal((await store.read(accountKey)).records['trip-one'].base.revision, 4);
  await assert.rejects(rename(workspace, 'Stale editor overwrite'), /another tab/);
  await workspace.setEditing(false);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Newest remote plan');
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
});

await check('remote tombstones defer visible removal until the active editor closes', async () => {
  const {workspace, remote} = await opened(); await workspace.setEditing(true);
  remote.rows.set('trip-one', saved(trip(), 2, stamp)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().trips.length, 1);
  assert.equal(workspace.getSnapshot().trash.length, 0);
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  await workspace.setEditing(false);
  assert.equal(workspace.getSnapshot().trips.length, 0);
  assert.equal(workspace.getSnapshot().trash.length, 1);
});

await check('new conflict alternatives defer, while equivalent conflict revision metadata can advance', async () => {
  const {workspace, remote} = await opened(); await rename(workspace, 'My local draft'); await workspace.setEditing(true);
  remote.rows.set('trip-one', saved(trip('trip-one', 'Other device plan'), 2)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().conflicts.length, 0);
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  await workspace.setEditing(false); await workspace.setEditing(true);
  remote.rows.set('trip-one', saved(trip('trip-one', 'Other device plan'), 3)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().conflicts[0].remote.revision, 3);
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
  assert.equal(workspace.getSnapshot().trips[0].name, 'My local draft');
});

await check('own in-flight acknowledgement cannot publish another tab’s changed editor contents', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote([saved()]);
  const first = (await opened(remote, {store})).workspace;
  await rename(first, 'First draft');
  const second = controller({store}); await second.setIdentity(owner, remote);
  const started = deferred(), release = deferred();
  remote.beforeMutate = async () => {remote.beforeMutate = null; started.resolve(); await release.promise;};
  await first.setEditing(true); const syncing = first.sync(); await started.promise;
  await rename(second, 'New peer draft'); release.resolve(); await syncing;
  assert.equal(first.getSnapshot().trips[0].name, 'First draft');
  assert.equal(first.getSnapshot().remoteUpdatesPending, true);
  assert.equal(first.getSnapshot().pendingCount, 0, 'durable acknowledgement metadata advances while visible contents stay deferred');
  assert.equal(remote.rows.get('trip-one').trip.name, 'New peer draft');
  await first.setEditing(false);
  assert.equal(first.getSnapshot().trips[0].name, 'New peer draft');
  assert.equal(first.getSnapshot().pendingCount, 0);
});

await check('an unchanged account acknowledgement cannot clear a deferred device-library edit', async () => {
  const store = createMemoryWorkspaceStore(), {workspace} = await opened(undefined, {store});
  await workspace.setScope('guest'); await workspace.setEditing(true);
  const peer = controller({store}); await peer.setIdentity(null, null);
  await rename(peer, 'Changed device plan', 'guest-trip'); await workspace.reload();
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  await workspace.refresh();
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Device holiday');
  await workspace.setEditing(false);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Changed device plan');
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
});

await check('acknowledging a migration cannot remove the device original from an open editor', async () => {
  const {workspace} = await opened(fakeRemote());
  await workspace.migrateGuest(['guest-trip']); await workspace.setScope('guest'); await workspace.setEditing(true);
  await workspace.sync();
  assert.equal(workspace.getSnapshot().pendingCount, 0);
  assert.equal(workspace.getSnapshot().trips[0].id, 'guest-trip');
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, true);
  await workspace.setEditing(false);
  assert.deepEqual(workspace.getSnapshot().trips, []);
  assert.equal(workspace.getSnapshot().remoteUpdatesPending, false);
});

await check('Undo preserves sequential local steps and changes only the affected trip', async () => {
  const remote = fakeRemote([saved(), saved(trip('other-trip', 'Original other'))]);
  const {workspace} = await opened(remote);
  await rename(workspace, 'First'); await rename(workspace, 'Second');
  await workspace.undo(); assert.equal(workspace.getSnapshot().trips[0].name, 'First');
  assert.equal(workspace.getSnapshot().canUndo, true);
  remote.rows.set('other-trip', saved(trip('other-trip', 'Fresh remote other'), 2)); await workspace.refresh();
  await workspace.undo();
  assert.equal(workspace.getSnapshot().trips[0].name, 'Kyoto');
  assert.equal(workspace.getSnapshot().trips.find(value => value.id === 'other-trip').name, 'Fresh remote other');
});

await check('a later external revision invalidates that trip’s previous Undo', async () => {
  const {workspace, remote} = await opened();
  await rename(workspace, 'My first change'); await workspace.sync();
  assert.equal(workspace.getSnapshot().canUndo, true);
  remote.rows.set('trip-one', saved(trip('trip-one', 'Remote revision three'), 3)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().canUndo, false);
  await workspace.undo(); assert.equal(workspace.getSnapshot().trips[0].name, 'Remote revision three');
});

await check('soft delete followed by Undo restores with the latest revision and no document on restore', async () => {
  const {workspace, remote} = await opened();
  await workspace.changeTrips(() => []); await workspace.sync();
  assert.equal(workspace.getSnapshot().trash.length, 1);
  assert.equal(remote.calls[0].operation, 'delete'); assert.equal(remote.calls[0].trip, undefined);
  await workspace.undo(); await workspace.sync();
  assert.equal(remote.calls[1].operation, 'restore'); assert.equal(remote.calls[1].expectedRevision, 2);
  assert.equal(remote.calls[1].trip, undefined);
  assert.equal(workspace.getSnapshot().trips.length, 1);
  assert.equal(workspace.getSnapshot().pendingCount, 0);
});

await check('remote deletion conflicting with offline edits does not resurrect the original trip', async () => {
  const {workspace, remote} = await opened(); await rename(workspace, 'Offline changes');
  remote.rows.set('trip-one', saved(trip(), 2, stamp)); await workspace.refresh(); await workspace.sync();
  assert.equal(workspace.getSnapshot().conflicts.length, 1);
  assert.equal(remote.calls.length, 0);
  await workspace.resolveConflict('trip-one', 'copy'); await workspace.sync();
  assert.equal(remote.rows.get('trip-one').deletedAt, stamp);
  assert.equal(workspace.getSnapshot().trips[0].name, 'Offline changes (my changes)');
});

await check('device deletion appears in device Trash and can be restored while signed out', async () => {
  const workspace = controller(); await workspace.setIdentity(null, null);
  await workspace.changeTrips(() => []); assert.equal(workspace.getSnapshot().trash.length, 1);
  await workspace.restore('guest-trip');
  assert.equal(workspace.getSnapshot().trips.length, 1);
  assert.equal(workspace.getSnapshot().trash.length, 0);
});

await check('selected device migration is idempotent and archives originals only after acknowledgement', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote(), {workspace} = await opened(remote, {store});
  const initial = await workspace.migrateGuest(['guest-trip']);
  assert.equal(initial.addedCount, 1); assert.equal(workspace.getSnapshot().guestTrips.length, 1);
  const duplicate = await workspace.migrateGuest(['guest-trip']);
  assert.equal(duplicate.skippedCount, 1); assert.equal(workspace.getSnapshot().trips.length, 1);
  await workspace.sync();
  assert.equal(workspace.getSnapshot().guestTrips.length, 0);
  const guest = await store.read('guest');
  assert.equal(guest.records['guest-trip'].archived, true);
  assert.equal(guest.records['guest-trip'].trip.name, 'Device holiday');
  assert.equal(workspace.getSnapshot().trips[0].name, 'Device holiday');
});

await check('a device original edited before migration acknowledgement is retained visibly', async () => {
  const {workspace} = await opened(fakeRemote());
  await workspace.migrateGuest(['guest-trip']); await workspace.setScope('guest');
  await rename(workspace, 'New device notes', 'guest-trip'); await workspace.sync();
  assert.equal(workspace.getSnapshot().guestTrips[0].name, 'New device notes');
});

await check('sign-out checks durable pending drafts and never converts account data to guest data', async () => {
  const store = createMemoryWorkspaceStore(), {workspace, remote} = await opened(undefined, {store});
  await rename(workspace, 'Pending private draft');
  await assert.rejects(workspace.prepareSignOut(false), /have not synced/);
  await workspace.prepareSignOut(true); await workspace.setIdentity(null, null);
  assert.deepEqual(workspace.getSnapshot().trips.map(value => value.id), ['guest-trip']);
  assert.equal((await store.read(accountKey)).records['trip-one'].trip.name, 'Pending private draft');
  await workspace.setIdentity(owner, remote); await workspace.sync(); await workspace.prepareSignOut(false); await workspace.setIdentity(null, null);
  assert.deepEqual((await store.read(accountKey)).records, {});
});

await check('setup and auth failures stay visible, preserve drafts, and require explicit retry', async () => {
  for (const code of ['setup', 'auth']) {
    const {workspace, remote} = await opened(); await rename(workspace, 'Keep pending');
    remote.beforeMutate = () => { throw new CloudError(code, 'Action required'); };
    await workspace.sync(); assert.equal(workspace.getSnapshot().status, code);
    assert.equal(workspace.getSnapshot().pendingCount, 1);
    remote.beforeMutate = null; await workspace.sync(); assert.equal(remote.calls.length, 1);
    await workspace.retry(); assert.equal(workspace.getSnapshot().pendingCount, 0);
  }
});

await check('quota counts Trash and a rejected transaction leaves the existing library intact', async () => {
  const store = createMemoryWorkspaceStore();
  const workspace = controller({store, initialGuestTrips: Array.from({length: 100}, (_, index) => trip('trip-' + index))});
  await workspace.setIdentity(null, null); await workspace.changeTrips(values => values.slice(1));
  await assert.rejects(workspace.changeTrips(values => [...values, trip('new-trip')]), /including Trash/);
  assert.equal(workspace.getSnapshot().trips.length, 99);
  assert.equal(Object.keys((await store.read('guest')).records).length, 100);
});

await check('provider details never enter durable local drafts or mutation payloads', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote(), {workspace} = await opened(remote, {store});
  const value = trip(); value.customPlaces.provider = {id: 'provider', name: 'Hydrated provider name', cat: 'attr', x: 1, y: 2, area: 'Provider address', typical: '60 min', blurb: 'Provider description', googlePlaceId: 'ChIJ_saved', rating: 4.9, photos: ['sensitive'], userNotes: 'My own notes'};
  await workspace.changeTrips(() => [value]);
  const data = JSON.stringify(await store.read(accountKey));
  assert.equal(data.includes('Hydrated provider'), false); assert.equal(data.includes('sensitive'), false);
  assert.ok(data.includes('ChIJ_saved')); assert.ok(data.includes('My own notes'));
  await workspace.sync(); assert.equal(JSON.stringify(remote.calls).includes('Provider address'), false);
});

await check('corrupt durable mutation IDs fail closed without replacing the record', async () => {
  const store = createMemoryWorkspaceStore();
  await assert.rejects(store.update(accountKey, () => ({...emptyWorkspace(accountKey), records: {'trip-one': {trip: trip(), deletedAt: null, base: null, remote: null, conflict: false, pending: {tripId: 'trip-one', mutationId: 'not-a-uuid', expectedRevision: 0, operation: 'create', trip: trip()}}}})), /could not be opened/);
  assert.equal(await store.read(accountKey), null);
});

await check('an unrelated successful fetch cannot clear a local-save failure or schema failure', async () => {
  const memory = createMemoryWorkspaceStore(); let fail = false;
  const store = {read: key => memory.read(key), update: (...args) => fail ? Promise.reject(new Error('Storage full')) : memory.update(...args)};
  const {workspace} = await opened(undefined, {store});
  fail = true; await assert.rejects(rename(workspace, 'Never saved'), /Storage full/);
  fail = false; await workspace.refresh();
  assert.equal(workspace.getSnapshot().status, 'failed');
  assert.equal(workspace.getSnapshot().trips[0].name, 'Kyoto');
  const configured = await opened();
  await rename(configured.workspace, 'Needs migration');
  configured.remote.beforeMutate = () => { throw new CloudError('setup', 'Apply migration'); };
  await configured.workspace.sync(); await configured.workspace.refresh();
  assert.equal(configured.workspace.getSnapshot().status, 'setup');
});

await check('an older conflict response cannot replace the newest saved alternative', async () => {
  const {workspace, remote} = await opened(); await rename(workspace, 'My draft');
  remote.rows.set('trip-one', saved(trip('trip-one', 'Latest other-device version'), 5)); await workspace.refresh();
  remote.rows.set('trip-one', saved(trip('trip-one', 'Older other-device version'), 3)); await workspace.refresh();
  assert.equal(workspace.getSnapshot().conflicts[0].remote.revision, 5);
});

await check('timeout preserves the exact durable mutation for a later retry', async () => {
  const store = createMemoryWorkspaceStore(), remote = fakeRemote([saved()]);
  const {workspace} = await opened(remote, {store, requestTimeoutMs: 10});
  const release = deferred(); remote.beforeMutate = () => release.promise;
  await rename(workspace, 'Retry safely'); await workspace.sync();
  assert.equal(workspace.getSnapshot().status, 'offline');
  const pending = (await store.read(accountKey)).records['trip-one'].pending;
  assert.equal(pending.mutationId, remote.calls[0].mutationId);
  release.resolve(); await Promise.resolve(); remote.beforeMutate = null;
  await workspace.retry(); assert.equal(workspace.getSnapshot().pendingCount, 0);
});

await check('new durable mutations explicitly use schema2 and workspace envelope2',async()=>{
  const store=createMemoryWorkspaceStore(), remote=fakeRemote([saved()]), {workspace}=await opened(remote,{store});
  await rename(workspace,'Flight-ready plan'); await workspace.sync();
  assert.equal(remote.calls[0].schemaVersion,2); assert.equal((await store.read(accountKey)).version,2);
});
await check('legacy durable outbox survives migration with its original schema and mutation identity',async()=>{
  const store=createMemoryWorkspaceStore(), original=trip(), edited={...trip(),name:'Legacy pending edit'};
  const issued={tripId:original.id,expectedRevision:1,mutationId:'10000000-0000-4000-8000-000000000001',operation:'save',trip:edited};
  await store.update(accountKey,()=>({version:1,key:accountKey,records:{[original.id]:{trip:edited,deletedAt:null,base:saved(original),pending:clone(issued),conflict:false,remote:null}},imports:[],remoteLoaded:true}));
  const remote=fakeRemote([saved(original)]), workspace=controller({store}); await workspace.setIdentity(owner,remote); await workspace.sync();
  assert.deepEqual(remote.calls[0],issued); assert.equal((await store.read(accountKey)).version,2);
  await rename(workspace,'New edit after v1 acknowledgement'); await workspace.sync();
  assert.equal(remote.calls[1].schemaVersion,2); assert.equal(workspace.getSnapshot().pendingCount,0);
});
await check('private flight and stay details survive durable saving and reload',async()=>{
  const store=createMemoryWorkspaceStore(), remote=fakeRemote([saved()]), {workspace}=await opened(remote,{store});
  await workspace.changeTrips(trips=>trips.map(value=>({...value,flights:[{id:'flight1',fromPlaceId:'nijo',toPlaceId:'gion',departure:{date:'2027-05-14',time:null,timezone:'Europe/London'},arrival:{date:'2027-05-15',time:null,timezone:'Asia/Tokyo'},bookingReference:'PRIVATE-FLIGHT'}],stays:[{id:'stay1',placeId:'hotel',checkInDate:'2027-05-14',checkOutDate:'2027-05-17',timezone:'Asia/Tokyo',privateNotes:'PRIVATE-STAY'}]})));
  await workspace.sync(); workspace.dispose(); active.delete(workspace);
  const reopened=controller({store}); await reopened.setIdentity(owner,remote); await reopened.refresh();
  assert.equal(reopened.getSnapshot().trips[0].flights[0].bookingReference,'PRIVATE-FLIGHT');
  assert.equal(reopened.getSnapshot().trips[0].stays[0].privateNotes,'PRIVATE-STAY');
});

await check('reconnect receipt counts only durably accepted server acknowledgements',async()=>{
  const {workspace,remote}=await opened();assert.equal(workspace.getSnapshot().acknowledgedCount,0);await rename(workspace,'Saved update');await workspace.sync();assert.equal(workspace.getSnapshot().acknowledgedCount,1);
  await rename(workspace,'Unsynced update');remote.beforeMutate=async()=>{throw new CloudError('unavailable','Offline');};await workspace.sync();assert.equal(workspace.getSnapshot().acknowledgedCount,1);
  await workspace.setIdentity(other,fakeRemote([]));assert.equal(workspace.getSnapshot().acknowledgedCount,0);
});
console.log(`\n${passed} workspace checks passed; ${failed} failed.`);
if (failed) process.exitCode = 1;
