import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const modelURL = dataURL(compile('./model.ts'));
const hoursURL = dataURL(compile('./openingHours.ts'));
const visitURL = dataURL(compile('./visitHours.ts').replace(/from ['"]\.\/openingHours['"]/g, `from ${JSON.stringify(hoursURL)}`));
const planningURL = dataURL(compile('./hoursPlanning.ts')
  .replace(/from ['"]\.\/model['"]/g, `from ${JSON.stringify(modelURL)}`)
  .replace(/from ['"]\.\/visitHours['"]/g, `from ${JSON.stringify(visitURL)}`));
const engineURL = dataURL(compile('./improveDay.ts')
  .replace(/from ['"]\.\/model['"]/g, `from ${JSON.stringify(modelURL)}`)
  .replace(/from ['"]\.\/hoursPlanning['"]/g, `from ${JSON.stringify(planningURL)}`)
  .replace(/from ['"]\.\/visitHours['"]/g, `from ${JSON.stringify(visitURL)}`));
const { eligibility, signature, legsForOrder, evaluateOrder, searchOrders, applyOrder } = await import(engineURL);
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }
const leg = (min, mode = 'walk') => ({ min, km: '1.0', mode, status: min === null ? 'unavailable' : 'ready', path: [] });
const place = (id, index = 0) => ({ id, name: id, cat: 'attr', x: 0, y: 0, area: '', typical: '', blurb: '', lat: 35 + index / 100, lng: 135 });
const activity = (id, extra = {}) => ({ aid: id, placeId: id, duration: 10, fixed: null, mode: 'walk', note: '', ...extra });
function fixture(ids = ['a', 'b', 'c']) {
  const places = Object.fromEntries(['hotel', 'start', ...ids].map((id, index) => [id, place(id, index)]));
  return { tripId: 'test', date: '2026-10-26', timezone: 'Asia/Tokyo', day: { id: 'day', label: 'Day 1', date: 'Mon 26', title: '', startTime: 540, endMode: 'walk', items: ids.map(id => activity(id)) }, places, hours: {}, locks: [] };
}
function matrix(input, value = 40) {
  return Object.fromEntries(Object.keys(input.places).map(from => [from, Object.fromEntries(Object.keys(input.places).map(to => [to, leg(from === to ? 0 : value, input.day.endMode)]))]));
}
function edges(data, pairs) { for (const [from, to, minutes] of pairs) data[from][to] = leg(minutes, data[from][to].mode); return data; }
function simple() {
  const input = fixture();
  const data = edges(matrix(input), [['hotel', 'a', 20], ['a', 'b', 20], ['b', 'c', 20], ['c', 'hotel', 20], ['hotel', 'b', 5], ['b', 'a', 5], ['a', 'c', 5]]);
  return { input, data };
}
const point = (day, hour, minute = 0) => ({ day, hour, minute });
const period = (day, start, end, endDay = day) => ({ open: point(day, start), close: point(endDay, end) });
const hours = (periods, extra = {}) => ({ currentHours: { periods, weekdayDescriptions: [] }, regularHours: { periods, weekdayDescriptions: [] }, fetchedAt: Date.parse('2026-10-26T03:00:00Z'), utcOffsetMinutes: 540, ...extra });
const orderedLegs = (items, minutes = 0) => Object.fromEntries([...items.map(item => [item.aid, leg(minutes)]), ['return', leg(minutes)]]);

await check('opening waits count toward later bookings without converting flexible visits into bookings', () => {
  const input=fixture(['a','b']);input.day.items[0].duration=60;input.day.items[1].fixed=630;
  input.hours.a=hours([period(1,10,17)]);
  const evaluation=evaluateOrder(input,input.day.items,orderedLegs(input.day.items));
  assert.equal(evaluation.schedule.rows[0].start,600);
  assert.equal(evaluation.schedule.rows[0].it.fixed,null);
  assert.equal(evaluation.schedule.rows[1].late,30);
  assert.equal(evaluation.feasible,false);
});
await check('a shorter route that misses explicitly confirmed last entry is never suggested', async () => {
  const input=fixture(['a','b']);
  input.hours.a=hours([period(1,9,17)],{lastEntryMinutes:{1:560}});
  const data=edges(matrix(input),[['hotel','a',5],['a','b',90],['b','hotel',5],['hotel','b',5],['b','a',20],['a','hotel',5]]);
  assert.equal(evaluateOrder(input,input.day.items,legsForOrder(input,input.day.items,data)).checks.a.status,'fits');
  assert.deepEqual(await searchOrders(input,data),[]);
});

await check('directed routes choose the real cheaper order without mutating the trip', async () => {
  const { input, data } = simple(), before = JSON.stringify(input);
  const candidates = await searchOrders(input, data);
  assert.deepEqual(candidates[0].order, ['b', 'a', 'c']);
  assert.equal(candidates[0].saving, 45);
  assert.equal(candidates[0].evaluation.schedule.travel, 35);
  assert.equal(candidates[0].legs.a, data.b.a);
  assert.equal(JSON.stringify(input), before);
});
await check('an attached free block follows its stop through comparison and Apply without adding a stop or route', async () => {
  const {input,data}=simple();input.day.items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:false};
  const [candidate]=await searchOrders(input,data);assert.deepEqual(candidate.order,['b','a','c']);assert.equal(candidate.evaluation.schedule.rows.length,3);
  const row=candidate.evaluation.schedule.rows.find(row=>row.it.aid==='a');assert.equal(row.freeTime.duration,60);assert.equal(row.freeTime.start,row.physicalEnd);
  assert.equal(candidate.evaluation.schedule.rows[2].start,row.freeTime.end+data.a.c.min);assert.equal(candidate.evaluation.schedule.travel,35);
  const applied=applyOrder(input.day,candidate.order);assert.equal(applied.items[1].freeTime,input.day.items[0].freeTime);
});
await check('free time remains outside venue hours while protecting downstream bookings', () => {
  const input=fixture(['a','b']);input.day.items[0].duration=30;input.day.items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:false};input.day.items[1].fixed=600;
  input.hours.a=hours([{open:point(1,9),close:point(1,9,30)}]);
  const result=evaluateOrder(input,input.day.items,orderedLegs(input.day.items));assert.equal(result.checks.a.status,'fits');assert.equal(result.schedule.rows[1].late,30);assert.equal(result.feasible,false);
  input.day.items[0].freeTime.untilBooking=true;const buffered=evaluateOrder(input,input.day.items,orderedLegs(input.day.items));assert.equal(buffered.schedule.rows[0].freeTime.duration,30);assert.equal(buffered.schedule.rows[1].late,0);assert.equal(buffered.feasible,true);
});
await check('until-booking allocation cannot replace known visit hours with unknown next-day hours', () => {
  const input=fixture(['a','b','c']);input.day.startTime=1320;input.day.items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:true};input.day.items[2].fixed=2040;
  input.hours.b={fetchedAt:Date.parse('2026-10-20T00:00:00Z'),utcOffsetMinutes:0,currentHours:{periods:[{open:point(0,0)}],weekdayDescriptions:[]}};
  const result=evaluateOrder(input,input.day.items,orderedLegs(input.day.items));assert.equal(result.schedule.rows[0].freeTime.duration,100);assert.equal(result.checks.b.status,'fits');
});
await check('until-booking allocation does not push an already missed admission later', () => {
  const input=fixture(['a','b','c']);input.day.startTime=990;input.day.items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:true};input.day.items[2].fixed=1200;
  input.hours.b=hours([period(1,9,22)],{lastEntryMinutes:{1:990}});
  const result=evaluateOrder(input,input.day.items,orderedLegs(input.day.items));assert.equal(result.schedule.rows[0].freeTime.duration,0);assert.equal(result.schedule.rows[1].start,1000);
});
await check('past lateness at the preceding stop does not erase spare time before a later booking', () => {
  const input=fixture(['a','b']);input.day.items[0].fixed=540;input.day.items[0].duration=60;input.day.items[0].freeTime={id:'free-a',kind:'rest',duration:60,untilBooking:true};input.day.items[1].fixed=720;
  const result=evaluateOrder(input,input.day.items,orderedLegs(input.day.items,15));assert.equal(result.schedule.rows[0].late,15);assert.equal(result.schedule.rows[0].freeTime.duration,90);assert.equal(result.schedule.rows[1].late,0);
});
await check('a distinct departure is used while the return remains the hotel', async () => {
  const { input, data } = simple();
  input.day.startPlaceId = 'start';
  edges(data, [['start', 'a', 20], ['start', 'b', 1], ['start', 'c', 90]]);
  const [candidate] = await searchOrders(input, data);
  assert.deepEqual(candidate.order, ['b', 'a', 'c']);
  assert.equal(candidate.legs.b, data.start.b);
  assert.equal(candidate.legs.return, data.c.hotel);
});
await check('the airport endpoint remains fixed and changes which stop order is worthwhile', async () => {
  const input = fixture(['a', 'b']); input.day.endPlaceId = 'start';
  const data = edges(matrix(input, 10), [['b', 'start', 30], ['a', 'start', 5], ['a', 'hotel', 100]]);
  const [candidate] = await searchOrders(input, data);
  assert.deepEqual(candidate.order, ['b', 'a']);
  assert.equal(candidate.legs.return, data.a.start);
  assert.equal(candidate.saving, 25);
  assert.equal(applyOrder(input.day, candidate.order).endPlaceId, 'start');
  const baseline = legsForOrder(input, input.day.items, data);
  assert.equal(baseline.return, data.b.start);
});
await check('comparison validates selected endpoints instead of an unused hotel', () => {
  const input = fixture(); Object.assign(input.day, { startPlaceId: 'start', endPlaceId: 'a' });
  delete input.places.hotel;
  assert.equal(eligibility(input).ok, true);
  input.places.a.lat = undefined;
  assert.equal(eligibility(input).action, 'locations');
});
await check('fixed anchors retain position and time while both flexible segments can improve', async () => {
  const input = fixture(['a', 'b', 'x', 'c', 'd']);
  input.day.items[2].fixed = 1_000;
  const data = edges(matrix(input, 30), [['hotel', 'b', 1], ['b', 'a', 1], ['a', 'x', 1], ['x', 'd', 1], ['d', 'c', 1], ['c', 'hotel', 1]]);
  const [candidate] = await searchOrders(input, data);
  assert.deepEqual(candidate.order, ['b', 'a', 'x', 'd', 'c']);
  assert.equal(candidate.evaluation.schedule.rows[2].start, 1_000);
  assert.equal(candidate.evaluation.schedule.rows[2].it, input.day.items[2]);
});
await check('comparison-only locks are uncrossable anchors without creating a booking', async () => {
  const input = fixture(['a', 'b', 'x', 'c', 'd']);
  input.locks = ['x'];
  const data = edges(matrix(input, 30), [['hotel', 'b', 1], ['b', 'a', 1], ['a', 'x', 1], ['x', 'd', 1], ['d', 'c', 1], ['c', 'hotel', 1]]);
  const [candidate] = await searchOrders(input, data);
  assert.deepEqual(candidate.order, ['b', 'a', 'x', 'd', 'c']);
  assert.equal(candidate.evaluation.schedule.rows[2].it.fixed, null);
});
await check('no adjacent movable pair explains the anchor restriction', () => {
  const input = fixture(); input.day.items[1].fixed = 900;
  assert.equal(eligibility(input).ok, false);
  assert.match(eligibility(input).reason, /anchors/);
  input.day.items[1].fixed = null; input.locks = ['b'];
  assert.equal(eligibility(input).ok, false);
});
await check('walking or driving must be consistent including the final journey', () => {
  const input = fixture(); assert.equal(eligibility(input).ok, true);
  input.day.items[0].mode = 'drive'; assert.equal(eligibility(input).action, 'modes');
  input.day.items.forEach(item => { item.mode = 'drive'; });
  assert.equal(eligibility(input).ok, false);
  input.day.endMode = 'drive'; assert.equal(eligibility(input).ok, true);
  input.day.items.forEach(item => { item.mode = 'transit'; }); input.day.endMode = 'transit';
  assert.equal(eligibility(input).ok, false);
});
await check('the total stop cap includes booked and locked stops', () => {
  const input = fixture(Array.from({ length: 9 }, (_, i) => `a${i}`));
  input.day.items[8].fixed = 1_000; input.locks = ['a7'];
  assert.match(eligibility(input).reason, /up to 8/);
  input.day.items.pop(); assert.equal(eligibility(input).ok, true);
  input.day.items = input.day.items.slice(0, 1); assert.equal(eligibility(input).ok, false);
});
await check('missing mapped places and invalid planning times are actionable', () => {
  const input = fixture(); delete input.places.a.lat;
  assert.equal(eligibility(input).action, 'locations');
  input.places.a.lat = 35; input.day.startTime = NaN;
  assert.equal(eligibility(input).action, 'day-plan');
  input.day.startTime = 540; input.date = '2026-02-30';
  assert.equal(eligibility(input).ok, false);
});
await check('unused unavailable matrix edges do not prevent a complete suggestion', async () => {
  const { input, data } = simple(); data.c.a = leg(null); data.hotel.c = leg(null);
  const [candidate] = await searchOrders(input, data);
  assert.deepEqual(candidate.order, ['b', 'a', 'c']);
});
await check('an unavailable baseline leg cannot establish a saving', async () => {
  const { input, data } = simple(); data.a.b = leg(null);
  await assert.rejects(searchOrders(input, data), /current day is unavailable/);
  data.a.b = { ...leg(20), status: 'loading' };
  await assert.rejects(searchOrders(input, data), /current day is unavailable/);
});
await check('unknown hours remain explicit and do not falsely block a complete route', async () => {
  const { input, data } = simple();
  const [candidate] = await searchOrders(input, data);
  assert.equal(candidate.evaluation.unknownHours, 3);
  assert.equal(candidate.evaluation.feasible, true);
  assert.equal(candidate.evaluation.checks.a.status, 'unknown');
});
await check('known closed places block all proposals', async () => {
  const { input, data } = simple(); input.hours.a = hours([], { businessStatus: 'CLOSED_PERMANENTLY' });
  assert.deepEqual(await searchOrders(input, data), []);
});
await check('exact booking arrival and departure at closing are feasible', () => {
  const input = fixture(['a', 'b']); input.day.items[0] = activity('a', { fixed: 540, duration: 60 });
  input.hours.a = hours([period(1, 9, 10)]);
  const result = evaluateOrder(input, input.day.items, orderedLegs(input.day.items));
  assert.equal(result.schedule.rows[0].arrive, 540);
  assert.equal(result.schedule.rows[0].late, 0);
  assert.equal(result.checks.a.status, 'fits');
  assert.equal(result.feasible, true);
  input.day.items[0].duration = 61;
  assert.equal(evaluateOrder(input, input.day.items, orderedLegs(input.day.items)).checks.a.status, 'short');
});
await check('split opening hours and overnight visits use the established hours checker', () => {
  const input = fixture(['a', 'b']); input.day.startTime = 660; input.day.items[0].duration = 180;
  input.hours.a = hours([period(1, 9, 12), period(1, 14, 18)]);
  assert.equal(evaluateOrder(input, input.day.items, orderedLegs(input.day.items)).checks.a.status, 'short');
  input.day.startTime = 1_380; input.day.items[0].duration = 120;
  input.hours.a = hours([period(1, 22, 2, 2)]);
  assert.equal(evaluateOrder(input, input.day.items, orderedLegs(input.day.items)).checks.a.status, 'fits');
});
await check('future regular opening hours remain provisional', async () => {
  const { input, data } = simple(); input.date = '2026-11-02';
  for (const id of ['a', 'b', 'c']) input.hours[id] = hours([period(1, 9, 18)]);
  const [candidate] = await searchOrders(input, data);
  assert.equal(candidate.evaluation.regularHours, 3);
  assert.equal(candidate.evaluation.checks.a.label, 'Fits regular hours');
});
await check('an already late baseline can be improved only to zero late bookings', async () => {
  const input = fixture(['a', 'b', 'x']); input.day.items[2].fixed = 600;
  const data = edges(matrix(input, 20), [['hotel', 'b', 5], ['b', 'a', 5], ['a', 'x', 5]]);
  assert.equal(evaluateOrder(input, input.day.items, legsForOrder(input, input.day.items, data)).schedule.late, 20);
  const [candidate] = await searchOrders(input, data);
  assert.equal(candidate.evaluation.schedule.late, 0);
  input.day.items[2].fixed = 560;
  assert.deepEqual(await searchOrders(input, data), []);
});
await check('less travel cannot make the day finish later after a fixed booking', async () => {
  const input = fixture(['a', 'b', 'x', 'c', 'd']); input.day.items[2].fixed = 1_000;
  const data = edges(matrix(input, 30), [['x', 'c', 5], ['c', 'd', 5], ['d', 'hotel', 5], ['hotel', 'b', 1], ['b', 'a', 1], ['a', 'x', 1], ['x', 'd', 20], ['d', 'c', 20], ['c', 'hotel', 20]]);
  const candidates = await searchOrders(input, data);
  assert.ok(candidates.length);
  assert.equal(candidates.some(item => item.order.join() === 'b,a,x,d,c'), false);
  assert.equal(candidates[0].order.join(), 'b,a,x,c,d');
});
await check('a shorter route that still misses the finish deadline is not proposed', async () => {
  const { input, data } = simple(); input.day.finishBy = 604;
  const baseline = evaluateOrder(input, input.day.items, legsForOrder(input, input.day.items, data));
  const fasterOrder = [input.day.items[1], input.day.items[0], input.day.items[2]];
  const faster = evaluateOrder(input, fasterOrder, legsForOrder(input, fasterOrder, data));
  assert.equal(baseline.schedule.finish, 650);
  assert.equal(baseline.feasible, false);
  assert.equal(faster.schedule.finish, 605);
  assert.equal(faster.conflicts, 1);
  assert.equal(faster.feasible, false);
  assert.deepEqual(await searchOrders(input, data), []);
});
await check('an already late day can be improved to reach its endpoint exactly at the deadline', async () => {
  const { input, data } = simple(); input.day.finishBy = 605;
  const baseline = evaluateOrder(input, input.day.items, legsForOrder(input, input.day.items, data));
  assert.equal(baseline.feasible, false);
  const [candidate] = await searchOrders(input, data);
  assert.deepEqual(candidate.order, ['b', 'a', 'c']);
  assert.equal(candidate.evaluation.schedule.finish, input.day.finishBy);
  assert.equal(candidate.evaluation.conflicts, 0);
  assert.equal(candidate.evaluation.feasible, true);
});
await check('the final transfer is included when deciding whether the deadline is met', async () => {
  const { input, data } = simple(); input.day.finishBy = 590;
  const fasterOrder = [input.day.items[1], input.day.items[0], input.day.items[2]];
  const evaluation = evaluateOrder(input, fasterOrder, legsForOrder(input, fasterOrder, data));
  assert.ok(evaluation.schedule.rows.at(-1).physicalEnd < input.day.finishBy);
  assert.ok(evaluation.schedule.finish > input.day.finishBy);
  assert.equal(evaluation.feasible, false);
  assert.deepEqual(await searchOrders(input, data), []);
});
await check('an unknown final transfer cannot establish that a day meets its deadline', async () => {
  const { input, data } = simple(); input.day.finishBy = 620;
  const fasterOrder = [input.day.items[1], input.day.items[0], input.day.items[2]];
  const legs = legsForOrder(input, fasterOrder, data); legs.return = leg(null);
  const evaluation = evaluateOrder(input, fasterOrder, legs);
  assert.ok(evaluation.schedule.finish < input.day.finishBy);
  assert.equal(evaluation.schedule.finishApprox, true);
  assert.equal(evaluation.feasible, false);
  data.c.hotel = leg(null);
  await assert.rejects(searchOrders(input, data), /current day is unavailable/);
});
await check('a smaller than five minute saving does not produce an Apply candidate', async () => {
  const input = fixture(['a', 'b']);
  const data = edges(matrix(input, 10), [['hotel', 'b', 9], ['b', 'a', 9], ['a', 'hotel', 8]]);
  assert.deepEqual(await searchOrders(input, data), []);
  data.a.hotel = leg(7);
  assert.equal((await searchOrders(input, data))[0].saving, 5);
});
await check('repeated place visits still remain distinct activity identities', async () => {
  const { input, data } = simple(); input.day.items.push(activity('a-again', { placeId: 'a' }));
  data.c.a = leg(5); data.a.hotel = leg(5);
  const candidates = await searchOrders(input, data);
  assert.ok(candidates.length);
  for (const candidate of candidates) assert.deepEqual([...candidate.order].sort(), ['a', 'a-again', 'b', 'c']);
  input.places.b.lat = input.places.a.lat; input.places.b.lng = input.places.a.lng;
  assert.equal(eligibility(input).ok, true);
});
await check('equivalent travel and finish favour fewer moved stops', async () => {
  const input = fixture(['a', 'b', 'c', 'd']);
  const data = matrix(input, 10);
  edges(data, [['hotel', 'a', 20], ['a', 'b', 20], ['b', 'c', 20], ['c', 'd', 20], ['d', 'hotel', 20]]);
  const candidates = await searchOrders(input, data);
  assert.ok(candidates.length <= 3);
  for (let i = 1; i < candidates.length; i++) {
    const left = candidates[i - 1], right = candidates[i];
    assert.ok(left.evaluation.schedule.travel <= right.evaluation.schedule.travel);
    if (left.evaluation.schedule.travel === right.evaluation.schedule.travel && left.evaluation.schedule.finish === right.evaluation.schedule.finish) assert.ok(left.moved <= right.moved);
  }
});
await check('the signature covers planning, routing, hours and locks while ignoring notes and labels', () => {
  const { input } = simple(); const original = signature(input);
  input.day.items[0].note = 'Updated while reviewing'; input.places.a.name = 'A new label'; input.day.title = 'Edited title';
  assert.equal(signature(input), original);
  const mutations = [i => { i.day.items.reverse(); }, i => { i.day.items[0].duration++; }, i => { i.day.items[0].fixed = 600; }, i => { i.day.endMode = 'drive'; }, i => { i.day.startTime++; }, i => { i.day.finishBy = 900; }, i => { i.day.startPlaceId = 'start'; }, i => { i.day.endPlaceId = 'start'; }, i => { i.places.hotel.lat++; }, i => { i.places.a.googlePlaceId = 'new'; }, i => { i.date = '2026-10-27'; }, i => { i.timezone = 'UTC'; }, i => { i.hours.a = hours([period(1, 9, 17)]); }, i => { i.locks = ['a']; }];
  for (const mutate of mutations) { const changed = structuredClone(input); mutate(changed); assert.notEqual(signature(changed), original); }
  input.locks = ['a', 'b']; const locksSignature = signature(input); input.locks = ['b', 'a', 'a']; assert.equal(signature(input), locksSignature);
});
await check('Apply resolves current objects, preserves note edits and refuses stale membership', () => {
  const { input } = simple(); input.day.items[0].note = 'Keep my updated note';
  const reordered = applyOrder(input.day, ['b', 'a', 'c']);
  assert.equal(reordered.items[1], input.day.items[0]);
  assert.equal(reordered.items[1].note, 'Keep my updated note');
  assert.equal(input.day.items[0].aid, 'a');
  assert.throws(() => applyOrder(input.day, ['b', 'b', 'c']), /day changed/);
  assert.throws(() => applyOrder(input.day, ['b', 'a']), /day changed/);
  assert.throws(() => applyOrder(input.day, ['b', 'a', 'missing']), /day changed/);
  input.day.items[0].fixed = 600;
  assert.throws(() => applyOrder(input.day, ['b', 'a', 'c']), /booking cannot change position/);
});
await check('free time settings participate in comparison signatures', () => {
  const {input}=simple(),before=signature(input);input.day.items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:false};const withFree=signature(input);assert.notEqual(withFree,before);
  for(const [key,value] of [['id','free-b'],['kind','rest'],['duration',75],['untilBooking',true]]){const changed=structuredClone(input);changed.day.items[0].freeTime[key]=value;assert.notEqual(signature(changed),withFree);}
});
await check('eight-stop enumeration yields so cancellation stops work before a result', async () => {
  const input = fixture(Array.from({ length: 8 }, (_, index) => `a${index}`));
  let current = true, yielded = false;
  setTimeout(() => { yielded = true; current = false; }, 0);
  await assert.rejects(searchOrders(input, matrix(input), () => current), error => error.name === 'AbortError');
  assert.equal(yielded, true);
  await assert.rejects(searchOrders(input, matrix(input), () => false), error => error.name === 'AbortError');
});
await check('a complete eight-stop run remains bounded and returns at most three candidates', async () => {
  const input = fixture(Array.from({ length: 8 }, (_, index) => `a${index}`));
  const data = matrix(input, 1); data.hotel.a0 = leg(10);
  const candidates = await searchOrders(input, data);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].saving, 9);
  assert.equal(candidates[0].moved, 2);
});

console.log(`\n${passed} improve-day checks passed.`);
