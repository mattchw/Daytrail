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
const planningURL = dataURL(compile('./hoursPlanning.ts').replace(/from ['\"]\.\/model['\"]/g, `from ${JSON.stringify(modelURL)}`).replace(/from ['\"]\.\/visitHours['\"]/g, `from ${JSON.stringify(visitURL)}`));
const serviceURL = dataURL(compile('./googleMaps.ts').replaceAll('import.meta.env', '({})'));
const service = await import(serviceURL);
const hookURL = dataURL(compile('./useLiveRoutes.ts')
  .replace(/from ['"]react['"]/g, `from ${JSON.stringify(import.meta.resolve('react'))}`)
  .replace(/from ['"]\.\/model['"]/g, `from ${JSON.stringify(modelURL)}`)
  .replace(/from ['"]\.\/visitHours['"]/g, `from ${JSON.stringify(visitURL)}`)
  .replace(/from ['"]\.\/hoursPlanning['"]/g, `from ${JSON.stringify(planningURL)}`).replace(/from ['"]\.\/googleMaps['"]/g, `from ${JSON.stringify(serviceURL)}`));
const { tripDayDate, zonedDeparture, transitDateReason, calculateDayRoutes, pendingLegs, routeInputSignature, reuseReadyStaticLegs, reuseReadyRouteLegs, updateRouteLegs } = await import(hookURL);
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
await check('opening waits are included in the following transit departure', async()=>{
 const planned=input([activity('a'),activity('b',{mode:'transit'})],{hours:{a:{fetchedAt:0,regularHours:{periods:[{open:{day:0,hour:10,minute:0},close:{day:0,hour:17,minute:0}}],weekdayDescriptions:[]}}}});
 const departures=[];
 await calculateDayRoutes(planned,undefined,()=>true,async(from,to,mode,departure)=>{departures.push({to:to.id,departure:departure?.toISOString()});return ready(mode,10);},now);
 assert.equal(departures.find(item=>item.to==='b').departure,'2026-11-01T02:00:00.000Z');
});
await check('unknown opening hours do not invent a delayed transit departure',async()=>{
 const planned=input([activity('a'),activity('b',{mode:'transit'})],{hours:{a:{fetchedAt:0}}});
 const departures=[];
 await calculateDayRoutes(planned,undefined,()=>true,async(from,to,mode,departure)=>{departures.push({to:to.id,departure:departure?.toISOString()});return ready(mode,10);},now);
 assert.equal(departures.find(item=>item.to==='b').departure,'2026-11-01T01:10:00.000Z');
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
await check('alternate departure uses its location and trip-local time while returning to the hotel', async () => {
  const calls = [];
  const plan = input([activity('a', { mode: 'transit', duration: 30 }), activity('b', { mode: 'transit' })]);
  Object.assign(plan.day, { startPlaceId: 'c', startTime: 780, finishBy: 800 });
  plan.day.endMode = 'transit';
  const compute = async (from, to, mode, date) => { calls.push([from.id, to.id, date?.toISOString()]); return ready(mode, 20); };
  await calculateDayRoutes(plan, undefined, undefined, compute, now);
  assert.deepEqual(calls, [
    ['c', 'a', '2026-11-01T04:00:00.000Z'],
    ['a', 'b', '2026-11-01T04:50:00.000Z'],
    ['b', 'hotel', '2026-11-01T06:10:00.000Z'],
  ]);
});
await check('unlocated alternate start blocks only the first static journey, not the located return', async () => {
  const plan = input([activity('a')], { places: { ...places, c: { ...places.c, lat: undefined, lng: undefined } } });
  plan.day.startPlaceId = 'c';
  assert.equal(pendingLegs(plan).a.status, 'unavailable');
  assert.equal(pendingLegs(plan).return.status, 'loading');
  const calls = [];
  const result = await calculateDayRoutes(plan, undefined, undefined, async (from, to, mode) => { calls.push([from.id, to.id]); return ready(mode); }, now);
  assert.deepEqual(calls, [['a', 'hotel']]);
  assert.equal(result.a.min, null);
  assert.equal(result.return.min, 20);
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
await check('a transfer-only day routes from the airport at the selected local departure time', async () => {
  const plan = input([]); Object.assign(plan.day, { startPlaceId: 'c', startTime: 780, endMode: 'transit' });
  assert.equal(pendingLegs(plan).return.status, 'loading');
  const calls = [], updates = [];
  const result = await calculateDayRoutes(plan, id => updates.push(id), undefined,
    async (from, to, mode, departure) => { calls.push([from.id, to.id, mode, departure.toISOString()]); return ready(mode, 55); }, now);
  assert.deepEqual(calls, [['c', 'hotel', 'transit', '2026-11-01T04:00:00.000Z']]);
  assert.deepEqual(updates, ['return']);
  assert.equal(result.return.min, 55);
});
await check('the final airport journey follows completed visits and does not require a hotel location', async () => {
  const plan = input([activity('a', { duration: 30 })], { places: { a: places.a, b: places.b, c: places.c } });
  Object.assign(plan.day, { startPlaceId: 'b', endPlaceId: 'c', startTime: 780, endMode: 'transit' });
  const calls = [];
  await calculateDayRoutes(plan, undefined, undefined, async (from, to, mode, departure) => {
    calls.push([from.id, to.id, departure?.toISOString()]); return ready(mode, 20);
  }, now);
  assert.deepEqual(calls, [['b', 'a', undefined], ['a', 'c', '2026-11-01T04:50:00.000Z']]);
});
await check('an unlocated empty-day destination stays unknown rather than becoming zero travel', async () => {
  const plan = input([], { places: { ...places, c: { ...places.c, lat: undefined } } });
  plan.day.endPlaceId = 'c';
  assert.equal(pendingLegs(plan).return.status, 'unavailable');
  let calls = 0;
  const result = await calculateDayRoutes(plan, undefined, undefined, async () => { calls++; return ready('walk'); }, now);
  assert.equal(calls, 0);
  assert.equal(result.return.min, null);
  assert.match(result.return.reason, /map location/);
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
await check('route signature normalizes legacy defaults, observes departure setup, and ignores finish goals', () => {
  const trip = { id: 't', name: 'Trip', destination: 'Kyoto', startDate: '2026-11-01', timezone: 'Asia/Tokyo', days: [input([activity('a')]).day], ideas: [], customPlaces: {} };
  const original = routeInputSignature(trip, 0, places);
  Object.assign(trip.days[0], { startTime: 540, startPlaceId: 'hotel', finishBy: 1200 });
  assert.equal(routeInputSignature(trip, 0, places), original);
  trip.days[0].startTime = 600;
  assert.notEqual(routeInputSignature(trip, 0, places), original);
  trip.days[0].startTime = 540;
  trip.days[0].startPlaceId = 'c';
  const customStart = routeInputSignature(trip, 0, places);
  assert.notEqual(customStart, original);
  assert.ok(JSON.parse(customStart).places.c);
  assert.notEqual(routeInputSignature(trip, 0, { ...places, c: { ...places.c, lng: 136 } }), customStart);
  trip.days[0].finishBy = 1300;
  assert.equal(routeInputSignature(trip, 0, places), customStart);
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
await check('a changed starting point invalidates the first pair while time edits keep static routes', () => {
  const prior = input([activity('a'), activity('b')]);
  const legs = { a: ready('walk', 48), b: ready('walk', 17), return: ready('walk', 45) };
  const changed = structuredClone(prior);
  Object.assign(changed.day, { startTime: 720, startPlaceId: 'c', finishBy: 800 });
  const reused = reuseReadyStaticLegs(changed, prior, legs);
  assert.equal(reused.a.min, null);
  assert.equal(reused.b.min, 17);
  assert.equal(reused.return.min, 45);
  changed.day.startPlaceId = 'hotel';
  assert.equal(reuseReadyStaticLegs(changed, prior, legs).a.min, 48);
});
await check('changing the final endpoint invalidates only its route and refreshes the route signature', () => {
  const prior = input([activity('a'), activity('b')]);
  const legs = { a: ready('walk', 48), b: ready('walk', 17), return: ready('walk', 45) };
  const changed = structuredClone(prior); changed.day.endPlaceId = 'c';
  const reused = reuseReadyStaticLegs(changed, prior, legs);
  assert.equal(reused.a.min, 48); assert.equal(reused.b.min, 17); assert.equal(reused.return.min, null);
  const trip = { startDate: prior.date, timezone: prior.timezone, days: [prior.day] };
  const original = routeInputSignature(trip, 0, places);
  prior.day.endPlaceId = 'hotel'; assert.equal(routeInputSignature(trip, 0, places), original);
  prior.day.endPlaceId = 'c'; const airport = routeInputSignature(trip, 0, places);
  assert.notEqual(airport, original); assert.ok(JSON.parse(airport).places.c);
  assert.notEqual(routeInputSignature(trip, 0, { ...places, c: { ...places.c, lng: 136 } }), airport);
});
await check('a direct transfer can reuse only the exact same static endpoint pair', () => {
  const prior = input([]); prior.day.endPlaceId = 'c';
  const legs = { return: ready('walk', 45) };
  const changed = structuredClone(prior); changed.day.startTime = 900;
  assert.equal(reuseReadyStaticLegs(changed, prior, legs).return.min, 45);
  changed.day.endPlaceId = 'b'; assert.equal(reuseReadyStaticLegs(changed, prior, legs).return.min, null);
  changed.day.endPlaceId = 'hotel'; assert.equal(reuseReadyStaticLegs(changed, prior, legs).return.min, 0);
});
const transitPlan = () => {
  const plan = input(['a', 'b', 'c'].map(aid => activity(aid, {mode: 'transit'})));
  plan.day.endMode = 'transit';
  return plan;
};
const transitLegs = () => ({a: ready('transit', 21), b: ready('transit', 58), c: ready('transit', 12), return: ready('transit', 18)});
await check('editing a later visit keeps its incoming transit prefix and clears only downstream departures', () => {
  const prior = transitPlan(), changed = structuredClone(prior), legs = transitLegs();
  changed.day.items[1].duration += 15;
  const next = reuseReadyRouteLegs(changed, prior, legs);
  assert.strictEqual(next.a, legs.a); assert.strictEqual(next.b, legs.b);
  assert.equal(next.c.status, 'loading'); assert.equal(next.return.status, 'loading');
});
await check('editing the first or last visit never invalidates its own incoming transit', () => {
  const prior = transitPlan(), legs = transitLegs();
  for (const index of [0, 2]) {
    const changed = structuredClone(prior); changed.day.items[index].duration += 15;
    const next = reuseReadyRouteLegs(changed, prior, legs);
    for (let before = 0; before <= index; before++) assert.strictEqual(next[prior.day.items[before].aid], legs[prior.day.items[before].aid]);
    for (let after = index + 1; after < 3; after++) assert.equal(next[prior.day.items[after].aid].status, 'loading');
    assert.equal(next.return.status, 'loading');
  }
});
await check('fixed time and fixed free-time length edits invalidate outgoing transit, never invent a booking reset', () => {
  for (const patch of [{fixed: 720}, {freeTime: {id: 'free', kind: 'explore', duration: 60, untilBooking: false}}]) {
    const prior = transitPlan(); prior.day.items[2].fixed = 1000;
    const changed = structuredClone(prior); Object.assign(changed.day.items[1], patch);
    const next = reuseReadyRouteLegs(changed, prior, transitLegs());
    assert.equal(next.a.min, 21); assert.equal(next.b.min, 58);
    assert.equal(next.c.status, 'loading'); assert.equal(next.return.status, 'loading');
  }
});
await check('unchanged fixed free time preserves transit but until-booking time bounds the reusable prefix', () => {
  for (const untilBooking of [false, true]) {
    const prior = transitPlan(); prior.day.items[0].freeTime = {id: 'free', kind: 'explore', duration: 60, untilBooking};
    prior.day.items[2].fixed = 1000;
    const changed = structuredClone(prior); changed.day.items[2].fixed += 30;
    const next = reuseReadyRouteLegs(changed, prior, transitLegs());
    assert.equal(next.a.min, 21);
    assert.equal(next.b.status, untilBooking ? 'loading' : 'ready');
    assert.equal(next.c.status, untilBooking ? 'loading' : 'ready');
    assert.equal(next.return.status, 'loading');
  }
});
await check('changing upstream date, zone, day, start clock, start place, hours, or flight timing clears the transit prefix', () => {
  const mutations = [
    plan => { plan.date = '2026-11-02'; }, plan => { plan.timezone = 'UTC'; }, plan => { plan.day.id = 'd2'; },
    plan => { plan.day.startTime = 600; }, plan => { plan.day.startPlaceId = 'c'; },
    plan => { plan.hours = {a: {fetchedAt: 1}}; },
    plan => { plan.flights = [{id: 'arrival', arrival: {date: plan.date, time: '08:00', timezone: plan.timezone}}]; },
    plan => { plan.places.hotel.lat += .01; }, plan => { plan.places.hotel.googlePlaceId = 'new-hotel'; },
  ];
  for (const mutate of mutations) {
    const prior = transitPlan(), changed = structuredClone(prior); mutate(changed);
    const next = reuseReadyRouteLegs(changed, prior, transitLegs());
    assert.ok(Object.values(next).every(leg => leg.status !== 'ready'));
  }
});
await check('reordering, moving, or changing a transit mode invalidates that journey and every downstream transit', () => {
  for (const mutate of [
    plan => { [plan.day.items[1], plan.day.items[2]] = [plan.day.items[2], plan.day.items[1]]; },
    plan => { plan.places.b.lat += .01; }, plan => { plan.places.b.googlePlaceId = 'different-place'; },
    plan => { plan.day.items[1].mode = 'walk'; }, plan => { plan.day.items[1].aid = 'replacement'; },
  ]) {
    const prior = transitPlan(), changed = structuredClone(prior); mutate(changed);
    const next = reuseReadyRouteLegs(changed, prior, transitLegs());
    assert.equal(next.a.min, 21);
    for (const item of changed.day.items.slice(1)) assert.equal(next[item.aid].status, 'loading');
    assert.equal(next.return.status, 'loading');
  }
});
await check('partial, missing, mismatched, and invalid prefix results cannot prove later transit departure times', () => {
  for (const bad of [undefined, {...ready('transit'), status: 'loading'}, {...ready('transit'), status: 'unavailable'},
    ready('walk'), ready('transit', null), ready('transit', NaN), ready('transit', -1)]) {
    const prior = transitPlan(), changed = structuredClone(prior), legs = transitLegs();
    changed.day.items[2].duration += 15; legs.b = bad;
    const next = reuseReadyRouteLegs(changed, prior, legs);
    assert.equal(next.a.min, 21); assert.equal(next.b.status, 'loading');
    assert.equal(next.c.status, 'loading'); assert.equal(next.return.status, 'loading');
  }
});
await check('new and resolved incoming-flight issues never reuse transit from a different departure context', () => {
  for (const priorIssue of [false, true]) {
    const prior = transitPlan(), changed = structuredClone(prior);
    (priorIssue ? prior : changed).incomingFlightIssue = 'Confirm arrival';
    assert.ok(Object.values(reuseReadyRouteLegs(changed, prior, transitLegs())).every(leg => leg.status !== 'ready'));
  }
});
await check('equivalent legacy defaults and notes retain exact transit legs including the return', () => {
  const prior = transitPlan(), changed = structuredClone(prior), legs = transitLegs();
  Object.assign(changed.day, {startTime: 540, startPlaceId: 'hotel', endPlaceId: 'hotel', finishBy: 1300});
  changed.day.items[1].note = 'Bring an umbrella';
  const next = reuseReadyRouteLegs(changed, prior, legs);
  for (const id of ['a', 'b', 'c', 'return']) assert.strictEqual(next[id], legs[id]);
});
await check('removing or adding a last stop preserves only the common prefix and not the return', () => {
  const prior = transitPlan(), changed = structuredClone(prior); changed.day.items.pop();
  let next = reuseReadyRouteLegs(changed, prior, transitLegs());
  assert.equal(next.a.min, 21); assert.equal(next.b.min, 58); assert.equal(next.return.status, 'loading');
  next = reuseReadyRouteLegs(prior, changed, transitLegs());
  assert.equal(next.a.min, 21); assert.equal(next.b.min, 58); assert.equal(next.c.status, 'loading'); assert.equal(next.return.status, 'loading');
});
await check('changing the final destination preserves preceding transit while invalidating its return', () => {
  const prior = transitPlan(), changed = structuredClone(prior); changed.day.endPlaceId = 'a';
  const next = reuseReadyRouteLegs(changed, prior, transitLegs());
  assert.equal(next.a.min, 21); assert.equal(next.b.min, 58); assert.equal(next.c.min, 12); assert.equal(next.return.status, 'loading');
});
await check('direct transit transfer reuse requires identical departure and destination inputs', () => {
  const prior = input([]); Object.assign(prior.day, {startPlaceId: 'c', endMode: 'transit'});
  const changed = structuredClone(prior), legs = {return: ready('transit', 55)};
  assert.strictEqual(reuseReadyRouteLegs(changed, prior, legs).return, legs.return);
  changed.day.startTime = 600; assert.equal(reuseReadyRouteLegs(changed, prior, legs).return.status, 'loading');
  changed.day.startTime = 540; changed.day.endPlaceId = 'a';
  assert.equal(reuseReadyRouteLegs(changed, prior, legs).return.status, 'loading');
});
await check('prefix protection retains independent static routes after an affected transit departure', () => {
  const prior = transitPlan(); prior.day.items[2].mode = 'walk'; prior.day.endMode = 'drive';
  const changed = structuredClone(prior); changed.day.items[0].duration += 15;
  const legs = {...transitLegs(), c: ready('walk', 12), return: ready('drive', 18)};
  const next = reuseReadyRouteLegs(changed, prior, legs);
  assert.equal(next.a.min, 21); assert.equal(next.b.status, 'loading');
  assert.strictEqual(next.c, legs.c); assert.strictEqual(next.return, legs.return);
});
await check('a changed provider travel time invalidates reused downstream transit while keeping static journeys', () => {
  const plan = transitPlan(), legs = transitLegs(); plan.day.items[2].mode = 'walk'; legs.c = ready('walk', 12);
  const next = updateRouteLegs(plan, legs, 'a', ready('transit', 25));
  assert.equal(next.a.min, 25); assert.equal(next.b.status, 'loading');
  assert.strictEqual(next.c, legs.c); assert.equal(next.return.status, 'loading');
  assert.equal(legs.b.min, 58, 'the previous published state is immutable');
});
await check('unchanged provider timing does not discard confirmed downstream transit for distance or path updates', () => {
  const plan = transitPlan(), legs = transitLegs();
  const next = updateRouteLegs(plan, legs, 'a', {...ready('transit', 21), km: '2.1', path: [{lat: 35, lng: 135}]});
  assert.equal(next.a.km, '2.1');
  for (const id of ['b', 'c', 'return']) assert.strictEqual(next[id], legs[id]);
});
await check('a refreshed route failure clears later transit even beyond a fixed booking', () => {
  const plan = transitPlan(), legs = transitLegs(); plan.day.items[1].fixed = 900;
  const next = updateRouteLegs(plan, legs, 'a', service.unavailableJourney('transit', 'No service'));
  assert.equal(next.a.status, 'unavailable');
  for (const id of ['b', 'c', 'return']) assert.equal(next[id].status, 'loading');
});
await check('a changed flight instant invalidates later transit even when its duration is unchanged', () => {
  const plan = transitPlan(), legs = transitLegs(); plan.day.items[0].mode = 'flight';
  legs.a = {...ready('flight', 60), flight: {arrivalReadyMs: 1}};
  const next = updateRouteLegs(plan, legs, 'a', {...ready('flight', 60), flight: {arrivalReadyMs: 60001}});
  for (const id of ['b', 'c', 'return']) assert.equal(next[id].status, 'loading');
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
await check('numeric walking includes only classified transit walking steps and preserves small distances',()=>{
 assert.equal(service.routeWalkingMeters({distanceMeters:49},'walk'),49);assert.equal(service.routeWalkingMeters({distanceMeters:9000},'drive'),0);
 assert.equal(service.routeWalkingMeters({distanceMeters:9000},'transit'),undefined);
 assert.equal(service.routeWalkingMeters({legs:[{steps:[{travelMode:'WALKING',distanceMeters:123},{travelMode:'TRANSIT',distanceMeters:8000},{travelMode:'WALKING',distanceMeters:456}]}]},'transit'),579);
 for(const steps of [[],[{travelMode:'WALKING',distanceMeters:-1}],[{distanceMeters:100}],[{travelMode:'TRANSIT'}]])assert.equal(service.routeWalkingMeters({legs:[{steps}]},'transit'),undefined);
});
console.log(`\n${passed} Google Maps planning tests passed.`);
