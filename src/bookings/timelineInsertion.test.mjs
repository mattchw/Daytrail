import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
globalThis.crypto ??= webcrypto;
const compile = (path, modules = {}) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match)).toString('base64');
const modelURL = compile('../model.ts'), startingURL = compile('./startingFlight.ts', {'../model': modelURL});
const {createTrip, isTrip} = await import(modelURL);
const {prepareStopInsertion} = await import(startingURL);
const {createTimelineInsertion, resolveTimelineInsertion, isTimelineInsertionAllowed} = await import(compile('./timelineInsertion.ts', {'./startingFlight': startingURL}));
const activity = (aid, patch = {}) => ({aid, placeId: 'nijo', mode: 'walk', duration: 60, fixed: null, note: '', ...patch});
const place = id => ({id, name: id, cat: 'custom', x: 50, y: 50, area: '', typical: '', blurb: ''});
const fixture = () => {const trip = createTrip('Trip', 'Dublin', '2027-05-14', 3); trip.days[0].items = ['a', 'b', 'c', 'd'].map(id => activity(id)); return trip;};
const flightFixture = () => {
  const trip = fixture(); trip.customPlaces = {airportA: place('airportA'), airportB: place('airportB')};
  trip.flights = [{id: 'flight', fromPlaceId: 'airportA', toPlaceId: 'airportB', departure: {date: '2027-05-14', time: '10:00', timezone: 'Europe/London'}, arrival: {date: '2027-05-14', time: '11:00', timezone: 'Europe/Dublin'}}];
  const day = trip.days[0]; day.items = []; day.startPlaceId = 'airportA'; day.endPlaceId = 'airportB'; day.endMode = 'flight'; day.endFlightId = 'flight';
  return trip;
};
let passed = 0;
function check(name, run) {run(); passed++; console.log(`✓ ${name}`);}

check('targets record the exact day and adjacent activity identities without mutating the itinerary', () => {
  const trip = fixture(), before = structuredClone(trip), day = trip.days[0], target = createTimelineInsertion(trip, day, 2);
  assert.deepEqual(target, {tripId: trip.id, dayId: day.id, beforeAid: 'b', afterAid: 'c'});
  assert.deepEqual(resolveTimelineInsertion(trip, target), {dayIndex: 0, index: 2}); assert.deepEqual(trip, before);
});
check('unrelated insertion before a saved gap safely shifts its numeric position', () => {
  const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 2);
  day.items.unshift(activity('new-first'));
  assert.deepEqual(resolveTimelineInsertion(trip, target), {dayIndex: 0, index: 3});
});
check('an inserted activity inside the intended gap rejects instead of guessing a new position', () => {
  const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 2);
  day.items.splice(2, 0, activity('collaborator-stop'));
  assert.throws(() => resolveTimelineInsertion(trip, target), /changed/);
});
check('deleting either neighbour makes an insertion target stale', () => {
  for (const removed of ['b', 'c']) {
    const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 2);
    day.items = day.items.filter(item => item.aid !== removed);
    assert.throws(() => resolveTimelineInsertion(trip, target), /changed/);
  }
});
check('start and end gaps retain their boundary anchors when another person adds at that boundary', () => {
  const trip = fixture(), day = trip.days[0], first = createTimelineInsertion(trip, day, 0), last = createTimelineInsertion(trip, day, 4);
  day.items.unshift(activity('new-first')); day.items.push(activity('new-last'));
  assert.throws(() => resolveTimelineInsertion(trip, first), /changed/); assert.throws(() => resolveTimelineInsertion(trip, last), /changed/);
});
check('moving earlier returns the correct index after removing the source activity', () => {
  const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 1);
  assert.deepEqual(resolveTimelineInsertion(trip, target, 'd'), {dayIndex: 0, index: 1});
});
check('moving later subtracts the removed activity from the destination index', () => {
  const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 3);
  const resolved = resolveTimelineInsertion(trip, target, 'a'); assert.equal(resolved.index, 2);
  const moving = day.items.shift(); day.items.splice(resolved.index, 0, moving);
  assert.deepEqual(day.items.map(item => item.aid), ['b', 'c', 'a', 'd']);
});
check('a drop immediately before or after oneself is a stable no-op', () => {
  const trip = fixture(), day = trip.days[0];
  for (const index of [1, 2]) assert.deepEqual(resolveTimelineInsertion(trip, createTimelineInsertion(trip, day, index), 'b'), {dayIndex: 0, index: 1});
  assert.equal(resolveTimelineInsertion(trip, createTimelineInsertion(trip, day, 0), 'a').index, 0);
  assert.equal(resolveTimelineInsertion(trip, createTimelineInsertion(trip, day, 4), 'd').index, 3);
});
check('a self-adjacent target still rejects a collaborator changing that gap', () => {
  const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 1);
  day.items.splice(1, 0, activity('new-gap-stop'));
  assert.throws(() => resolveTimelineInsertion(trip, target, 'b'), /changed/);
});
check('moving from another day keeps the destination gap index and checks the source still exists', () => {
  const trip = fixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 2);
  trip.days[1].items = [activity('travelling-stop')];
  assert.deepEqual(resolveTimelineInsertion(trip, target, 'travelling-stop'), {dayIndex: 0, index: 2});
  trip.days[1].items = []; assert.throws(() => resolveTimelineInsertion(trip, target, 'travelling-stop'), /changed/);
});
check('trip identity, removed days and newly shifted day positions are resolved explicitly', () => {
  const trip = fixture(), target = createTimelineInsertion(trip, trip.days[0], 2);
  assert.throws(() => resolveTimelineInsertion({...trip, id: 'another-trip'}, target), /changed/);
  trip.days.reverse(); assert.deepEqual(resolveTimelineInsertion(trip, target), {dayIndex: 2, index: 2});
  trip.days.pop(); assert.throws(() => resolveTimelineInsertion(trip, target), /changed/);
});
check('empty ordinary-day targets stop being empty when someone adds another activity', () => {
  const trip = fixture(), day = trip.days[1], target = createTimelineInsertion(trip, day, 0);
  assert.deepEqual(resolveTimelineInsertion(trip, target), {dayIndex: 1, index: 0});
  day.items.push(activity('new-stop')); assert.throws(() => resolveTimelineInsertion(trip, target), /changed/);
});
check('no gap can insert a normal stop immediately before a leading or later flight activity', () => {
  const trip = flightFixture(), day = trip.days[0]; prepareStopInsertion(trip, day);
  assert.equal(isTimelineInsertionAllowed(trip, day, 0), false); assert.throws(() => createTimelineInsertion(trip, day, 0), /departure airport/);
  assert.equal(isTimelineInsertionAllowed(trip, day, 1), true);
  day.items.unshift(activity('ground-anchor', {placeId: 'airportA', departureForFlightId: 'flight'}));
  assert.equal(isTimelineInsertionAllowed(trip, day, 0), true); assert.equal(isTimelineInsertionAllowed(trip, day, 1), false);
});
check('a final flight keeps the gap immediately before takeoff protected', () => {
  const trip = flightFixture(), day = trip.days[0]; day.items = [activity('airport', {placeId: 'airportA'})];
  assert.equal(isTimelineInsertionAllowed(trip, day, 0), true); assert.equal(isTimelineInsertionAllowed(trip, day, 1), false);
  assert.throws(() => createTimelineInsertion(trip, day, 1), /departure airport/);
});
check('an empty direct-flight target represents after landing and materializes into a valid stop insertion', () => {
  const trip = flightFixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 0);
  assert.equal(target.directFlightId, 'flight'); assert.deepEqual(resolveTimelineInsertion(trip, target), {dayIndex: 0, index: 0});
  const index = prepareStopInsertion(trip, day, resolveTimelineInsertion(trip, target).index);
  day.items.splice(index, 0, activity('after-landing'));
  assert.equal(day.items[0].flightId, 'flight'); assert.equal(day.items[1].aid, 'after-landing'); assert.equal(isTrip(trip), true);
});
check('changed or materialized direct-flight targets reject instead of shifting behind a new stop', () => {
  const trip = flightFixture(), day = trip.days[0], target = createTimelineInsertion(trip, day, 0);
  prepareStopInsertion(trip, day); day.items.push(activity('new-stop'));
  assert.throws(() => resolveTimelineInsertion(trip, target), /changed/);
  const another = flightFixture(), otherTarget = createTimelineInsertion(another, another.days[0], 0);
  another.days[0].endFlightId = 'missing'; assert.throws(() => resolveTimelineInsertion(another, otherTarget), /changed/);
});
check('the gap after a sole landing visit remains allowed without erasing its duration or note', () => {
  const trip = flightFixture(), day = trip.days[0]; prepareStopInsertion(trip, day);
  day.items[0].duration = 45; day.items[0].note = 'Meet family'; const before = structuredClone(day.items[0]);
  const target = createTimelineInsertion(trip, day, 1); assert.equal(resolveTimelineInsertion(trip, target).index, 1);
  assert.deepEqual(day.items[0], before);
});
check('invalid indices and newly protected gaps are refused', () => {
  const trip = fixture(), day = trip.days[0];
  for (const index of [-1, 1.5, 5, NaN]) assert.equal(isTimelineInsertionAllowed(trip, day, index), false);
  const target = createTimelineInsertion(trip, day, 2); day.items[2].mode = 'flight'; day.items[2].flightId = 'new-flight';
  assert.throws(() => resolveTimelineInsertion(trip, target), /changed/);
});
console.log(`\n${passed} exact timeline insertion checks passed.`);
