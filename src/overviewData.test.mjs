import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const modelURL = dataURL(compile('./model.ts'));
const openingURL = dataURL(compile('./openingHours.ts'));
const visitURL = dataURL(compile('./visitHours.ts').replace(/from ['"]\.\/openingHours['"]/g, `from ${JSON.stringify(openingURL)}`));
const overviewURL = dataURL(compile('./overviewData.ts')
  .replace(/from ['"]\.\/model['"]/g, `from ${JSON.stringify(modelURL)}`)
  .replace(/from ['"]\.\/visitHours['"]/g, `from ${JSON.stringify(visitURL)}`));
const { summarizeOverviewDay, createOverviewTaskPool } = await import(overviewURL);

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`✓ ${name}`); }
const place = (id, x = 0) => ({ id, name: id, cat: 'attr', area: '', typical: '', blurb: '', x, y: x, googlePlaceId: `google-${id}` });
const places = { hotel: place('hotel'), temple: place('temple', 80), museum: place('museum', 10) };
const item = (aid, overrides = {}) => ({ aid, placeId: aid, duration: 60, fixed: null, mode: 'walk', note: '', ...overrides });
const day = overrides => ({ id: 'day1', label: 'Day 1', date: '', title: 'Test', endMode: 'walk', items: [item('temple')], ...overrides });
const ready = (min = 10) => ({ min, km: '1.0', mode: 'walk', status: 'ready' });
const unavailable = { min: null, km: '—', mode: 'walk', status: 'unavailable', reason: 'Choose location' };
const period = (weekday, start, end) => ({ open: { day: weekday, hour: start, minute: 0 }, close: { day: weekday, hour: end, minute: 0 } });
const hours = (overrides = {}) => ({
  fetchedAt: Date.parse('2026-10-26T00:00:00Z'), utcOffsetMinutes: 540,
  currentHours: { periods: [period(1, 9, 17)], weekdayDescriptions: [] },
  regularHours: { periods: [period(1, 9, 17)], weekdayDescriptions: [] }, ...overrides,
});
const data = overrides => ({ legs: { temple: ready(), return: ready() }, routeLoading: false, hoursLoading: false,
  hours: { 'google-temple': hours() }, error: null, ...overrides });
const summary = (plan = day(), info = data(), date = '2026-10-26') => summarizeOverviewDay(plan, date, places, info);

await check('whole-trip timing never falls back to illustrative sample distances', () => {
  const result = summary(day(), data({ legs: {} }));
  assert.equal(result.sc.travel, 0);
  assert.equal(result.sc.unknown, 2);
  assert.equal(result.sc.finishApprox, true);
  assert.equal(result.hoursUnknownCount, 1);
  assert.equal(result.status, 'incomplete');
});
await check('real journeys produce a checked arrival and exact return', () => {
  const result = summary();
  assert.equal(result.sc.travel, 20);
  assert.equal(result.sc.finish, 620);
  assert.equal(result.sc.finishApprox, false);
  assert.equal(result.hoursCheckedCount, 1);
  assert.equal(result.hoursUnknownCount, 0);
  assert.equal(result.status, 'ready');
});
await check('a late booking checks the full feasible visit, never the booked end', () => {
  const result = summary(day({ startTime: 16 * 60 + 20, items: [item('temple', { fixed: 16 * 60 })] }));
  assert.equal(result.sc.late, 30);
  assert.equal(result.sc.rows[0].physicalEnd, 17 * 60 + 30);
  assert.equal(result.visitChecks.temple.status, 'short');
  assert.equal(result.visitChecks.temple.availableMinutes, 30);
  assert.equal(result.visitIssueCount, 1);
});
await check('a missing return journey does not invalidate an earlier known visit', () => {
  const result = summary(day(), data({ legs: { temple: ready(), return: unavailable } }));
  assert.equal(result.sc.finishApprox, true);
  assert.equal(result.hoursCheckedCount, 1);
  assert.equal(result.visitChecks.temple.status, 'fits');
});
await check('uncertain arrival suppresses precise opening-hours conflicts', () => {
  const result = summary(day({ startTime: 16 * 60 + 40 }), data({ legs: { temple: unavailable, return: ready() } }));
  assert.equal(result.hoursUnknownCount, 1);
  assert.equal(result.visitIssueCount, 0);
  assert.equal(result.visitChecks.temple.status, 'unknown');
});
await check('a permanent closure is a real issue even with an unknown journey', () => {
  const result = summary(day(), data({ legs: {}, hours: { 'google-temple': hours({ businessStatus: 'CLOSED_PERMANENTLY' }) } }));
  assert.equal(result.visitIssueCount, 1);
  assert.equal(result.hoursCheckedCount, 1);
  assert.equal(result.visitChecks.temple.status, 'closed');
});
await check('far-future visits explicitly identify provisional regular hours', () => {
  const result = summary(day(), data(), '2027-05-17');
  assert.equal(result.hoursRegularCount, 1);
  assert.equal(result.visitChecks.temple.source, 'regular');
  assert.equal(result.visitChecks.temple.status, 'fits');
});
await check('unlocated or unavailable hours remain unknown after loading completes', () => {
  const result = summary(day(), data({ hours: {}, error: 'Opening hours could not load.' }));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.hoursUnknownCount, 1);
  assert.equal(result.hoursCheckedCount, 0);
  assert.match(result.error, /hours/);
});
await check('empty added days need no travel or opening-hours checks', () => {
  const result = summary(day({ items: [], startTime: 600 }), data({ legs: {}, hours: {} }));
  assert.equal(result.sc.unknown, 0);
  assert.equal(result.sc.travel, 0);
  assert.equal(result.sc.finish, 600);
  assert.equal(result.hoursUnknownCount, 0);
  assert.equal(result.status, 'ready');
});
await check('loading stays visible while routes or opening hours are pending', () => {
  assert.equal(summary(day(), data({ routeLoading: true })).status, 'loading');
  assert.equal(summary(day(), data({ hoursLoading: true })).status, 'loading');
});
await check('trip edits cannot exceed two in-flight day checks and canceled queued days never start', async () => {
  const enqueue = createOverviewTaskPool(2);
  let oldActive = true, running = 0, peak = 0;
  const started = [], releases = [];
  const work = id => async () => {
    started.push(id); running++; peak = Math.max(peak, running);
    await new Promise(resolve => releases.push(resolve));
    running--;
  };
  const prior = [0, 1, 2, 3].map(id => enqueue(work(id), () => oldActive));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  oldActive = false;
  const next = [4, 5].map(id => enqueue(work(id)));
  assert.equal(started.length, 2);
  releases.shift()(); releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 4, 5]);
  releases.shift()(); releases.shift()();
  await Promise.all([...prior, ...next]);
  assert.equal(peak, 2);
});
await check('failed checks release their worker so later days still run', async () => {
  const enqueue = createOverviewTaskPool(1);
  let secondRan = false;
  const failure = enqueue(async () => { throw new Error('Provider failure'); }).catch(error => error.message);
  const next = enqueue(async () => { secondRan = true; });
  assert.equal(await failure, 'Provider failure');
  await next;
  assert.equal(secondRan, true);
});

console.log(`\n${passed} whole-trip overview checks passed.`);
