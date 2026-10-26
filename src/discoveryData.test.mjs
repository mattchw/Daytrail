import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const mapsURL = dataURL(compile('./googleMaps.ts').replaceAll('import.meta.env', '({VITE_GOOGLE_MAPS_API_KEY:"unit-test-key"})'));
const hoursURL = dataURL(compile('./openingHours.ts'));
const discoveryURL = dataURL(compile('./discoveryData.ts')
  .replace(/from ['"]\.\/googleMaps['"]/g, `from ${JSON.stringify(mapsURL)}`)
  .replace(/from ['"]\.\/openingHours['"]/g, `from ${JSON.stringify(hoursURL)}`));
const service = await import(discoveryURL);
const { getOpeningSummary } = service;
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }
const point = (day, hour, minute = 0) => ({ day, hour, minute });
const schedule = periods => ({ periods, weekdayDescriptions: [] });
const period = (day, start, end, closeDay = day) => ({ open: point(day, start), close: point(closeDay, end) });
const now = new Date('2026-10-26T03:00:00Z'); // Monday noon in Kyoto.
const current = schedule([period(1, 9, 13), period(1, 15, 18), period(2, 9, 17)]);
const info = overrides => ({ currentHours: current, regularHours: current, utcOffsetMinutes: 540, fetchedAt: now.getTime(), ...overrides });

await check('current status uses the place timezone and closes between split sessions', () => {
  const open = getOpeningSummary(info(), { now });
  assert.equal(open.label, 'Open now');
  assert.deepEqual(open.hours, ['09:00–13:00', '15:00–18:00']);
  assert.equal(getOpeningSummary(info(), { now: new Date('2026-10-26T05:00:00Z') }).label, 'Closed now');
  assert.equal(getOpeningSummary(info(), { now: new Date('2026-10-26T04:00:00Z') }).status, 'closed');
  assert.equal(getOpeningSummary(info(), { now: new Date('2026-10-26T06:00:00Z') }).status, 'open');
});
await check('overnight periods carry into the next day and across the week boundary', () => {
  const hours = schedule([period(6, 22, 2, 0)]);
  const weekend = info({ currentHours: hours, regularHours: hours, fetchedAt: Date.parse('2026-10-31T00:00:00Z') });
  assert.equal(getOpeningSummary(weekend, { now: new Date('2026-10-31T16:00:00Z') }).status, 'open');
  assert.deepEqual(getOpeningSummary(weekend, { date: '2026-11-01', now }).hours, ['00:00–02:00']);
  assert.equal(getOpeningSummary(weekend, { now: new Date('2026-10-31T17:00:00Z') }).status, 'closed');
});
await check('24-hour opening is explicit and incomplete periods remain unknown', () => {
  const allDay = schedule([{ open: point(0, 0) }]);
  assert.deepEqual(getOpeningSummary(info({ currentHours: allDay }), { now }).hours, ['Open 24 hours']);
  assert.equal(getOpeningSummary(info({ currentHours: allDay }), { now }).status, 'open');
  const incomplete = schedule([{ open: point(1, 9) }]);
  assert.equal(getOpeningSummary(info({ currentHours: incomplete }), { now }).status, 'unknown');
});
await check('future trip dates use regular hours without claiming confirmed opening', () => {
  const result = getOpeningSummary(info(), { date: '2027-05-14', now });
  assert.equal(result.label, 'Regular Friday hours');
  assert.equal(result.source, 'regular');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.hours, ['Closed']);
  assert.match(result.detail, /holiday hours may differ/);
  assert.equal(getOpeningSummary(info(), { date: '2026-10-27', now }).label, 'Tuesday hours');
  assert.equal(getOpeningSummary(info(), { date: '2026-10-26', now }).label, 'Monday hours');
});
await check('the seventh future day and expired current data use regular schedules', () => {
  assert.equal(getOpeningSummary(info(), { date: '2026-11-01', now }).source, 'current');
  assert.equal(getOpeningSummary(info(), { date: '2026-11-02', now }).source, 'regular');
  const stale = info({ fetchedAt: now.getTime() - 8 * 86_400_000 });
  assert.equal(getOpeningSummary(stale, { now }).label, 'Usually open now');
});
await check('missing hours and timezone are unknown; UTC zero is a valid offset', () => {
  assert.equal(getOpeningSummary(info({ currentHours: undefined, regularHours: undefined }), { now }).status, 'unknown');
  assert.equal(getOpeningSummary(info({ utcOffsetMinutes: undefined }), { now }).status, 'unknown');
  assert.equal(getOpeningSummary(info({ utcOffsetMinutes: 0 }), { now: new Date('2026-10-26T12:00:00Z') }).status, 'open');
  assert.equal(getOpeningSummary(info({ currentHours: undefined }), { now }).label, 'Usually open now');
});
await check('empty or malformed opening data does not invent a closure', () => {
  assert.equal(getOpeningSummary(info({ currentHours: schedule([]) }), { now }).status, 'unknown');
  assert.equal(getOpeningSummary(info({ currentHours: schedule([{ open: point(8, 25), close: point(1, 10) }]) }), { now }).status, 'unknown');
  const closed = { periods: [], weekdayDescriptions: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(day => `${day}: Closed`) };
  assert.equal(getOpeningSummary(info({ currentHours: closed }), { now }).status, 'closed');
});
await check('business closures override weekly hours and invalid dates remain unknown', () => {
  assert.equal(getOpeningSummary(info({ businessStatus: 'CLOSED_PERMANENTLY' }), { now }).label, 'Permanently closed');
  assert.equal(getOpeningSummary(info({ businessStatus: 'CLOSED_TEMPORARILY' }), { date: '2027-05-14', now }).label, 'Temporarily closed');
  assert.equal(getOpeningSummary(info(), { date: '2026-02-30', now }).status, 'unknown');
});
await check('map searches restrict bounds without silently appending the trip city', () => {
  const bounds = { north: 36, south: 34, east: 136, west: 134 };
  const request = service.discoverySearchRequest('coffee', 'Kyoto, Japan', 'cafes', bounds);
  assert.equal(request.textQuery, 'coffee');
  assert.equal(request.includedType, 'cafe');
  assert.equal(request.useStrictTypeFiltering, true);
  assert.deepEqual(request.locationRestriction, bounds);
  assert.equal(service.discoverySearchRequest('coffee', 'Kyoto, Japan', 'all').textQuery, 'coffee in Kyoto, Japan');
  assert.equal(service.discoverySearchRequest('', 'Kyoto', 'all', bounds).textQuery, 'tourist attractions');
  assert.equal(service.discoverySearchRequest('art', 'Kyoto', 'museums').includedType, 'museum');
  assert.equal(service.discoverySearchRequest('', 'Kyoto', 'temples').includedType, undefined);
  assert.match(service.discoverySearchRequest('', 'Kyoto', 'temples').textQuery, /temples/);
  assert.equal(service.discoverySearchRequest('coffee in Tokyo', 'Kyoto', 'all').textQuery, 'coffee in Tokyo');
});
await check('bounds support date-line wrapping and reject empty or invalid viewports', () => {
  const bounds = { north: 20, south: -20, west: 170, east: -170 };
  assert.equal(service.validSearchBounds(bounds), true);
  assert.equal(service.withinSearchBounds({ lat: 0, lng: 179 }, bounds), true);
  assert.equal(service.withinSearchBounds({ lat: 0, lng: -179 }, bounds), true);
  assert.equal(service.withinSearchBounds({ lat: 0, lng: 0 }, bounds), false);
  assert.equal(service.validSearchBounds({ ...bounds, east: 170 }), false);
  assert.throws(() => service.discoverySearchRequest('cafe', 'Tokyo', 'cafes', { ...bounds, north: NaN }), /valid search area/);
});

const originalWindow = globalThis.window;
const realNow = Date.now;
let mockedNow = now.getTime();
let searchCalls = 0, detailCalls = 0, photoCalls = 0, rejectSearch = false, rejectDetail = false;
let requests = [], fetchRequests = [];
const fakePhoto = number => ({ widthPx: 1000, heightPx: 800, authorAttributions: [{ displayName: `Photographer ${number}`, uri: 'https://example.com/author' }, { displayName: 'Unsafe link', uri: 'javascript:alert(1)' }],
  getURI(options) { photoCalls++; return `https://example.com/photo/${number}?width=${options.maxWidth}`; } });
class FakePlace {
  constructor({ id }) {
    Object.assign(this, { id, displayName: 'Temple', formattedAddress: 'Kyoto', location: { lat: () => 35, lng: () => 135 }, types: ['tourist_attraction'], attributions: [],
      googleMapsURI: 'https://maps.google.com/place', primaryTypeDisplayName: 'Tourist attraction', businessStatus: 'OPERATIONAL', rating: 4.7, userRatingCount: 1234, utcOffsetMinutes: 540,
      currentOpeningHours: current, regularOpeningHours: current, photos: [fakePhoto(1), fakePhoto(2), fakePhoto(3)] });
    if (id === 'primary-museum') { this.primaryType = 'museum'; this.types = ['museum', 'cafe', 'restaurant']; }
    if (id === 'primary-cafe') { this.primaryType = 'cafe'; this.types = ['cafe', 'tourist_attraction']; }
    if (id === 'primary-lodging') { this.primaryType = 'hotel'; this.types = ['hotel', 'restaurant']; }
    if (id === 'secondary-cafe') this.types = ['cafe'];
  }
  static async searchByText(request) {
    searchCalls++; requests.push(request);
    if (rejectSearch) throw { code: 'RESOURCE_EXHAUSTED', message: 'do-not-expose-request' };
    const outside = new FakePlace({ id: 'outside' }); outside.location = { lat: () => 40, lng: () => 140 };
    return { places: [new FakePlace({ id: 'ChIJ-test_place' }), outside] };
  }
  async fetchFields(request) {
    detailCalls++; fetchRequests.push(request);
    if (rejectDetail) throw { code: 'NOT_FOUND', message: 'do-not-expose-request' };
    this.displayName = 'Temple details';
  }
}
globalThis.window = { google: { maps: { importLibrary: async () => ({ Place: FakePlace }) } } };
Date.now = () => mockedNow;
try {
  await check('real service adapter requests explicit rich fields and normalizes transient metadata', async () => {
    const results = await service.searchDiscovery('temple', 'Kyoto', 'temples');
    assert.equal(searchCalls, 1);
    assert.equal(results[0].info.rating, 4.7);
    assert.equal(results[0].info.ratingCount, 1234);
    assert.equal(results[0].info.photos.length, 1);
    assert.deepEqual(results[0].info.currentHours.periods, current.periods);
    assert.equal(results[0].place.googlePlaceId, 'ChIJ-test_place');
    assert.equal('rating' in results[0].place, false);
    assert.equal(photoCalls, 0);
    for (const field of ['primaryType', 'photos', 'rating', 'userRatingCount', 'currentOpeningHours', 'utcOffsetMinutes']) assert.ok(requests[0].fields.includes(field));
    assert.equal(requests[0].fields.includes('regularOpeningHours'), false);
    assert.equal(requests[0].maxResultCount, 8);
  });
  await check('photos resolve only on demand, preserve credits, and reuse the same size URL', async () => {
    const results = await service.searchDiscovery('temple', 'Kyoto', 'temples');
    const photo = results[0].info.photos[0];
    assert.equal(photo.authors[0].name, 'Photographer 1');
    assert.equal(photo.authors[1].uri, undefined);
    assert.equal(service.getDiscoveryPhotoURL(photo, 400), 'https://example.com/photo/1?width=400');
    assert.equal(service.getDiscoveryPhotoURL(photo, 400), 'https://example.com/photo/1?width=400');
    assert.equal(photoCalls, 1);
    service.getDiscoveryPhotoURL(photo, 1000);
    assert.equal(photoCalls, 2);
  });
  await check('card cache cannot satisfy a detailed photo request; detail cache prevents duplicates', async () => {
    const detail = await service.fetchDiscoveryDetails('ChIJ-test_place');
    assert.equal(detailCalls, 1);
    assert.equal(detail.info.photos.length, 3);
    assert.equal(detail.place.name, 'Temple details');
    await service.fetchDiscoveryDetails('ChIJ-test_place');
    assert.equal(detailCalls, 1);
    assert.ok(fetchRequests[0].fields.includes('photos'));
    assert.ok(fetchRequests[0].fields.includes('regularOpeningHours'));
  });
  await check('map result filtering enforces submitted area and category cache keys stay independent', async () => {
    const bounds = { north: 36, south: 34, east: 136, west: 134 };
    const before = searchCalls;
    const results = await service.searchDiscovery('coffee', 'Kyoto', 'cafes', bounds);
    assert.equal(results.length, 1);
    await service.searchDiscovery('coffee', 'Kyoto', 'cafes', bounds);
    assert.equal(searchCalls, before + 1);
    await service.searchDiscovery('coffee', 'Kyoto', 'restaurants', bounds);
    await service.searchDiscovery('coffee', 'Kyoto', 'cafes', { ...bounds, east: 137 });
    assert.equal(searchCalls, before + 3);
  });
  await check('failed requests are evicted for retry and only fixed errors leave the service', async () => {
    rejectSearch = true;
    await assert.rejects(() => service.searchDiscovery('retry', 'Kyoto', 'all'), /usage limit/);
    rejectSearch = false;
    assert.equal((await service.searchDiscovery('retry', 'Kyoto', 'all')).length, 2);
    rejectDetail = true;
    await assert.rejects(() => service.fetchDiscoveryDetails('ChIJ-retry'), error => /could not be found/.test(error.message) && !/do-not-expose/.test(error.message));
    rejectDetail = false;
    assert.equal((await service.fetchDiscoveryDetails('ChIJ-retry')).place.name, 'Temple details');
  });
  await check('expired search and detail caches refresh independently and photo handles expire', async () => {
    const results = await service.searchDiscovery('temple', 'Kyoto', 'temples');
    const photo = results[0].info.photos[0];
    const beforeSearch = searchCalls, beforeDetail = detailCalls;
    mockedNow += 6 * 60_000;
    await service.searchDiscovery('temple', 'Kyoto', 'temples');
    assert.equal(searchCalls, beforeSearch + 1);
    assert.equal(detailCalls, beforeDetail);
    await service.fetchDiscoveryDetails('ChIJ-test_place');
    assert.equal(detailCalls, beforeDetail + 1);
    mockedNow += 10 * 60_000;
    assert.equal(service.getDiscoveryPhotoURL(photo), undefined);
  });
  await check('primary place type takes precedence over secondary cafés or restaurants', async () => {
    assert.equal((await service.fetchDiscoveryDetails('primary-museum')).place.cat, 'attr');
    assert.equal((await service.fetchDiscoveryDetails('primary-cafe')).place.cat, 'food');
    assert.equal((await service.fetchDiscoveryDetails('primary-lodging')).place.cat, 'custom');
    assert.equal((await service.fetchDiscoveryDetails('secondary-cafe')).place.cat, 'food');
  });
  await check('long valid IDs are retained and invalid IDs do not trigger requests', async () => {
    const longID = 'ChIJ' + 'abC123_-'.repeat(40);
    const result = await service.fetchDiscoveryDetails(longID);
    assert.equal(result.place.googlePlaceId, longID);
    assert.match(result.place.id, /^gplace-[0-9a-f]{64}$/);
    const before = detailCalls;
    for (const id of ['bad id', '../x', 'x'.repeat(513)]) await assert.rejects(() => service.fetchDiscoveryDetails(id), /invalid Google Maps ID/);
    assert.equal(detailCalls, before);
  });
} finally {
  Date.now = realNow;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log(`\n${passed} discovery service and opening-hours tests passed.`);
