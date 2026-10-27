import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
globalThis.crypto ??= webcrypto;
const compile = (path, modules = {}) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match)).toString('base64');
const modelURL = compile('../model.ts');
const {createTrip, isTrip} = await import(modelURL);
const {getStartingFlight, prepareStopInsertion} = await import(compile('./startingFlight.ts', {'../model': modelURL}));
const place = id => ({id, name: id, cat: 'custom', x: 50, y: 50, area: '', typical: '', blurb: ''});
const fixture = () => {
  const trip = createTrip('Flight holiday', 'Dublin', '2027-05-14', 2);
  trip.customPlaces = {airportA: place('airportA'), airportB: place('airportB')};
  trip.flights = [{id: 'flight-one', fromPlaceId: 'airportA', toPlaceId: 'airportB', departure: {date: '2027-05-14', time: '10:00', timezone: 'Europe/London'}, arrival: {date: '2027-05-14', time: '11:00', timezone: 'Europe/Dublin'}}];
  trip.days[0].startPlaceId = 'airportA'; trip.days[0].endPlaceId = 'airportB';
  trip.days[0].endMode = 'flight'; trip.days[0].endFlightId = 'flight-one';
  return trip;
};
const arrival = (patch = {}) => ({aid: 'arrival', placeId: 'airportB', mode: 'flight', flightId: 'flight-one', duration: 0, fixed: null, note: '', ...patch});
const stop = {aid: 'visit', placeId: 'nijo', mode: 'walk', duration: 60, fixed: null, note: ''};
const activityTrip = (items = [arrival()]) => {const trip = fixture(); trip.days[0].items = items; trip.days[0].endMode = 'drive'; delete trip.days[0].endFlightId; return trip;};
let passed = 0;
function check(name, run) {run(); passed++; console.log(`✓ ${name}`);}
check('an empty direct flight day groups its real final flight journey', () => {
  const trip = fixture(), before = structuredClone(trip), result = getStartingFlight(trip, trip.days[0]);
  assert.equal(result.flight.id, 'flight-one'); assert.equal(result.targetId, `end:${trip.days[0].id}`);
  assert.equal(result.activityId, undefined); assert.equal(result.arrivalIsDayEnd, true); assert.deepEqual(trip, before);
});
check('a first flight activity keeps its activity identity and landing visit duration', () => {
  const trip = activityTrip([arrival({duration: 45, note: 'Meet family'}), stop]), before = structuredClone(trip);
  const result = getStartingFlight(trip, trip.days[0]);
  assert.equal(result.targetId, 'activity:arrival'); assert.equal(result.activityId, 'arrival'); assert.equal(result.arrivalIsDayEnd, false);
  assert.deepEqual(trip, before); assert.equal(trip.days[0].items[0].duration, 45);
});
check('a sole arrival activity is the day end only when the final airport matches', () => {
  const trip = activityTrip(); assert.equal(getStartingFlight(trip, trip.days[0]).arrivalIsDayEnd, true);
  trip.days[0].endPlaceId = 'hotel'; assert.equal(getStartingFlight(trip, trip.days[0]).arrivalIsDayEnd, false);
});
check('a flight after a visit or ground airport transfer is not regrouped at the start', () => {
  const trip = activityTrip([stop, arrival()]); assert.equal(getStartingFlight(trip, trip.days[0]), null);
  trip.days[0].items = [{...stop, aid: 'airport-transfer', placeId: 'airportA', departureForFlightId: 'flight-one'}, arrival()];
  assert.equal(getStartingFlight(trip, trip.days[0]), null);
});
check('unknown bookings, missing airports and mismatched link endpoints fall back safely', () => {
  for (const change of [trip => trip.days[0].endFlightId = 'missing', trip => delete trip.customPlaces.airportA,
    trip => trip.days[0].startPlaceId = 'hotel', trip => trip.days[0].endPlaceId = 'hotel',
    trip => trip.days[0].endMode = 'walk']) {
    const trip = fixture(); change(trip); assert.equal(getStartingFlight(trip, trip.days[0]), null);
  }
});
check('an activity must link the first actual airport-to-airport flight on its departure date', () => {
  const trip = activityTrip(); trip.days[0].items[0].placeId = 'hotel'; assert.equal(getStartingFlight(trip, trip.days[0]), null);
  trip.days[0].items[0] = arrival(); trip.flights[0].departure.date = '2027-05-15'; assert.equal(getStartingFlight(trip, trip.days[0]), null);
  assert.equal(getStartingFlight(trip, {...trip.days[0], id: 'missing-day'}), null);
});
check('adding a stop after a direct flight preserves airports and booking times in one valid itinerary', () => {
  const trip = fixture(), before = structuredClone(trip), day = trip.days[0];
  const index = prepareStopInsertion(trip, day, 0); assert.equal(index, 1);
  day.items.splice(index, 0, {...stop});
  assert.equal(day.items[0].mode, 'flight'); assert.equal(day.items[0].flightId, 'flight-one');
  assert.equal(day.items[0].placeId, 'airportB'); assert.equal(day.items[0].duration, 0); assert.equal(day.items[1].aid, 'visit');
  assert.equal(day.startPlaceId, before.days[0].startPlaceId); assert.equal(day.endPlaceId, before.days[0].endPlaceId);
  assert.equal(day.endMode, 'walk'); assert.equal(day.endFlightId, undefined); assert.deepEqual(trip.flights, before.flights);
  assert.equal(isTrip(trip), true);
});
check('ordinary insertions clamp positions and repeated preparation never duplicates a flight', () => {
  const trip = fixture(), day = trip.days[0]; prepareStopInsertion(trip, day);
  const before = structuredClone(day);
  assert.equal(prepareStopInsertion(trip, day), 1); assert.equal(prepareStopInsertion(trip, day, 99), 1);
  assert.equal(prepareStopInsertion(trip, day, -2), 1); assert.deepEqual(day, before);
  trip.days[1].items = [{...stop}]; const ordinary = structuredClone(trip.days[1]);
  assert.equal(prepareStopInsertion(trip, trip.days[1]), 1); assert.equal(prepareStopInsertion(trip, trip.days[1], -2), 0); assert.deepEqual(trip.days[1], ordinary);
});
check('normal stop moves cannot precede a leading flight or erase a same-airport landing visit', () => {
  const trip = activityTrip([arrival({duration: 45, note: 'Meet family'}), {...stop}]), day = trip.days[0], landing = structuredClone(day.items[0]);
  const moving = day.items.pop(), index = prepareStopInsertion(trip, day, 0); assert.equal(index, 1);
  day.items.splice(index, 0, moving);
  assert.deepEqual(day.items[0], landing); assert.equal(day.items[1].aid, 'visit'); assert.equal(isTrip(trip), true);
});
console.log(`\n${passed} starting flight checks passed.`);
