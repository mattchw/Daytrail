import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const url = value => `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
const compile = (path, modules = {}) => url(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match));
const modelUrl = compile('../model.ts');
const backupUrl = compile('../tripBackup.ts', { './model': modelUrl });
const typesUrl = compile('./types.ts');
const codecUrl = compile('./codec.ts', { '../model': modelUrl, '../tripBackup': backupUrl, './types': typesUrl });
const remoteUrl = compile('./remote.ts', { './codec': codecUrl, './types': typesUrl });
const { seedTrip } = await import(modelUrl);
const { canonicalCloudTrip, cloudTripFingerprint, decodeCloudTrip } = await import(codecUrl);
const { createCloudRemote } = await import(remoteUrl);
const { CloudError } = await import(typesUrl);
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const mutationId = '10000000-0000-4000-8000-000000000001';
const date = '2026-10-26T20:00:00.123456+00:00';
const clone = value => JSON.parse(JSON.stringify(value));
const row = (trip = seedTrip(), revision = 1, deleted = false) => ({ owner_id: owner, trip_id: trip.id, schema_version: 1,
  document: canonicalCloudTrip(trip), revision, updated_at: date, deleted_at: deleted ? date : null });
const mutation = (operation = 'create', trip = seedTrip()) => ({ tripId: trip.id, expectedRevision: operation === 'create' ? 0 : 1,
  mutationId, operation, ...(['create','save'].includes(operation) ? { trip } : {}) });
function fixture({ rows = [], response = { status: 'ok', trip: row() }, error = null, during, sessionError = null } = {}) {
  let account = owner;
  const calls = [];
  const query = {
    select(value) { calls.push(['select', value]); return this; },
    eq(key, value) { calls.push(['eq', key, value]); return this; },
    order(value) { calls.push(['order', value]); return this; },
    async limit(value) { calls.push(['limit', value]); during?.(() => { account = other; }); return { data: rows, error }; },
  };
  const client = {
    auth: { async getSession() { return { data: { session: account ? { user: { id: account } } : null }, error: sessionError }; } },
    from(table) { calls.push(['from', table]); return query; },
    async rpc(name, args) { calls.push(['rpc', name, args]); during?.(() => { account = other; }); return { data: response, error }; },
  };
  return { calls, remote: createCloudRemote(client, owner), setAccount(value) { account = value; } };
}
let checks = 0;
async function check(name, action) { await action(); checks++; console.log(`✓ ${name}`); }
const rejects = (action, code) => assert.rejects(action, error => error instanceof CloudError && error.code === code);

await check('cloud codec preserves planning, endpoint and custom user fields without sharing references', () => {
  const trip = seedTrip();
  trip.customPlaces.meeting = { id: 'meeting', name: 'Our meeting', cat: 'custom', x: 4, y: 5, area: 'User address', typical: '45 min', blurb: 'Ring twice', lat: 35, lng: 135, userLabel: 'Friends', userNotes: 'Bring gifts' };
  trip.days[0].endPlaceId = 'meeting';
  const saved = canonicalCloudTrip(trip);
  assert.deepEqual(saved, trip);
  saved.days[0].items[0].note = 'Changed';
  assert.notEqual(saved.days[0].items[0].note, trip.days[0].items[0].note);
});
await check('cloud serializer strips Google hydration and arbitrary fields at every model level', () => {
  const trip = seedTrip(); trip.token = 'private'; trip.days[0].debug = 'private'; trip.days[0].items[0].secret = 'private';
  trip.customPlaces.google = { id: 'google', name: 'Provider name', cat: 'food', x: 4, y: 5, area: 'Provider address', typical: '60 min', blurb: 'Provider text', googlePlaceId: 'ChIJ_test', lat: 35, lng: 135, rating: 5, photos: ['private'], userLabel: 'Our lunch', userNotes: 'Book ahead' };
  const saved = canonicalCloudTrip(trip), encoded = JSON.stringify(saved);
  for (const text of ['private','Provider name','Provider address','Provider text','rating','photos','debug','secret','token']) assert.equal(encoded.includes(text), false, text);
  assert.deepEqual(saved.customPlaces.google, { id: 'google', name: 'Saved place', cat: 'food', x: 50, y: 50, area: '', typical: '60 min', blurb: '', googlePlaceId: 'ChIJ_test', userLabel: 'Our lunch', userNotes: 'Book ahead' });
});
await check('fingerprints are stable across object-key order and keep legacy text IDs', () => {
  const trip = seedTrip(); trip.id = 'import-' + 'a'.repeat(64);
  const reversed = Object.fromEntries(Object.entries(trip).reverse());
  assert.equal(cloudTripFingerprint(trip), cloudTripFingerprint(reversed));
  assert.equal(canonicalCloudTrip(trip).id, trip.id);
});
await check('invalid references and oversized documents cannot enter cloud storage', () => {
  const bad = seedTrip(); bad.days[0].endPlaceId = 'missing';
  assert.throws(() => canonicalCloudTrip(bad), error => error.code === 'invalid');
  const huge = seedTrip();
  huge.days = Array.from({ length: 10 }, (_, d) => ({ ...clone(huge.days[0]), id: `d-${d}`, items: Array.from({ length: 100 }, (_, i) => ({ ...clone(huge.days[0].items[0]), aid: `a-${d}-${i}`, note: 'x'.repeat(8000) })) }));
  assert.throws(() => canonicalCloudTrip(huge), error => error.code === 'invalid');
});
await check('database-incompatible text is rejected while valid emoji are preserved', () => {
  for (const text of ['nul\u0000inside','\ud800','a\udc00']) {
    const trip=seedTrip(); trip.days[0].items[0].note=text;
    assert.throws(()=>canonicalCloudTrip(trip),error=>error.code==='invalid');
  }
  const trip=seedTrip(); trip.days[0].items[0].note='Ticket 🎟️ and lunch 🍜';
  assert.equal(canonicalCloudTrip(trip).days[0].items[0].note,trip.days[0].items[0].note);
});
await check('server rows reject wrong owners, future schemas, unknown fields and invalid metadata', () => {
  for (const [patch, code] of [[{ owner_id: other },'auth'],[{ schema_version: 3 },'setup'],[{ revision: 0 },'invalid'],[{ revision: Number.MAX_SAFE_INTEGER + 1 },'invalid'],[{ updated_at: 'yesterday' },'invalid'],[{ deleted_at: 'invalid' },'invalid'],[{ trip_id: 'different' },'invalid']]) {
    assert.throws(() => decodeCloudTrip({ ...row(), ...patch }, owner), error => error.code === code);
  }
  const extra = row(); extra.document.secret = 'Do not persist';
  assert.throws(() => decodeCloudTrip(extra, owner), error => error.code === 'invalid');
  const reordered = row(); reordered.document = Object.fromEntries(Object.entries(reordered.document).reverse());
  assert.equal(decodeCloudTrip(reordered, owner).trip.id, reordered.trip_id);
});
await check('create sends canonical data and an explicit expected-account guard', async () => {
  const f = fixture(); const result = await f.remote.mutate(mutation());
  assert.equal(result.revision, 1);
  const [_, name, args] = f.calls.find(call => call[0] === 'rpc');
  assert.equal(name, 'daytrail_mutate_trip');
  assert.deepEqual(args, { p_expected_owner_id: owner, p_trip_id: seedTrip().id, p_expected_revision: 0, p_mutation_id: mutationId, p_operation: 'create', p_document: canonicalCloudTrip(seedTrip()), p_schema_version: 1 });
});
await check('listing filters by bound owner and retains tombstones', async () => {
  const f = fixture({ rows: [row(seedTrip(), 2, true)] });
  const trips = await f.remote.list();
  assert.equal(trips[0].deletedAt, date);
  assert.ok(f.calls.some(call => JSON.stringify(call) === JSON.stringify(['eq','owner_id',owner])));
  assert.ok(f.calls.some(call => JSON.stringify(call) === JSON.stringify(['limit',101])));
});
await check('duplicate or oversized lists fail without applying partial results', async () => {
  await rejects(() => fixture({ rows: [row(),row()] }).remote.list(), 'invalid');
  await rejects(() => fixture({ rows: Array.from({ length: 101 }, () => row()) }).remote.list(), 'invalid');
});
await check('wrong or signed-out session prevents sending a queued mutation', async () => {
  for (const account of [other, null]) {
    const f = fixture(); f.setAccount(account);
    await rejects(() => f.remote.mutate(mutation()), 'auth');
    assert.equal(f.calls.length, 0);
  }
});
await check('offline session refresh remains retryable without reporting an account switch', async () => {
  const f=fixture({sessionError:{name:'AuthRetryableFetchError',status:0,message:'SECRET network details'}});
  await rejects(()=>f.remote.mutate(mutation()),'unavailable');
  assert.equal(f.calls.length,0);
});
await check('account changes during list or mutation reject late results', async () => {
  const during = switchAccount => switchAccount();
  await rejects(() => fixture({ during }).remote.mutate(mutation()), 'auth');
  await rejects(() => fixture({ during, rows: [row()] }).remote.list(), 'auth');
});
await check('invalid mutation metadata is rejected before any network request', async () => {
  for (const patch of [{ mutationId: 'bad' },{ expectedRevision: 1 },{ tripId: 'other' },{ operation: 'purge' },{ expectedRevision: -1 }]) {
    const f = fixture(); await rejects(() => f.remote.mutate({ ...mutation(), ...patch }), 'invalid'); assert.equal(f.calls.length,0);
  }
  await rejects(() => fixture().remote.mutate({ ...mutation('delete'), trip: seedTrip() }), 'invalid');
});
await check('acknowledgements require correct revision, trip, state and exact saved content', async () => {
  const different = seedTrip(); different.name = 'Different server content';
  const wrongId = seedTrip(); wrongId.id = 'other';
  for (const trip of [row(seedTrip(),2),row(seedTrip(),1,true),row(different),row(wrongId)]) {
    await rejects(() => fixture({ response: { status: 'ok', trip } }).remote.mutate(mutation()), 'invalid');
  }
  await rejects(() => fixture({ response: { status: 'unknown', trip: row() } }).remote.mutate(mutation()), 'invalid');
});
await check('delete and restore acknowledge only the expected tombstone transition', async () => {
  assert.equal((await fixture({ response: { status:'ok', trip:row(seedTrip(),2,true) } }).remote.mutate(mutation('delete'))).deletedAt,date);
  assert.equal((await fixture({ response: { status:'ok', trip:row(seedTrip(),2,false) } }).remote.mutate(mutation('restore'))).deletedAt,null);
  await rejects(() => fixture({ response: { status:'ok', trip:row(seedTrip(),2,false) } }).remote.mutate(mutation('delete')),'invalid');
  await rejects(() => fixture({ response: { status:'ok', trip:row(seedTrip(),2,true) } }).remote.mutate(mutation('restore')),'invalid');
});
await check('conflicts carry the current owner-scoped version or a missing-row signal', async () => {
  const f = fixture({ response: { status:'conflict',trip:row(seedTrip(),3) } });
  await assert.rejects(() => f.remote.mutate(mutation('save')), error => error.code === 'conflict' && error.current.revision === 3);
  await assert.rejects(() => fixture({ response:{ status:'conflict',trip:null } }).remote.mutate(mutation('save')), error => error.code === 'conflict' && error.current === undefined);
  const otherTrip = seedTrip(); otherTrip.id = 'other';
  await rejects(() => fixture({ response:{ status:'conflict',trip:row(otherTrip,3) } }).remote.mutate(mutation('save')), 'invalid');
});
await check('provider/database errors map to fixed messages without leaking details', async () => {
  for (const [code, expected] of [['42501','auth'],['PGRST301','auth'],['PGRST202','setup'],['42P01','setup'],['22023','invalid'],['23514','invalid'],['unknown','unavailable']]) {
    await assert.rejects(() => fixture({ error:{ code,message:'SECRET password and raw SQL',details:'SECRET' } }).remote.mutate(mutation()), error => error.code === expected && !error.message.includes('SECRET'));
  }
});
await check('schema2 writes are explicit and schema1 reads remain compatible',async()=>{
  const f=fixture({response:{status:'ok',trip:{...row(),schema_version:2}}});
  await f.remote.mutate({...mutation(),schemaVersion:2});
  assert.equal(f.calls.find(call=>call[0]==='rpc')[2].p_schema_version,2);
  assert.equal(decodeCloudTrip(row(),owner).trip.id,seedTrip().id);
});
await check('legacy issued mutation keeps its schema1 payload for idempotent retry',async()=>{
  const issued=mutation(), before=clone(issued), f=fixture(); await f.remote.mutate(issued);
  assert.deepEqual(issued,before); assert.equal(f.calls.find(call=>call[0]==='rpc')[2].p_schema_version,1);
});
await check('free-time schema survives cloud roundtrip and cannot be mislabeled as schema1',async()=>{
  const trip=seedTrip();trip.days[0].items[0].freeTime={id:'free-cloud',kind:'rest',duration:30,untilBooking:true};
  assert.throws(()=>decodeCloudTrip(row(trip),owner),error=>error.code==='invalid');
  await rejects(()=>fixture().remote.mutate(mutation('create',trip)),'invalid');
  const saved={...row(trip),schema_version:2};assert.deepEqual(decodeCloudTrip(saved,owner).trip.days[0].items[0].freeTime,trip.days[0].items[0].freeTime);
  const f=fixture({response:{status:'ok',trip:saved}});await f.remote.mutate({...mutation('create',trip),schemaVersion:2});
  assert.deepEqual(f.calls.find(call=>call[0]==='rpc')[2].p_document.days[0].items[0].freeTime,trip.days[0].items[0].freeTime);
});
await check('booking schema cannot be mislabeled as schema1 on read or write',async()=>{
  const trip=seedTrip(); trip.flights=[]; trip.stays=[];
  assert.throws(()=>decodeCloudTrip(row(trip),owner),error=>error.code==='invalid');
  await rejects(()=>fixture().remote.mutate(mutation('create',trip)),'invalid');
  const savedRow={...row(trip),schema_version:2};
  assert.deepEqual(decodeCloudTrip(savedRow,owner).trip.flights,[]);
});
await check('old client downgrade rejection gives a recoverable setup status',async()=>{
  await rejects(()=>fixture({error:{code:'0A000'}}).remote.mutate(mutation()),'setup');
});

console.log(`\n${checks} cloud codec and transport checks passed.`);
