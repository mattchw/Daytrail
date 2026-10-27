import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
globalThis.crypto ??= webcrypto;
const compile = (path, modules = {}) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match)).toString('base64');
const modelURL = compile('../model.ts'), actionsURL = compile('./actions.ts', {'../model': modelURL});
const journeyURL = compile('./journey.ts', {'../model': modelURL, './actions': actionsURL});
const {createTrip, isTrip} = await import(modelURL);
const {linkFlight} = await import(actionsURL);
const {saveTripFlight, saveTripStay} = await import(journeyURL);
const {listEndpointChoices, applyDayEndpoint} = await import(compile('./endpoints.ts', {'../model': modelURL, './actions': actionsURL, './journey': journeyURL}));
const place = id => ({id, name: id, cat: 'custom', x: 50, y: 50, area: '', typical: '', blurb: ''});
const fixture = (start = '2027-05-14', count = 3) => {
  const trip = createTrip('Holiday', 'Japan', start, count); trip.timezone = 'Asia/Tokyo';
  trip.customPlaces = Object.fromEntries(['lhr', 'kix', 'stayA', 'stayB', 'other'].map(id => [id, place(id)]));
  return trip;
};
const moment = (date, time, timezone = 'Asia/Tokyo') => ({date, time, timezone});
const incoming = (rest = {}) => ({id: 'incoming', fromPlaceId: 'lhr', toPlaceId: 'kix', departure: moment('2027-05-13', '22:00', 'Europe/London'), arrival: moment('2027-05-14', '18:00'), airportBufferMinutes: 120, arrivalBufferMinutes: 60, ...rest});
const outbound = (rest = {}) => incoming({id: 'outbound', fromPlaceId: 'kix', toPlaceId: 'lhr', departure: moment('2027-05-16', '19:00'), arrival: moment('2027-05-16', '23:00', 'Europe/London'), ...rest});
const stay = (rest = {}) => ({id: 'stay-one', placeId: 'stayA', checkInDate: '2027-05-14', checkOutDate: '2027-05-16', timezone: 'Asia/Tokyo', checkInTime: '15:00', checkOutTime: '11:00', ...rest});
const stop = (aid = 'museum', rest = {}) => ({aid, placeId: 'nijo', duration: 90, fixed: null, mode: 'walk', note: 'Keep my reservation.', ...rest});
const chooseFlight = id => ({kind: 'flight', id});
const chooseStay = id => ({kind: 'stay', id});
const choosePlace = placeId => ({kind: 'place', placeId});
let passed = 0;
function check(name, run) {run(); passed++; console.log(`✓ ${name}`);}

check('choice lists use the previous night for starts and the coming night for ends', () => {
  const trip = fixture(); trip.stays = [stay({checkOutDate: '2027-05-15'}), stay({id: 'ryokan', placeId: 'stayB', checkInDate: '2027-05-15'})];
  assert.deepEqual(listEndpointChoices(trip, trip.days[0].id, 'start'), []);
  assert.deepEqual(listEndpointChoices(trip, trip.days[0].id, 'end').map(item => item.id), ['stay-one']);
  assert.deepEqual(listEndpointChoices(trip, trip.days[1].id, 'start').map(item => item.id), ['stay-one']);
  assert.deepEqual(listEndpointChoices(trip, trip.days[1].id, 'end').map(item => item.id), ['ryokan']);
  assert.deepEqual(listEndpointChoices(trip, trip.days[2].id, 'end'), []);
});
check('choice lists show only relevant local flight boundaries and preserve incomplete reasons', () => {
  const trip = fixture(); trip.flights = [incoming(), outbound({arrival: moment('2027-05-16', null, 'Europe/London')})];
  const start = listEndpointChoices(trip, trip.days[0].id, 'start'), end = listEndpointChoices(trip, trip.days[2].id, 'end');
  assert.equal(start[0].choice.id, 'incoming'); assert.equal(start[0].time, 1140); assert.equal(start[0].enabled, true);
  assert.equal(end[0].choice.id, 'outbound'); assert.equal(end[0].disabled, true); assert.match(end[0].issue, /time/i);
  assert.deepEqual(listEndpointChoices(trip, trip.days[1].id, 'start'), []);
});
check('an overnight buffer offers the flight on the ready day, not the landing day', () => {
  const trip = fixture(); trip.flights = [incoming({arrival: moment('2027-05-14', '23:30')})];
  assert.deepEqual(listEndpointChoices(trip, trip.days[0].id, 'start'), []);
  assert.equal(listEndpointChoices(trip, trip.days[1].id, 'start')[0].time, 30);
});
check('a next-date flight is offered on the day of its airport arrival goal', () => {
  const trip = fixture(); trip.flights = [outbound({departure: moment('2027-05-17', '00:30'), arrival: moment('2027-05-17', '04:30', 'Europe/London')})];
  const option = listEndpointChoices(trip, trip.days[2].id, 'end')[0];
  assert.equal(option.time, 1350); assert.equal(option.enabled, true);
});
check('choosing a stay changes only one day and only its chosen endpoint', () => {
  const trip = fixture(); trip.stays = [stay()]; trip.days[1].items = [stop()]; const before = structuredClone(trip);
  applyDayEndpoint(trip, trip.days[1].id, 'start', chooseStay('stay-one'));
  assert.equal(trip.days[1].startPlaceId, 'stayA'); assert.equal(trip.days[1].startStayId, 'stay-one');
  assert.equal(trip.days[1].endPlaceId, before.days[1].endPlaceId); assert.deepEqual(trip.days[1].items, before.days[1].items);
  assert.deepEqual(trip.days[0], before.days[0]); assert.deepEqual(trip.days[2], before.days[2]); assert.deepEqual(trip.stays, before.stays);
});
check('overlapping stays remain explicit selectable choices for a single endpoint', () => {
  const trip = fixture(); trip.stays = [stay(), stay({id: 'ryokan', placeId: 'stayB'})];
  assert.equal(listEndpointChoices(trip, trip.days[1].id, 'end').filter(item => item.enabled).length, 2);
  applyDayEndpoint(trip, trip.days[1].id, 'end', chooseStay('ryokan'));
  assert.equal(trip.days[1].endPlaceId, 'stayB'); assert.equal(trip.days[1].endStayId, 'ryokan'); assert.equal(isTrip(trip), true);
});
check('a stay cannot be applied to the wrong night and failed choices are atomic', () => {
  const trip = fixture(); trip.stays = [stay()]; const before = structuredClone(trip);
  assert.throws(() => applyDayEndpoint(trip, trip.days[0].id, 'start', chooseStay('stay-one')), /previous night/);
  assert.throws(() => applyDayEndpoint(trip, trip.days[2].id, 'end', chooseStay('stay-one')), /this night/);
  assert.deepEqual(trip, before);
});
check('choosing an arrival sets canonical booking time and ignores stale manual input', () => {
  const trip = fixture(); trip.flights = [incoming()]; trip.days[0].items = [stop()]; const before = structuredClone(trip);
  applyDayEndpoint(trip, trip.days[0].id, 'start', chooseFlight('incoming'), {startTime: 600, finishBy: 700, timezone: 'UTC'});
  assert.equal(trip.days[0].startPlaceId, 'kix'); assert.equal(trip.days[0].startTime, 1140); assert.equal(trip.days[0].timezone, 'Asia/Tokyo');
  assert.equal(trip.days[0].finishBy, before.days[0].finishBy); assert.deepEqual(trip.days[0].items, before.days[0].items);
  assert.deepEqual(trip.days.slice(1), before.days.slice(1)); assert.deepEqual(trip.flights, before.flights);
});
check('choosing a departure applies the airport deadline, not a typed finish goal', () => {
  const trip = fixture(); trip.flights = [outbound()];
  applyDayEndpoint(trip, trip.days[2].id, 'end', chooseFlight('outbound'), {finishBy: 1200, startTime: 0});
  assert.equal(trip.days[2].endPlaceId, 'kix'); assert.equal(trip.days[2].finishBy, 1020); assert.equal(trip.days[2].startTime, 540);
});
check('reselecting a flight preserves driving transfers and the opposite endpoint', () => {
  const trip = fixture(); saveTripStay(trip, stay(), {applyToDays: true}); trip.days[0].items = [stop('museum', {mode: 'drive'})];
  saveTripFlight(trip, incoming(), {intent: 'arrival', applyToDay: true, transferMode: 'drive'});
  saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true, transferMode: 'drive'});
  const arrivalEnd = [trip.days[0].endPlaceId, trip.days[0].endStayId, trip.days[0].finishBy];
  const departureStart = [trip.days[2].startPlaceId, trip.days[2].startStayId, trip.days[2].startTime];
  applyDayEndpoint(trip, trip.days[0].id, 'start', chooseFlight('incoming'));
  applyDayEndpoint(trip, trip.days[2].id, 'end', chooseFlight('outbound'));
  assert.equal(trip.days[0].items[0].mode, 'drive'); assert.equal(trip.days[2].endMode, 'drive');
  assert.deepEqual([trip.days[0].endPlaceId, trip.days[0].endStayId, trip.days[0].finishBy], arrivalEnd);
  assert.deepEqual([trip.days[2].startPlaceId, trip.days[2].startStayId, trip.days[2].startTime], departureStart);
});
check('a flight cannot be applied to another day or with incomplete timing', () => {
  const trip = fixture(); trip.flights = [incoming()]; const before = structuredClone(trip);
  assert.throws(() => applyDayEndpoint(trip, trip.days[1].id, 'start', chooseFlight('incoming')), /another day/); assert.deepEqual(trip, before);
  trip.flights[0].arrival.time = null; const incomplete = structuredClone(trip);
  assert.throws(() => applyDayEndpoint(trip, trip.days[0].id, 'start', chooseFlight('incoming')), /time/i); assert.deepEqual(trip, incomplete);
});
check('changing away from a departure airport clears its exact generated goal', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  applyDayEndpoint(trip, trip.days[2].id, 'end', choosePlace('other'));
  assert.equal(trip.days[2].endPlaceId, 'other'); assert.equal(trip.days[2].finishBy, null); assert.equal(trip.flights.length, 1);
});
check('changing an airport endpoint preserves a manually adjusted finish goal', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true}); trip.days[2].finishBy = 1000;
  applyDayEndpoint(trip, trip.days[2].id, 'end', choosePlace('other'));
  assert.equal(trip.days[2].finishBy, 1000);
});
check('an explicitly entered replacement finish goal wins after automatic flight goal removal', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  applyDayEndpoint(trip, trip.days[2].id, 'end', choosePlace('other'), {finishBy: 1100});
  assert.equal(trip.days[2].finishBy, 1100);
});
check('manual start changes preserve its time unless a replacement time is explicitly entered', () => {
  const trip = fixture(); trip.days[1].startTime = 630;
  applyDayEndpoint(trip, trip.days[1].id, 'start', choosePlace('other'));
  assert.equal(trip.days[1].startTime, 630);
  applyDayEndpoint(trip, trip.days[1].id, 'start', choosePlace('stayA'), {startTime: 660, finishBy: 700, timezone: 'Asia/Hong_Kong'});
  assert.equal(trip.days[1].startTime, 660); assert.equal(trip.days[1].finishBy, null); assert.equal(trip.days[1].timezone, 'Asia/Hong_Kong');
});
check('choosing the same property manually detaches only the selected stay association', () => {
  const trip = fixture(); saveTripStay(trip, stay(), {applyToDays: true});
  applyDayEndpoint(trip, trip.days[1].id, 'start', choosePlace('stayA'));
  assert.equal(trip.days[1].startStayId, undefined); assert.equal(trip.days[1].endStayId, 'stay-one');
});
check('legacy flight journeys remain connected when choosing accommodation after landing', () => {
  const trip = fixture('2027-05-13', 4); trip.flights = [incoming()];
  linkFlight(trip, 'incoming', {dayId: trip.days[0].id, targetId: `end:${trip.days[0].id}`});
  applyDayEndpoint(trip, trip.days[0].id, 'end', choosePlace('stayA'));
  assert.equal(trip.days[0].endPlaceId, 'stayA'); assert.equal(trip.days[0].items.length, 1);
  assert.equal(trip.days[0].items[0].flightId, 'incoming'); assert.equal(trip.days[0].items[0].placeId, 'kix'); assert.equal(isTrip(trip), true);
});
check('a legacy linked flight cannot also become a boundary on that same day', () => {
  const trip = fixture(); const sameDay = incoming({departure: moment('2027-05-14', '01:00', 'Europe/London')}); trip.flights = [sameDay];
  linkFlight(trip, 'incoming', {dayId: trip.days[0].id, targetId: `end:${trip.days[0].id}`}); const before = structuredClone(trip);
  const option = listEndpointChoices(trip, trip.days[0].id, 'start')[0]; assert.equal(option.disabled, true); assert.match(option.issue, /linked flight/);
  assert.throws(() => applyDayEndpoint(trip, trip.days[0].id, 'start', chooseFlight('incoming')), /linked flight/); assert.deepEqual(trip, before);
});
check('single-day arrival application does not refresh a different day’s manually edited airport anchor', () => {
  const trip = fixture(); trip.flights = [incoming()]; trip.days[2].items = [stop('airport-anchor', {placeId: 'lhr', departureForFlightId: 'incoming', fixed: 600})];
  const other = structuredClone(trip.days[2]);
  applyDayEndpoint(trip, trip.days[0].id, 'start', chooseFlight('incoming'));
  assert.deepEqual(trip.days[2], other); assert.equal(isTrip(trip), true);
});
check('invalid timing, unknown places and stale booking identities never partially save', () => {
  const trip = fixture(), before = structuredClone(trip);
  for (const action of [() => applyDayEndpoint(trip, trip.days[0].id, 'start', choosePlace('missing')),
    () => applyDayEndpoint(trip, trip.days[0].id, 'end', choosePlace('other'), {finishBy: 500}),
    () => applyDayEndpoint(trip, trip.days[0].id, 'start', choosePlace('other'), {timezone: 'Not/AZone'}),
    () => applyDayEndpoint(trip, trip.days[0].id, 'start', chooseFlight('missing')),
    () => applyDayEndpoint(trip, trip.days[0].id, 'end', chooseStay('missing'))]) {assert.throws(action); assert.deepEqual(trip, before);}
});
console.log(`\n${passed} single-day endpoint checks passed.`);
