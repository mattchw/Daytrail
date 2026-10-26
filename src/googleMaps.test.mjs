import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const serviceURL = dataURL(compile('./googleMaps.ts').replaceAll('import.meta.env', '({})'));
const service = await import(serviceURL);
const hookURL = dataURL(compile('./useLiveRoutes.ts')
  .replace(/from ['"]react['"]/g, `from ${JSON.stringify(import.meta.resolve('react'))}`)
  .replace(/from ['"]\.\/googleMaps['"]/g, `from ${JSON.stringify(serviceURL)}`));
const { tripDayDate, zonedDeparture, transitDateReason, calculateDayRoutes, pendingLegs, routeInputSignature, reuseReadyStaticLegs } = await import(hookURL);
let passed = 0;
async function check(name, test) { await test(); passed += 1; console.log(`✓ ${name}`); }
const point = (id, lat = 35, lng = 135) => ({ id, name: id, cat: 'attr', area: '', typical: '', blurb: '', x: 0, y: 0, lat, lng });
const places = { hotel: point('hotel'), a: point('a', 35.1), b: point('b', 35.2), c: point('c', 35.3) };
const activity = (aid, overrides = {}) => ({ aid, placeId: aid, duration: 60, fixed: null, mode: 'walk', note: '', ...overrides });
const input = (items, overrides = {}) => ({ date: '2026-11-01', timezone: 'Asia/Tokyo', places,
  day: { id: 'd1', label: 'Day 1', title: 'Test', date: 'Sun 1', endMode: 'walk', items }, ...overrides });
const ready = (mode, min = 20) => ({ mode, min, km: '1.0', status: 'ready' });
const now = Date.parse('2026-10-26T00:00:00Z');

await check('trip date uses calendar days across leap and year boundaries', () => {
  assert.equal(tripDayDate('2028-02-28', 1), '2028-02-29');
  assert.equal(tripDayDate('2028-12-31', 1), '2029-01-01');
});
await check('transit departures use the destination timezone and DST', () => {
  assert.equal(zonedDeparture('2026-07-15', 540, 'Europe/London').toISOString(), '2026-07-15T08:00:00.000Z');
  assert.equal(zonedDeparture('2026-11-15', 540, 'Europe/London').toISOString(), '2026-11-15T09:00:00.000Z');
  assert.equal(zonedDeparture('2026-11-01', 1500, 'Asia/Tokyo').toISOString(), '2026-11-01T16:00:00.000Z');
  assert.equal(zonedDeparture('2026-03-29', 90, 'Europe/London'), null);
  assert.equal(zonedDeparture('2026-10-25', 90, 'Europe/London').toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(zonedDeparture('2026-11-01', 540, 'Not/AZone'), null);
});
await check('transit availability guards the requested trip date instead of using today', () => {
  assert.equal(transitDateReason(new Date(now + 99 * 86_400_000), now), null);
  assert.match(transitDateReason(new Date(now + 101 * 86_400_000), now), /100 days/);
  assert.match(transitDateReason(new Date(now - 8 * 86_400_000), now), /7 days/);
});
await check('fixed bookings preserve the feasible departure when arrival is late', async () => {
  const departures = [];
  const compute = async (from, to, mode, date) => { departures.push(date?.toISOString()); return ready(mode); };
  const plan = input([activity('a', { fixed: 550, duration: 90 }), activity('b', { mode: 'transit' })]);
  const result = await calculateDayRoutes(plan, undefined, undefined, compute, now);
  assert.equal(result.a.min, 20);
  assert.equal(departures[1], '2026-11-01T01:50:00.000Z'); // 09:20 arrival + 90-minute visit = 10:50 JST.
});
await check('unknown upstream travel blocks a fictional transit departure while walking can continue', async () => {
  const calls = [];
  const compute = async (from, to, mode) => { calls.push(to.id); return to.id === 'a' ? service.unavailableJourney(mode, 'No route') : ready(mode); };
  const result = await calculateDayRoutes(input([activity('a'), activity('b', { mode: 'transit', fixed: 800 }), activity('c')]), undefined, undefined, compute, now);
  assert.deepEqual(calls, ['a', 'c', 'hotel']);
  assert.match(result.b.reason, /earlier journeys/);
  assert.equal(result.c.min, 20);
});
await check('missing hotel cannot produce a made-up first leg; internal journeys still work', async () => {
  const noHotel = { ...places, hotel: { ...places.hotel, lat: undefined, lng: undefined } };
  const result = await calculateDayRoutes(input([activity('a'), activity('b')], { places: noHotel }), undefined, undefined, async (_, __, mode) => ready(mode), now);
  assert.match(result.a.reason, /map location/);
  assert.equal(result.b.min, 20);
  assert.match(result.return.reason, /map location/);
});
await check('future transit rejects without issuing a chargeable request', async () => {
  let calls = 0;
  const plan = input([activity('a', { mode: 'transit' })], { date: '2027-05-14' });
  plan.day.endMode = 'transit';
  const result = await calculateDayRoutes(plan, undefined, undefined, async (_, __, mode) => { calls++; return ready(mode); }, now);
  assert.equal(calls, 0);
  assert.match(result.a.reason, /100 days/);
  assert.equal(result.return.min, null);
});
await check('empty days do not request a hotel round trip', async () => {
  let calls = 0;
  const plan = input([]);
  assert.equal(pendingLegs(plan).return.min, 0);
  const result = await calculateDayRoutes(plan, undefined, undefined, async (_, __, mode) => { calls++; return ready(mode); }, now);
  assert.equal(calls, 0);
  assert.equal(result.return.min, 0);
});
await check('stale calculations stop before requesting subsequent legs', async () => {
  let active = true; let calls = 0; let updates = 0;
  await calculateDayRoutes(input([activity('a'), activity('b')]), () => updates++, () => active,
    async (_, __, mode) => { calls++; active = false; return ready(mode); }, now);
  assert.equal(calls, 1);
  assert.equal(updates, 0);
});
await check('notes and selection changes do not invalidate route inputs; timing and order do', () => {
  const trip = { id: 't', name: 'Trip', destination: 'Kyoto', startDate: '2026-11-01', timezone: 'Asia/Tokyo', days: [input([activity('a'), activity('b')]).day], ideas: [], customPlaces: {} };
  const original = routeInputSignature(trip, 0, places);
  trip.days[0].items[0].note = 'Bring water';
  assert.equal(routeInputSignature(trip, 0, places), original);
  trip.days[0].items[0].duration = 120;
  assert.notEqual(routeInputSignature(trip, 0, places), original);
  trip.days[0].items.reverse();
  assert.notEqual(routeInputSignature(trip, 0, places), original);
});
await check('duration edits preserve ready static journeys without a false zero-travel interval', () => {
  const prior = input([activity('a'), activity('b', { mode: 'drive' })]);
  const legs = { a: ready('walk', 48), b: ready('drive', 17), return: ready('walk', 45) };
  const changed = structuredClone(prior);
  changed.day.items[0].duration += 60;
  changed.day.items[1].fixed = 1000;
  changed.day.items[0].note = 'An updated note';
  const reused = reuseReadyStaticLegs(changed, prior, legs);
  assert.equal(reused.a.min, 48);
  assert.equal(reused.b.min, 17);
  assert.equal(reused.return.min, 45);
});
await check('static reuse never crosses a reordered pair, changed endpoint, mode, or stale transit departure', () => {
  const prior = input([activity('a'), activity('b', { mode: 'drive' })]);
  const legs = { a: ready('walk', 48), b: ready('drive', 17), return: ready('walk', 45) };
  const reordered = structuredClone(prior); reordered.day.items.reverse();
  assert.ok(Object.values(reuseReadyStaticLegs(reordered, prior, legs)).every(leg => leg.min === null));
  const remoded = structuredClone(prior); remoded.day.items[0].mode = 'drive';
  assert.equal(reuseReadyStaticLegs(remoded, prior, legs).a.min, null);
  const repinned = structuredClone(prior); repinned.places.a.googlePlaceId = 'new-google-place';
  assert.equal(reuseReadyStaticLegs(repinned, prior, legs).a.min, null);
  assert.equal(reuseReadyStaticLegs(repinned, prior, legs).b.min, null);
  const moved = structuredClone(prior); moved.places.a.lat += 0.01;
  assert.equal(reuseReadyStaticLegs(moved, prior, legs).a.min, null);
  const transit = input([activity('a', { mode: 'transit' })]);
  const shifted = structuredClone(transit); shifted.day.items[0].duration += 30;
  assert.equal(reuseReadyStaticLegs(shifted, transit, { a: ready('transit', 18) }).a.min, null);
});
await check('search preserves explicit geography and sanitizes upstream errors', () => {
  assert.equal(service.placeSearchQuery('coffee', 'Kyoto, Japan'), 'coffee in Kyoto, Japan');
  assert.equal(service.placeSearchQuery('coffee in Tokyo', 'Kyoto, Japan'), 'coffee in Tokyo');
  assert.equal(service.placeSearchQuery('Kyoto Station', 'Kyoto, Japan'), 'Kyoto Station');
  assert.doesNotMatch(service.mapsErrorMessage(new Error('https://example.com?key=private')), /private|example/);
  assert.match(service.mapsErrorMessage({ code: 'RESOURCE_EXHAUSTED' }), /usage limit/);
});
await check('long Google address IDs get deterministic compact keys and retain their full ID on reload', async () => {
  const longID = 'ChIJ' + 'abC0123_-'.repeat(40);
  const key = await service.googlePlaceKey(longID);
  assert.match(key, /^gplace-[0-9a-f]{64}$/);
  assert.equal(await service.googlePlaceKey(longID), key);
  assert.notEqual(await service.googlePlaceKey(longID + 'a'), key);
  assert.equal(await service.googlePlaceKey('ChIJ-existing_123'), 'google-ChIJ-existing_123');
  const originalWindow = globalThis.window;
  let fetchedID = null;
  class FakePlace {
    constructor({ id }) {
      this.id = id; this.displayName = 'A long address'; this.formattedAddress = 'An example address';
      this.location = { lat: () => 35, lng: () => 135 }; this.types = ['street_address']; this.attributions = [];
    }
    static async searchByText() { return { places: [new FakePlace({ id: longID })] }; }
    async fetchFields() { fetchedID = this.id; }
  }
  globalThis.window = { google: { maps: { importLibrary: async () => ({ Place: FakePlace }) } } };
  try {
    const withFakeConfig = compile('./googleMaps.ts').replaceAll('import.meta.env', '({VITE_GOOGLE_MAPS_API_KEY:"unit-test-key"})');
    const searchService = await import(dataURL(withFakeConfig + '\n// isolated search module'));
    const found = await searchService.searchPlaces('example address', 'Kyoto');
    assert.equal(found[0].id, key);
    assert.equal(found[0].googlePlaceId, longID);
    // A fresh module represents a reload with no cached provider details.
    const reloadService = await import(dataURL(withFakeConfig + '\n// isolated reload module'));
    const restored = await reloadService.fetchPlace(found[0].googlePlaceId);
    assert.equal(fetchedID, longID);
    assert.equal(restored.id, key);
    assert.equal(restored.googlePlaceId, longID);
    for (const invalid of ['has spaces', '../bad', 'id?key=x', 'x'.repeat(513)]) {
      await assert.rejects(() => reloadService.fetchPlace(invalid), /invalid Google Maps ID/);
      await assert.rejects(() => service.googlePlaceKey(invalid), /invalid Google Maps ID/);
    }
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
console.log(`\n${passed} Google Maps planning tests passed.`);
