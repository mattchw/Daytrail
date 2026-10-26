import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const urls = { react: import.meta.resolve('react') };
const add = (name, source = compile(`./${name}.ts`)) => urls[`./${name}`] = dataURL(source.replace(/from (['"])([^'"]+)\1/g,
  (match, _, path) => urls[path] ? `from ${JSON.stringify(urls[path])}` : match));
add('model'); add('openingHours'); add('visitHours');
add('googleMaps', compile('./googleMaps.ts').replaceAll('import.meta.env', '({})'));
add('discoveryData', 'export async function fetchVisitOpeningInfo() { throw new Error("Test must inject a provider"); }');
add('useLiveRoutes'); add('improveDay'); add('improveRoutes'); add('useImproveDay');
const { createImproveMatrixService, createImproveTaskPool, runImproveDay, ImproveRunError } = await import(urls['./improveRoutes']);
const { signature } = await import(urls['./improveDay']);
const { isImproveProposalCurrent, IMPROVE_REVIEW_MAX_AGE } = await import(urls['./useImproveDay']);
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }
const tick = () => new Promise(resolve => setImmediate(resolve));
const ready = (min, mode = 'walk') => ({ min, mode, km: '1.0', status: min === null ? 'unavailable' : 'ready', path: [] });
const point = (id, index) => ({ id, name: id, cat: 'attr', area: '', typical: '', blurb: '', x: 0, y: 0, lat: 35 + index / 100, lng: 135 });
function fixture(ids = ['a', 'b']) {
  return { tripId: 'trip', date: '2026-10-26', timezone: 'Asia/Tokyo',
    places: Object.fromEntries(['hotel', 'start', ...ids].map((id, index) => [id, point(id, index)])),
    day: { id: 'day', label: 'Day 1', title: '', date: '', startTime: 540, endMode: 'walk',
      items: ids.map(aid => ({ aid, placeId: aid, duration: 10, fixed: null, mode: 'walk', note: '' })) },
    hours: {}, locks: [] };
}
const matrix = input => Object.fromEntries(Object.keys(input.places).map(from => [from,
  Object.fromEntries(Object.keys(input.places).map(to => [to, ready(from === to ? 0 : 20)]))]));
function goodMatrix(input) {
  const value = matrix(input);
  value.hotel.b = ready(5); value.b.a = ready(5); value.a.hotel = ready(5);
  return value;
}
const realJourney = async (from, to, mode) => ready(['hotel:b', 'b:a', 'a:hotel'].includes(`${from.id}:${to.id}`) ? 5 : 10, mode);
function provider(run) {
  class Place { constructor({ id }) { this.id = id; } }
  return async () => ({ importLibrary: async name => name === 'routes' ? { RouteMatrix: { computeRouteMatrix: run } } : { Place } });
}
const response = (size, cell = (i, j) => ({ condition: 'ROUTE_EXISTS', durationMillis: (i * 10 + j + 1) * 60_000, distanceMeters: 1234 })) =>
  ({ matrix: { rows: Array.from({ length: size }, (_, i) => ({ items: Array.from({ length: size }, (__, j) => cell(i, j)) })) } });
const openHours = { fetchedAt: Date.parse('2026-10-26T00:00:00Z'), utcOffsetMinutes: 540,
  currentHours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }], weekdayDescriptions: [] } };

await check('matrix uses directed rows, positive rounding and minimal fields without walking traffic settings', async () => {
  let request;
  const compute = createImproveMatrixService(provider(async input => { request = input; return response(input.origins.length); }));
  const result = await compute(fixture());
  assert.equal(request.travelMode, 'WALKING');
  assert.equal(request.routingPreference, undefined);
  assert.deepEqual(request.fields, ['durationMillis', 'distanceMeters', 'condition']);
  assert.equal(result.a.b.min, 2); assert.equal(result.b.a.min, 11);
  assert.equal(result.hotel.hotel.min, 0);
  assert.equal(result.a.b.km, '1.2');
});
await check('driving uses TRAFFIC_UNAWARE and provider Place objects when available', async () => {
  const input = fixture(); input.day.endMode = 'drive'; input.day.items.forEach(item => item.mode = 'drive');
  input.places.a.googlePlaceId = 'place-a';
  let request;
  await createImproveMatrixService(provider(async value => { request = value; return response(value.origins.length); }))(input);
  assert.equal(request.travelMode, 'DRIVING'); assert.equal(request.routingPreference, 'TRAFFIC_UNAWARE');
  assert.equal(request.origins[0].id, 'place-a');
  assert.equal(request.origins[1].lat, input.places.b.lat);
});
await check('same provider and coincident locations deduplicate into zero journeys', async () => {
  const input = fixture(['a', 'b', 'c']);
  input.places.a.googlePlaceId = 'same'; input.places.b.googlePlaceId = 'same';
  Object.assign(input.places.c, { lat: input.places.hotel.lat, lng: input.places.hotel.lng });
  let size = 0;
  const result = await createImproveMatrixService(provider(async value => { size = value.origins.length; return response(size); }))(input);
  assert.equal(size, 2);
  assert.equal(result.a.b.min, 0); assert.equal(result.c.hotel.min, 0);
  assert.equal(result.a.hotel.min, result.b.c.min);
});
await check('all coincident stops avoid a matrix request entirely', async () => {
  const input = fixture(); Object.values(input.places).forEach(place => Object.assign(place, { lat: 35, lng: 135 }));
  let calls = 0;
  const result = await createImproveMatrixService(provider(async () => { calls++; return response(1); }))(input);
  assert.equal(calls, 0); assert.equal(result.a.b.min, 0);
});
await check('zero journeys remain exact when a coordinate alias also shares another provider ID', async () => {
  const input = fixture(['a', 'b', 'c']);
  Object.assign(input.places.b, { lat: input.places.a.lat, lng: input.places.a.lng, googlePlaceId: 'same-provider' });
  input.places.c.googlePlaceId = 'same-provider';
  const result = await createImproveMatrixService(provider(async request => response(request.origins.length)))(input);
  assert.equal(result.a.b.min, 0); assert.equal(result.b.c.min, 0);
  assert.notEqual(result.a.c.min, 0);
});
await check('8 stops plus distinct departure and return stay within 100 elements', async () => {
  const input = fixture(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']); input.day.startPlaceId = 'start';
  let elements;
  await createImproveMatrixService(provider(async value => { elements = value.origins.length * value.destinations.length; return response(value.origins.length); }))(input);
  assert.equal(elements, 100);
  input.day.items.push({ ...input.day.items[0], aid: 'extra' });
  await assert.rejects(() => createImproveMatrixService(provider(async () => { throw new Error('Must not request'); }))(input), /up to 8/);
});
await check('partial unavailable and malformed cells remain unknown rather than becoming straight-line travel', async () => {
  const result = await createImproveMatrixService(provider(async () => response(3, (i, j) => i === 0 && j === 1
    ? { condition: 'ROUTE_NOT_FOUND' } : i === 1 && j === 0 ? { condition: 'ROUTE_EXISTS', durationMillis: -1, distanceMeters: 10 }
      : { condition: 'ROUTE_EXISTS', durationMillis: 60_001, distanceMeters: 100 })))(fixture());
  assert.equal(result.a.b.min, null); assert.equal(result.b.a.min, null);
  assert.equal(result.hotel.a.min, 2);
});
await check('matrix cache shares in-flight requests and expires after ten minutes', async () => {
  let calls = 0, release, now = 1;
  const compute = createImproveMatrixService(provider(async () => { calls++; await new Promise(resolve => release = resolve); return response(3); }), () => now);
  const first = compute(fixture()); const second = compute(fixture());
  await tick(); assert.equal(calls, 1); release();
  await Promise.all([first, second]); await compute(fixture()); assert.equal(calls, 1);
  now += 600_001; const third = compute(fixture()); await tick(); assert.equal(calls, 2); release(); await third;
});
await check('failed matrix calls are sanitized and retryable instead of cached', async () => {
  let calls = 0;
  const compute = createImproveMatrixService(provider(async () => {
    if (++calls === 1) throw new Error('https://private.test?key=SECRET'); return response(3);
  }));
  await assert.rejects(() => compute(fixture()), error => error instanceof ImproveRunError && !/SECRET|private/.test(error.message));
  await compute(fixture()); assert.equal(calls, 2);
});
await check('canceling one subscriber does not discard a shared matrix needed by a new run', async () => {
  let active = true, calls = 0, release;
  const compute = createImproveMatrixService(provider(async () => { calls++; await new Promise(resolve => release = resolve); return response(3); }));
  const cancelled = compute(fixture(), () => active).catch(error => error.name);
  await tick(); active = false;
  const retry = compute(fixture()); release();
  assert.equal(await cancelled, 'AbortError'); assert.equal((await retry).a.b.status, 'ready'); assert.equal(calls, 1);
});
await check('queued work is bounded, canceled work never starts, and failures release workers', async () => {
  const enqueue = createImproveTaskPool(1); let active = true, started = 0, release;
  const first = enqueue(async () => { started++; await new Promise(resolve => release = resolve); throw new Error('failed'); }).catch(error => error.message);
  const cancelled = enqueue(async () => { started++; }, () => active).catch(error => error.name);
  const last = enqueue(async () => { started++; return 'complete'; });
  await tick(); assert.equal(started, 1); active = false; release();
  assert.equal(await first, 'failed'); assert.equal(await cancelled, 'AbortError'); assert.equal(await last, 'complete'); assert.equal(started, 2);
});
await check('verified comparison shows actual route savings instead of matrix savings', async () => {
  const input = fixture(), phases = [];
  const result = await runImproveDay(input, value => phases.push(value), undefined, { matrix: async () => goodMatrix(input), journey: realJourney });
  assert.equal(result.phase, 'proposal'); assert.deepEqual(phases, ['checking', 'comparing', 'verifying']);
  assert.equal(result.proposal.current.evaluation.schedule.travel, 30);
  assert.equal(result.proposal.suggested.evaluation.schedule.travel, 15);
  assert.equal(result.proposal.suggested.saving, 15);
  assert.deepEqual(result.proposal.suggested.order, ['b', 'a']);
  assert.equal(result.proposal.suggested.evaluation.unknownHours, 2);
  assert.match(result.proposal.warning, /sidewalks/);
  assert.deepEqual(input.day.items.map(item => item.aid), ['a', 'b']);
});
await check('ineligible mixed modes issue no paid requests', async () => {
  const input = fixture(); input.day.endMode = 'drive';
  const result = await runImproveDay(input, undefined, undefined, { matrix: async () => { throw new Error('Must not request'); } });
  assert.equal(result.phase, 'ineligible'); assert.equal(result.action, 'modes');
});
await check('full route verification can reject optimistic matrix savings', async () => {
  const input = fixture();
  const result = await runImproveDay(input, undefined, undefined, { matrix: async () => goodMatrix(input), journey: async (_, __, mode) => ready(10, mode) });
  assert.equal(result.phase, 'none'); assert.equal(result.proposal, undefined);
});
await check('a missing verified baseline is an explicit retryable error', async () => {
  const input = fixture();
  await assert.rejects(() => runImproveDay(input, undefined, undefined, { matrix: async () => goodMatrix(input),
    journey: async (from, to, mode) => from.id === 'hotel' && to.id === 'a' ? ready(null, mode) : realJourney(from, to, mode) }), /current journey needs a verified route/);
});
await check('fresh hours replace old evidence, and unavailable hours are allowed but counted', async () => {
  const input = fixture(); input.places.a.googlePlaceId = 'provider-a'; input.places.b.googlePlaceId = 'provider-b';
  input.hours.a = { ...openHours, businessStatus: 'CLOSED_PERMANENTLY' };
  const result = await runImproveDay(input, undefined, undefined, { matrix: async () => goodMatrix(input), journey: realJourney,
    fetchHours: async id => { if (id === 'provider-b') throw new Error('Provider failed'); return openHours; } });
  assert.equal(result.phase, 'proposal'); assert.equal(result.proposal.hoursErrors, 1);
  assert.equal(result.proposal.suggested.evaluation.unknownHours, 1);
  assert.equal(result.proposal.hours.a.businessStatus, undefined);
  assert.equal(result.proposal.hours.b, undefined);
  assert.notEqual(result.proposal.inputSignature, signature(input));
});
await check('verified travel reruns opening checks and rejects a newly short visit', async () => {
  const input = fixture(); input.places.b.googlePlaceId = 'provider-b';
  const shortHours = { ...openHours, currentHours: { periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 9, minute: 15 } }], weekdayDescriptions: [] } };
  const result = await runImproveDay(input, undefined, undefined, { matrix: async () => goodMatrix(input), fetchHours: async () => shortHours,
    journey: async (from, to, mode) => ready(from.id === 'hotel' && to.id === 'b' ? 15 : ['b:a', 'a:hotel'].includes(`${from.id}:${to.id}`) ? 5 : 20, mode) });
  assert.equal(result.phase, 'none');
});
await check('canceling hours checks prevents queued places and every later route request', async () => {
  const input = fixture(['a', 'b', 'c', 'd', 'e', 'f']);
  input.day.items.forEach(item => input.places[item.placeId].googlePlaceId = `provider-${item.aid}`);
  let active = true, requests = 0, matrixCalls = 0; const releases = [];
  const run = runImproveDay(input, undefined, () => active, {
    fetchHours: async () => { requests++; await new Promise(resolve => releases.push(resolve)); return openHours; },
    matrix: async () => { matrixCalls++; return goodMatrix(input); },
  }).catch(error => error.name);
  await tick(); assert.equal(requests, 4); active = false; releases.forEach(release => release());
  assert.equal(await run, 'AbortError'); await tick(); assert.equal(requests, 4); assert.equal(matrixCalls, 0);
});
await check('canceling final verification suppresses subsequent journeys', async () => {
  const input = fixture(); let active = true, calls = 0;
  await assert.rejects(() => runImproveDay(input, undefined, () => active, { matrix: async () => goodMatrix(input),
    journey: async (_, __, mode) => { calls++; active = false; return ready(10, mode); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
await check('proposal staleness ignores notes, accepts its own hours refresh and rejects changed timing or provider evidence', async () => {
  const input = fixture(); input.places.a.googlePlaceId = 'provider-a'; const now = Date.now();
  const observed = signature(input);
  const { proposal } = await runImproveDay(input, undefined, undefined, { matrix: async () => goodMatrix(input), journey: realJourney, fetchHours: async () => openHours, now: () => now });
  assert.equal(isImproveProposalCurrent(input, proposal, observed, now), true);
  input.day.items[0].note = 'Bring a camera';
  assert.equal(isImproveProposalCurrent(input, proposal, observed, now), true);
  input.hours = proposal.hours;
  assert.equal(isImproveProposalCurrent(input, proposal, observed, now), true);
  input.hours = { a: { ...openHours, fetchedAt: now } };
  assert.equal(isImproveProposalCurrent(input, proposal, observed, now), false);
  input.hours = proposal.hours; input.day.finishBy = 1_100;
  assert.equal(isImproveProposalCurrent(input, proposal, observed, now), false);
  delete input.day.finishBy;
  assert.equal(isImproveProposalCurrent(input, proposal, observed, now + IMPROVE_REVIEW_MAX_AGE), false);
});
console.log(`\n${passed} improve-day service checks passed.`);
