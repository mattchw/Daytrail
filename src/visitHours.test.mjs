import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hoursURL = dataURL(compile('./openingHours.ts'));
const visitURL = dataURL(compile('./visitHours.ts').replace(/from ['"]\.\/openingHours['"]/g, `from ${JSON.stringify(hoursURL)}`));
const { checkVisitHours } = await import(visitURL);
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }
const point = (day, hour, minute = 0) => ({ day, hour, minute });
const schedule = periods => ({ periods, weekdayDescriptions: [] });
const period = (day, start, end, closeDay = day) => ({ open: point(day, start), close: point(closeDay, end) });
const monday = schedule([period(1, 9, 17)]);
const info = overrides => ({ currentHours: monday, regularHours: monday, utcOffsetMinutes: 540, fetchedAt: Date.parse('2026-10-26T03:00:00Z'), ...overrides });
const visit = (start, end, overrides) => ({ date: '2026-10-26', start, end, ...overrides });

await check('the full physical visit must fit, with departure at closing allowed', () => {
  assert.equal(checkVisitHours(info(), visit(16 * 60, 17 * 60)).status, 'fits');
  const short = checkVisitHours(info(), visit(16 * 60 + 40, 17 * 60 + 40));
  assert.equal(short.status, 'short');
  assert.equal(short.availableMinutes, 20);
  assert.equal(short.suggestedStart, 16 * 60);
  assert.equal(checkVisitHours(info(), visit(17 * 60, 18 * 60)).status, 'closed');
});
await check('split opening periods cannot be added together to fit a single visit', () => {
  const split = schedule([period(1, 9, 12), period(1, 14, 17)]);
  assert.equal(checkVisitHours(info({ currentHours: split }), visit(11 * 60, 15 * 60)).status, 'short');
  assert.equal(checkVisitHours(info({ currentHours: split }), visit(11 * 60, 15 * 60)).suggestedStart, undefined);
  assert.equal(checkVisitHours(info({ currentHours: split }), visit(13 * 60, 14 * 60)).status, 'fits');
  assert.equal(checkVisitHours(info({ currentHours: split }), visit(13 * 60, 14 * 60)).waitMinutes, 60);
});
await check('adjacent or overlapping periods merge without false conflicts', () => {
  const adjacent = schedule([period(1, 9, 12), period(1, 12, 17), period(1, 13, 18)]);
  assert.equal(checkVisitHours(info({ currentHours: adjacent }), visit(11 * 60, 18 * 60)).status, 'fits');
});
await check('overnight and week-boundary visits use the real following calendar day', () => {
  const overnight = schedule([period(6, 22, 2, 0)]);
  const saturday = info({ currentHours: overnight, regularHours: overnight, fetchedAt: Date.parse('2026-10-31T00:00:00Z') });
  assert.equal(checkVisitHours(saturday, visit(23 * 60, 25 * 60, { date: '2026-10-31' })).status, 'fits');
  assert.equal(checkVisitHours(saturday, visit(25 * 60, 26 * 60, { date: '2026-10-31' })).status, 'fits');
  assert.equal(checkVisitHours(saturday, visit(25 * 60, 27 * 60, { date: '2026-10-31' })).availableMinutes, 60);
  assert.equal(checkVisitHours(saturday, visit(25 * 60, 27 * 60, { date: '2026-10-31' })).suggestedStart, 24 * 60);
});
await check('explicit 24-hour opening fits overnight while incomplete data stays unknown', () => {
  const allDay = schedule([{ open: point(0, 0) }]);
  assert.equal(checkVisitHours(info({ currentHours: allDay }), visit(23 * 60, 25 * 60)).status, 'fits');
  assert.equal(checkVisitHours(info({ currentHours: schedule([{ open: point(1, 0) }]) }), visit(9 * 60, 10 * 60)).status, 'unknown');
});
await check('future regular hours remain visibly provisional for fits and conflicts', () => {
  const fit = checkVisitHours(info(), visit(10 * 60, 11 * 60, { date: '2026-11-02' }));
  assert.equal(fit.source, 'regular');
  assert.equal(fit.label, 'Fits regular hours');
  assert.match(fit.detail, /holiday hours may differ/);
  const closed = checkVisitHours(info(), visit(18 * 60, 19 * 60, { date: '2026-11-02' }));
  assert.match(closed.label, /Usually/);
  assert.equal(checkVisitHours(info({ regularHours: undefined }), visit(10 * 60, 11 * 60, { date: '2026-11-02' })).status, 'unknown');
});
await check('crossing the current-data window requires following-day regular hours', () => {
  const allDay = schedule([{ open: point(0, 0) }]);
  const boundary = visit(23 * 60, 25 * 60, { date: '2026-11-01' });
  assert.equal(checkVisitHours(info({ currentHours: allDay, regularHours: undefined }), boundary).status, 'unknown');
  const result = checkVisitHours(info({ currentHours: allDay, regularHours: allDay }), boundary);
  assert.equal(result.status, 'fits');
  assert.equal(result.source, 'regular');
});
await check('uncertain routes never create precise arrival conflicts or fit promises', () => {
  for (const start of [10 * 60, 16 * 60 + 40, 18 * 60]) {
    const result = checkVisitHours(info(), visit(start, start + 60, { approx: true }));
    assert.equal(result.status, 'unknown');
    assert.equal(result.suggestedStart, undefined);
    assert.match(result.detail, /journey time is missing/);
  }
  const closedDay = checkVisitHours(info(), visit(10 * 60, 11 * 60, { date: '2026-10-27', approx: true }));
  assert.equal(closedDay.status, 'closed');
  assert.match(closedDay.label, /Tuesday/);
});
await check('missing, empty, malformed or invalid-date hours do not invent closures', () => {
  assert.equal(checkVisitHours(undefined, visit(9 * 60, 10 * 60)).status, 'unknown');
  assert.equal(checkVisitHours(info({ currentHours: schedule([]) }), visit(9 * 60, 10 * 60)).status, 'unknown');
  assert.equal(checkVisitHours(info({ currentHours: schedule([period(8, 9, 17)]) }), visit(9 * 60, 10 * 60)).status, 'unknown');
  assert.equal(checkVisitHours(info(), visit(9 * 60, 10 * 60, { date: '2026-02-30' })).status, 'unknown');
  assert.equal(checkVisitHours(info(), visit(NaN, 600)).status, 'unknown');
  assert.equal(checkVisitHours(info(), visit(600, 600)).status, 'unknown');
});
await check('a missing offset cannot select current hours but explicit dates can use regular hours', () => {
  const regular = checkVisitHours(info({ utcOffsetMinutes: undefined }), visit(10 * 60, 11 * 60));
  assert.equal(regular.status, 'fits');
  assert.equal(regular.source, 'regular');
  assert.equal(checkVisitHours(info({ utcOffsetMinutes: undefined, regularHours: undefined }), visit(10 * 60, 11 * 60)).status, 'unknown');
});
await check('business closure overrides fitting schedules even if routing is unknown', () => {
  const result = checkVisitHours(info({ businessStatus: 'CLOSED_PERMANENTLY' }), visit(10 * 60, 11 * 60, { approx: true }));
  assert.equal(result.status, 'closed');
  assert.equal(result.label, 'Permanently closed');
  assert.match(checkVisitHours(info({ businessStatus: 'CLOSED_TEMPORARILY' }), visit(10 * 60, 11 * 60)).detail, /reopen for your trip/);
});

const mapsURL = dataURL(compile('./googleMaps.ts').replaceAll('import.meta.env', '({VITE_GOOGLE_MAPS_API_KEY:"unit-test-key"})'));
const discoveryURL = dataURL(compile('./discoveryData.ts')
  .replace(/from ['"]\.\/googleMaps['"]/g, `from ${JSON.stringify(mapsURL)}`)
  .replace(/from ['"]\.\/openingHours['"]/g, `from ${JSON.stringify(hoursURL)}`));
const { fetchVisitOpeningInfo, fetchDiscoveryDetails } = await import(discoveryURL);
let requests = [], rejectRequest = false;
let releasePending;
class FakePlace {
  constructor({ id }) { Object.assign(this, { id, displayName: 'Temple', formattedAddress: 'Kyoto', location: { lat: () => 35, lng: () => 135 }, currentOpeningHours: monday, regularOpeningHours: monday, businessStatus: 'OPERATIONAL', utcOffsetMinutes: 540 }); }
  async fetchFields(request) {
    requests.push(request);
    if (rejectRequest) throw { code: 'NOT_FOUND', message: 'provider-credentials-never-display' };
    if (this.id === 'pending-hours') await new Promise(resolve => { releasePending = resolve; });
  }
}
const originalWindow = globalThis.window;
globalThis.window = { google: { maps: { importLibrary: async () => ({ Place: FakePlace }) } } };
try {
  await check('itinerary hours use a minimal field mask and cache successful results', async () => {
    const value = await fetchVisitOpeningInfo('only-hours');
    assert.deepEqual(value.currentHours, monday);
    assert.equal('photos' in value, false);
    assert.equal('rating' in value, false);
    assert.deepEqual(requests.at(-1).fields.sort(), ['businessStatus', 'utcOffsetMinutes', 'currentOpeningHours', 'regularOpeningHours'].sort());
    const before = requests.length;
    await fetchVisitOpeningInfo('only-hours');
    assert.equal(requests.length, before);
  });
  await check('fresh discovery details satisfy itinerary hours without another request', async () => {
    await fetchDiscoveryDetails('already-discovered');
    const before = requests.length;
    const value = await fetchVisitOpeningInfo('already-discovered');
    assert.deepEqual(value.regularHours, monday);
    assert.equal(requests.length, before);
  });
  await check('concurrent hours requests share a single in-flight operation', async () => {
    const first = fetchVisitOpeningInfo('pending-hours'), second = fetchVisitOpeningInfo('pending-hours');
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    releasePending();
    assert.equal(await first, await second);
  });
  await check('hours failures can retry and never reveal raw provider messages', async () => {
    rejectRequest = true;
    await assert.rejects(() => fetchVisitOpeningInfo('retry-hours'), error => /could not be found/.test(error.message) && !/provider-credentials/.test(error.message));
    rejectRequest = false;
    assert.equal((await fetchVisitOpeningInfo('retry-hours')).businessStatus, 'OPERATIONAL');
    const before = requests.length;
    await assert.rejects(() => fetchVisitOpeningInfo('bad id'), /invalid Google Maps ID/);
    assert.equal(requests.length, before);
  });
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log(`\n${passed} visit-hours checks passed.`);
