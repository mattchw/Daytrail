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
  .replaceAll('import.meta.env', '({VITE_GOOGLE_MAPS_API_KEY:"unit-test-key"})')
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
  assert.equal(service.discoverySearchRequest('', 'Kyoto', 'parks').includedType, 'park');
  assert.equal(service.discoverySearchRequest('', 'Kyoto', 'nightlife').includedType, 'bar');
  assert.equal(service.discoverySearchRequest('', 'Kyoto', 'shopping').includedType, undefined);
  assert.match(service.discoverySearchRequest('', 'Kyoto', 'shopping').textQuery, /shopping, markets and malls/);
  assert.equal(service.discoverySearchRequest('coffee in Tokyo', 'Kyoto', 'all').textQuery, 'coffee in Tokyo');
});
await check('shopping retains broad retail intent for custom queries and destination or map searches', () => {
  const bounds = { north: 52, south: 51, east: 1, west: -1 };
  const street = service.discoverySearchRequest('Oxford Street', 'London', 'shopping');
  assert.equal(street.textQuery, 'Oxford Street shopping in London');
  assert.equal(street.includedType, undefined, 'shopping must not exclude markets and independent shops');
  assert.equal(service.discoverySearchRequest('Oxford Street', 'London', 'shopping', bounds).textQuery, 'Oxford Street shopping');
  for (const query of ['shopping', 'independent shops', 'covered markets', 'outlet malls', 'boutiques', 'department stores']) {
    assert.equal(service.discoverySearchRequest(query, 'London', 'shopping').textQuery, `${query} in London`);
  }
  assert.equal(service.discoverySearchRequest('vintage shops in Paris', 'London', 'shopping').textQuery, 'vintage shops in Paris');
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
const originalFetch = globalThis.fetch;
const realNow = Date.now;
let mockedNow = now.getTime();
let searchCalls = 0, detailCalls = 0, photoCalls = 0, rejectSearch = false, rejectDetail = false;
let requests = [], fetchRequests = [];
let restHandler;
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
    throw new Error('Paginated discovery must use REST, not the unpaged SDK search.');
  }
  async fetchFields(request) {
    detailCalls++; fetchRequests.push(request);
    if (rejectDetail) throw { code: 'NOT_FOUND', message: 'do-not-expose-request' };
    this.displayName = 'Temple details';
  }
}
const restPlace = (id = 'ChIJ-test_place', overrides = {}) => ({
  id, displayName: { text: 'Temple' }, formattedAddress: 'Kyoto', location: { latitude: 35, longitude: 135 }, types: ['tourist_attraction'],
  attributions: [{ provider: 'Venue data', providerUri: 'https://example.com/venue' }, { provider: 'Bad link', providerUri: 'javascript:alert(1)' }],
  googleMapsUri: 'https://maps.google.com/place', primaryType: 'tourist_attraction', primaryTypeDisplayName: { text: 'Tourist attraction' }, businessStatus: 'OPERATIONAL', rating: 4.7, userRatingCount: 1234, utcOffsetMinutes: 540,
  currentOpeningHours: current, photos: [1, 2, 3].map(number => ({ name: `places/${id}/photos/photo-${number}`, widthPx: 1000, heightPx: 800, authorAttributions: [{ displayName: `Photographer ${number}`, uri: 'https://example.com/author' }, { displayName: 'Unsafe link', uri: 'javascript:alert(1)' }] })),
  ...overrides,
});
globalThis.fetch = async (url, options) => {
  searchCalls++;
  const body = JSON.parse(options.body);
  requests.push({ url, options, body });
  if (restHandler) return restHandler(url, options, body);
  if (rejectSearch) return { ok: false, status: 429, json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'do-not-expose-request' } }) };
  return { ok: true, status: 200, json: async () => ({ places: [restPlace(), restPlace('outside', { location: { latitude: 40, longitude: 140 } })] }) };
};
globalThis.window = { google: { maps: { importLibrary: async () => ({ Place: FakePlace }) } } };
Date.now = () => mockedNow;
try {
  await check('real service adapter requests explicit rich fields and normalizes transient metadata', async () => {
    const results = await service.searchDiscovery('temple', 'Kyoto', 'all');
    assert.equal(searchCalls, 1);
    assert.equal(results[0].info.rating, 4.7);
    assert.equal(results[0].info.ratingCount, 1234);
    assert.equal(results[0].info.photos.length, 1);
    assert.deepEqual(results[0].info.currentHours.periods, current.periods);
    assert.equal(results[0].place.googlePlaceId, 'ChIJ-test_place');
    assert.equal('rating' in results[0].place, false);
    assert.equal(photoCalls, 0);
    assert.equal(detailCalls, 0);
    const { url, options, body } = requests[0];
    assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(options.method, 'POST');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['X-Goog-Api-Key'], 'unit-test-key');
    const fields = options.headers['X-Goog-FieldMask'].split(',');
    for (const field of ['primaryType', 'photos', 'rating', 'userRatingCount', 'currentOpeningHours', 'utcOffsetMinutes', 'googleMapsUri', 'attributions']) assert.ok(fields.includes(`places.${field}`));
    assert.ok(fields.includes('nextPageToken'));
    assert.equal(fields.includes('places.regularOpeningHours'), false);
    assert.equal(body.pageSize, 10);
    assert.equal(body.languageCode, 'en');
    assert.equal(body.textQuery, 'temple in Kyoto');
    assert.equal(results[0].place.attributions[0].providerURI, 'https://example.com/venue');
    assert.equal(results[0].place.attributions[1].providerURI, undefined);
    assert.equal(results[0].place.googleMapsURI, 'https://maps.google.com/place');
  });
  await check('photos resolve only on demand, preserve credits, and reuse the same size URL', async () => {
    const results = await service.searchDiscovery('temple', 'Kyoto', 'all');
    const photo = results[0].info.photos[0];
    assert.equal(photo.authors[0].name, 'Photographer 1');
    assert.equal(photo.authors[1].uri, undefined);
    const before = searchCalls;
    const url = service.getDiscoveryPhotoURL(photo, 400);
    assert.equal(url, 'https://places.googleapis.com/v1/places/ChIJ-test_place/photos/photo-1/media?key=unit-test-key&maxWidthPx=400');
    assert.equal(service.getDiscoveryPhotoURL(photo, 400), url);
    assert.equal(new URL(service.getDiscoveryPhotoURL(photo, 1000)).searchParams.get('maxWidthPx'), '1000');
    assert.equal(searchCalls, before, 'resolving a lazy image URL does not fetch the image');
    assert.equal(photoCalls, 0);
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
    assert.equal(service.getDiscoveryPhotoURL(detail.info.photos[0], 400), 'https://example.com/photo/1?width=400');
    assert.equal(service.getDiscoveryPhotoURL(detail.info.photos[0], 400), 'https://example.com/photo/1?width=400');
    assert.equal(photoCalls, 1, 'SDK detail photos retain their lazy URL cache');
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
  await check('next pages preserve the original query, type and bounds and cache tokens separately', async () => {
    const bounds = { north: 36, south: 34, east: 136, west: 134 };
    const before = searchCalls;
    restHandler = async (_url, _options, body) => ({ ok: true, json: async () => body.pageToken ? { places: [restPlace('second-page')] } : { places: [restPlace('first-page')], nextPageToken: 'opaque-next-page' } });
    try {
      const first = await service.searchDiscoveryPage('espresso', 'Kyoto', 'cafes', bounds);
      assert.equal(first.results[0].place.googlePlaceId, 'first-page');
      assert.equal(first.nextPageToken, 'opaque-next-page');
      const second = await service.searchDiscoveryPage('espresso', 'Kyoto', 'cafes', bounds, first.nextPageToken);
      assert.equal(second.results[0].place.googlePlaceId, 'second-page');
      assert.equal(second.nextPageToken, undefined);
      const bodies = requests.slice(-2).map(request => request.body);
      assert.deepEqual(bodies[1], { ...bodies[0], pageToken: 'opaque-next-page' });
      assert.deepEqual(bodies[0], { textQuery: 'espresso', languageCode: 'en', pageSize: 10, includedType: 'cafe', strictTypeFiltering: true, locationRestriction: { rectangle: { low: { latitude: 34, longitude: 134 }, high: { latitude: 36, longitude: 136 } } } });
      await service.searchDiscoveryPage('espresso', 'Kyoto', 'cafes', bounds, first.nextPageToken);
      await service.searchDiscoveryPage('espresso', 'Kyoto', 'cafes', bounds);
      assert.equal(searchCalls, before + 2);
      assert.equal(detailCalls, 1, 'pagination never fetches each result again for details');
    } finally { restHandler = undefined; }
  });
  await check('page filtering retains continuation even when the current page has no matching results', async () => {
    const bounds = { north: 20, south: -20, west: 170, east: -170 };
    restHandler = async (_url, _options, body) => ({ ok: true, json: async () => body.pageToken ? { places: [restPlace('wrapped-east', { location: { latitude: 0, longitude: 179 } }), restPlace('wrapped-west', { location: { latitude: 0, longitude: -179 } })] } : { places: [restPlace()], nextPageToken: 'wrapped-next' } });
    try {
      const first = await service.searchDiscoveryPage('gardens', 'Kyoto', 'parks', bounds);
      assert.equal(first.results.length, 0);
      assert.equal(first.nextPageToken, 'wrapped-next');
      const second = await service.searchDiscoveryPage('gardens', 'Kyoto', 'parks', bounds, first.nextPageToken);
      assert.deepEqual(second.results.map(result => result.place.googlePlaceId), ['wrapped-east', 'wrapped-west']);
      assert.equal(requests.at(-1).body.locationRestriction.rectangle.low.longitude, 170);
      assert.equal(requests.at(-1).body.locationRestriction.rectangle.high.longitude, -170);
    } finally { restHandler = undefined; }
  });
  await check('indoor filtering uses primary types and deduplicates provider IDs within each page', async () => {
    restHandler = async () => ({ ok: true, json: async () => ({ places: [restPlace('outdoor-museum-cafe', { primaryType: 'park', types: ['park', 'museum', 'cafe'] }), restPlace('indoor-museum', { primaryType: 'museum', types: ['museum', 'cafe'] }), restPlace('indoor-museum', { primaryType: 'museum' }), restPlace('indoor-gallery', { primaryType: 'art_gallery' })], nextPageToken: 'indoor-next' }) });
    try {
      const page = await service.searchDiscoveryPage('', 'Kyoto', 'indoor');
      assert.deepEqual(page.results.map(result => result.place.googlePlaceId), ['indoor-museum', 'indoor-gallery']);
      assert.ok(page.results.every(result => result.place.cat === 'attr'));
      assert.equal(page.nextPageToken, 'indoor-next');
      assert.equal(requests.at(-1).body.includedType, undefined);
    } finally { restHandler = undefined; }
  });
  await check('untrusted REST fields, invalid places and photo resource paths cannot escape normalization', async () => {
    restHandler = async () => ({ ok: true, json: async () => ({ places: [null, { id: 'no-location', displayName: { text: 'Missing' } }, restPlace('invalid-coordinate', { location: { latitude: 95, longitude: 0 } }), restPlace('malformed-meta', {
      rating: '5', userRatingCount: -2, primaryTypeDisplayName: { text: 4 }, utcOffsetMinutes: '540', types: [null, 'museum'], attributions: [null, { provider: 1 }],
      currentOpeningHours: { periods: [{ open: { day: 0 } }], weekdayDescriptions: [2, 'Sunday: Open 24 hours'] },
      photos: [{ name: 'places/ok/photos/../../secret' }, { name: 'https://evil.test/image' }, { name: 'places/ok/photos/image?key=bad' }],
    })], nextPageToken: '\nunsafe' }) });
    try {
      const page = await service.searchDiscoveryPage('malformed', 'Kyoto');
      assert.equal(page.results.length, 1);
      assert.equal(page.results[0].info.rating, undefined);
      assert.equal(page.results[0].info.ratingCount, undefined);
      assert.equal(page.results[0].info.utcOffsetMinutes, undefined);
      assert.deepEqual(page.results[0].info.photos, []);
      assert.deepEqual(page.results[0].info.currentHours.periods, [{ open: { day: 0, hour: 0, minute: 0 } }]);
      assert.equal(page.nextPageToken, undefined);
    } finally { restHandler = undefined; }
  });
  await check('pagination tokens remain ephemeral and repeated tokens stop continuation', async () => {
    const before = searchCalls;
    await assert.rejects(() => service.searchDiscoveryPage('tokens', 'Kyoto', 'all', undefined, '\ninvalid'), /search again/);
    assert.equal(searchCalls, before);
    restHandler = async () => ({ ok: true, json: async () => ({ places: [restPlace('same-token')], nextPageToken: 'same-token' }) });
    try {
      const page = await service.searchDiscoveryPage('tokens', 'Kyoto', 'all', undefined, 'same-token');
      assert.equal(page.nextPageToken, undefined);
      assert.equal(JSON.stringify(page.results).includes('pageToken'), false);
    } finally { restHandler = undefined; }
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
  await check('next-page failures can retry without discarding the cached first page', async () => {
    let fail = true;
    restHandler = async (_url, _options, body) => body.pageToken && fail
      ? { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'sensitive-provider-message' } }) }
      : { ok: true, json: async () => ({ places: [restPlace(body.pageToken ? 'retry-page-two' : 'retry-page-one')], ...(body.pageToken ? {} : { nextPageToken: 'retry-token' }) }) };
    try {
      const first = await service.searchDiscoveryPage('page retry', 'Kyoto');
      await assert.rejects(() => service.searchDiscoveryPage('page retry', 'Kyoto', 'all', undefined, first.nextPageToken), error => /access was denied/.test(error.message) && !/sensitive-provider/.test(error.message));
      fail = false;
      assert.equal((await service.searchDiscoveryPage('page retry', 'Kyoto', 'all', undefined, first.nextPageToken)).results[0].place.googlePlaceId, 'retry-page-two');
      const before = searchCalls;
      assert.equal((await service.searchDiscoveryPage('page retry', 'Kyoto')).results[0].place.googlePlaceId, 'retry-page-one');
      assert.equal(searchCalls, before);
    } finally { restHandler = undefined; }
  });
  await check('a timed-out page aborts the HTTP request and returns a fixed connection message', async () => {
    const realTimeout = globalThis.setTimeout;
    let signal;
    restHandler = async (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new DOMException('private network context', 'AbortError')), { once: true });
    });
    globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 20_000); queueMicrotask(callback); return 0; };
    try {
      await assert.rejects(() => service.searchDiscoveryPage('timeout', 'Kyoto'), error => /Check your connection/.test(error.message) && !/private network/.test(error.message));
      assert.equal(signal.aborted, true);
    } finally { restHandler = undefined; globalThis.setTimeout = realTimeout; }
  });
  await check('expired search and detail caches refresh independently and photo handles expire', async () => {
    const results = await service.searchDiscovery('temple', 'Kyoto', 'all');
    const photo = results[0].info.photos[0];
    const beforeSearch = searchCalls, beforeDetail = detailCalls;
    mockedNow += 6 * 60_000;
    await service.searchDiscovery('temple', 'Kyoto', 'all');
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
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log(`\n${passed} discovery service and opening-hours tests passed.`);
