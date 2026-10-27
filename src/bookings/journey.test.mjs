import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
globalThis.crypto ??= webcrypto;
const compile = (path, modules = {}) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match)).toString('base64');
const modelURL = compile('../model.ts'), actionsURL = compile('./actions.ts', {'../model': modelURL});
const {createTrip, isTrip, bookingDayDate} = await import(modelURL);
const {linkFlight} = await import(actionsURL);
const {flightDayBoundary, tripBookingSummary, appliedFlightBoundaries, saveTripFlight, saveTripStay} = await import(compile('./journey.ts', {'../model': modelURL, './actions': actionsURL}));
const place = id => ({id, name: id, cat: 'custom', x: 50, y: 50, area: '', typical: '', blurb: ''});
const fixture = (start = '2027-05-14', count = 3) => {
  const trip = createTrip('Holiday', 'Japan', start, count); trip.timezone = 'Asia/Tokyo';
  trip.customPlaces = Object.fromEntries(['lhr', 'kix', 'stayA', 'stayB', 'other'].map(id => [id, place(id)]));
  return trip;
};
const moment = (date, time, timezone = 'Asia/Tokyo', rest = {}) => ({date, time, timezone, ...rest});
const flight = (rest = {}) => ({id: 'incoming', fromPlaceId: 'lhr', toPlaceId: 'kix', departure: moment('2027-05-13', '22:00', 'Europe/London'), arrival: moment('2027-05-14', '18:00'), airportBufferMinutes: 120, arrivalBufferMinutes: 60, ...rest});
const outbound = (rest = {}) => flight({id: 'outbound', fromPlaceId: 'kix', toPlaceId: 'lhr', departure: moment('2027-05-16', '19:00'), arrival: moment('2027-05-16', '23:00', 'Europe/London'), ...rest});
const stay = (rest = {}) => ({id: 'stay-one', placeId: 'stayA', checkInDate: '2027-05-14', checkOutDate: '2027-05-16', timezone: 'Asia/Tokyo', checkInTime: '15:00', checkOutTime: '11:00', ...rest});
const stop = (aid = 'museum') => ({aid, placeId: 'nijo', duration: 90, fixed: null, mode: 'walk', note: 'Keep my reservation.'});
let passed = 0;
function check(name, run) {run(); passed++; console.log(`✓ ${name}`);}

check('whole-trip arrival includes a preholiday departure and departure is on the final day', () => {
  const trip = fixture(); trip.flights = [flight(), outbound()];
  const summary = tripBookingSummary(trip);
  assert.equal(summary.arrival.id, 'incoming'); assert.equal(summary.departure.id, 'outbound');
  assert.deepEqual(summary.arrivalFlights, summary.arrivals); assert.equal(summary.totalNights, 2);
});
check('multiple boundary flights stay choices instead of silently selecting a connection', () => {
  const trip = fixture(); trip.flights = [flight(), flight({id: 'connection'}), outbound(), outbound({id: 'alternative'})];
  const summary = tripBookingSummary(trip);
  assert.equal(summary.arrival, null); assert.equal(summary.departure, null);
  assert.equal(summary.arrivals.length, 2); assert.equal(summary.departures.length, 2);
});
check('a next-date departure remains in the bookings bar when its airport goal is on the last trip day', () => {
  const trip = fixture();
  const nextDateFlight = outbound({departure: moment('2027-05-17', '00:30'), arrival: moment('2027-05-17', '04:30', 'Europe/London')});
  saveTripFlight(trip, nextDateFlight, {intent: 'departure', applyToDay: true});
  assert.equal(trip.days.length, 3); assert.equal(trip.days[2].finishBy, 1350);
  assert.equal(tripBookingSummary(trip).departure.id, 'outbound');
  trip.flights.push(outbound({id: 'same-day-alternative'}));
  assert.equal(tripBookingSummary(trip).departure, null); assert.equal(tripBookingSummary(trip).departures.length, 2);
});
check('nights are exclusive of checkout and count missing and overlapping nights once', () => {
  const trip = fixture('2027-05-14', 4);
  trip.stays = [stay(), stay({id: 'other-stay', placeId: 'stayB', checkInDate: '2027-05-15'})];
  const summary = tripBookingSummary(trip);
  assert.deepEqual(summary.nights.map(night => night.status), ['booked', 'overlap', 'missing']);
  assert.equal(summary.bookedNights, 2); assert.equal(summary.missingNights, 1); assert.equal(summary.overlappingNights, 1);
});
check('a one-day trip has zero overnight gaps', () => {
  const summary = tripBookingSummary(fixture('2027-05-14', 1));
  assert.equal(summary.totalNights, 0); assert.equal(summary.missingNights, 0); assert.deepEqual(summary.nights, []);
});
check('late-night landing plus baggage buffer starts the following local day', () => {
  const trip = fixture(), value = flight({arrival: moment('2027-05-14', '23:30')});
  const boundary = flightDayBoundary(trip, value, 'arrival');
  assert.equal(boundary.date, '2027-05-15'); assert.equal(boundary.dayIndex, 1);
  assert.equal(boundary.minutes, 30); assert.equal(boundary.minute, 30); assert.equal(boundary.ready, true);
});
check('arrival after the date line uses the arrival airport calendar without adding the departure day', () => {
  const trip = fixture('2027-05-13', 2);
  const value = flight({departure: moment('2027-05-14', '00:30', 'Pacific/Auckland'), arrival: moment('2027-05-13', '18:00', 'America/Los_Angeles')});
  saveTripFlight(trip, value, {intent: 'arrival', applyToDay: true, extendTrip: true});
  assert.equal(trip.startDate, '2027-05-13'); assert.equal(trip.days.length, 2);
  assert.equal(trip.days[0].startTime, 1140); assert.equal(trip.days[0].timezone, 'America/Los_Angeles');
});
check('an early flight uses the previous day airport deadline', () => {
  const trip = fixture(), value = outbound({departure: moment('2027-05-16', '01:00'), arrival: moment('2027-05-16', '05:00', 'Europe/London')});
  const boundary = flightDayBoundary(trip, value, 'departure');
  assert.equal(boundary.dayIndex, 1); assert.equal(boundary.date, '2027-05-15'); assert.equal(boundary.minutes, 1380);
  saveTripFlight(trip, value, {intent: 'departure', applyToDay: true, transferMode: 'transit'});
  assert.equal(trip.days[1].endPlaceId, 'kix'); assert.equal(trip.days[1].finishBy, 1380); assert.equal(trip.days[2].finishBy, null);
});
check('departure goals convert into the existing day zone without retiming visits', () => {
  const trip = fixture(); trip.days[2].timezone = 'Asia/Hong_Kong';
  const boundary = flightDayBoundary(trip, outbound(), 'departure');
  assert.equal(boundary.minutes, 960); assert.equal(boundary.timezone, 'Asia/Hong_Kong');
  saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  assert.equal(trip.days[2].timezone, 'Asia/Hong_Kong'); assert.equal(trip.days[2].finishBy, 960);
});
check('arrival saves one booking, adjusts the ground start and keeps every stop and idea', () => {
  const trip = fixture(), activity = stop(); trip.days[0].items = [activity]; trip.ideas = ['gion'];
  const initialIds = trip.days.map(day => day.id);
  saveTripFlight(trip, flight(), {intent: 'arrival', applyToDay: true, transferMode: 'transit'});
  assert.deepEqual(trip.days.map(day => day.id), initialIds); assert.equal(trip.days[0].startPlaceId, 'kix'); assert.equal(trip.days[0].startTime, 1140);
  assert.deepEqual(trip.days[0].items, [{...activity, mode: 'transit'}]); assert.deepEqual(trip.ideas, ['gion']);
  assert.equal(trip.days[0].items.some(item => item.mode === 'flight'), false); assert.equal(trip.flights.length, 1); assert.equal(isTrip(trip), true);
});
check('arrival with an empty day chooses its ground transfer without creating airport activities', () => {
  const trip = fixture(); saveTripFlight(trip, flight(), {intent: 'arrival', applyToDay: true, transferMode: 'drive'});
  assert.deepEqual(trip.days[0].items, []); assert.equal(trip.days[0].endMode, 'drive'); assert.equal(trip.days[0].endFlightId, undefined);
});
check('departure sets the airport deadline and retains activity IDs, appointments and notes', () => {
  const trip = fixture(), activity = {...stop(), fixed: 600}; trip.days[2].items = [activity];
  saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true, transferMode: 'drive'});
  assert.equal(trip.days[2].endPlaceId, 'kix'); assert.equal(trip.days[2].finishBy, 1020); assert.equal(trip.days[2].endMode, 'drive');
  assert.deepEqual(trip.days[2].items, [activity]); assert.equal(isTrip(trip), true);
});
check('moving a flight clears the former automatic deadline and applies the new date atomically', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  const changed = outbound({departure: moment('2027-05-15', '19:00'), arrival: moment('2027-05-15', '23:00', 'Europe/London')});
  saveTripFlight(trip, changed, {intent: 'departure', applyToDay: true});
  assert.equal(trip.days[2].finishBy, null); assert.equal(trip.days[2].endPlaceId, 'hotel');
  assert.equal(trip.days[1].finishBy, 1020); assert.equal(trip.days[1].endPlaceId, 'kix'); assert.equal(trip.flights.length, 1);
});
check('moving an arrival keeps the old day stops and resets only its unchanged airport boundary', () => {
  const trip = fixture(); trip.days[0].items = [stop()];
  saveTripFlight(trip, flight(), {intent: 'arrival', applyToDay: true});
  saveTripFlight(trip, flight({departure: moment('2027-05-14', '22:00', 'Europe/London'), arrival: moment('2027-05-15', '18:00')}), {intent: 'arrival', applyToDay: true});
  assert.equal(trip.days[0].startPlaceId, 'hotel'); assert.equal(trip.days[0].startTime, 540); assert.equal(trip.days[0].items[0].aid, 'museum');
  assert.equal(trip.days[1].startPlaceId, 'kix'); assert.equal(trip.days[1].startTime, 1140);
});
check('manually retimed endpoints survive clearing an inferred prior boundary', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true}); trip.days[2].finishBy = 1000;
  saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: false});
  assert.equal(trip.days[2].finishBy, 1000); assert.equal(trip.days[2].endPlaceId, 'kix');
});
check('unchecking day application keeps the already accepted day plan unchanged', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  const days = structuredClone(trip.days);
  saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: false});
  assert.deepEqual(trip.days, days); assert.equal(trip.flights.length, 1);
});
check('warnings still associate an airport after manually removing the day finish goal', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true}); trip.days[2].finishBy = null;
  assert.equal(appliedFlightBoundaries(trip, trip.days[2].id).departure.id, 'outbound');
});
check('a second booking-only flight does not hide the exactly applied airport boundary', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  saveTripFlight(trip, outbound({id: 'later-flight', departure: moment('2027-05-16', '20:00'), arrival: moment('2027-05-17', '00:00', 'Europe/London')}));
  const association = appliedFlightBoundaries(trip, trip.days[2].id);
  assert.equal(association.departure.id, 'outbound'); assert.equal(association.departureCandidates.length, 2); assert.equal(association.ambiguousDeparture, false);
});
check('ambiguous same-time airport bookings remain explicit instead of selecting an arbitrary flight', () => {
  const trip = fixture(); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true}); saveTripFlight(trip, outbound({id: 'duplicate-time'}));
  const association = appliedFlightBoundaries(trip, trip.days[2].id);
  assert.equal(association.departure, null); assert.equal(association.ambiguousDeparture, true); assert.equal(association.departureCandidates.length, 2);
});
check('unknown flight times may be saved but never fabricate day boundaries', () => {
  const trip = fixture(), value = flight({arrival: moment('2027-05-14', null)}), before = structuredClone(trip);
  assert.equal(flightDayBoundary(trip, value, 'arrival').ready, false);
  assert.throws(() => saveTripFlight(trip, value, {intent: 'arrival', applyToDay: true}), /time|Confirm/i); assert.deepEqual(trip, before);
  saveTripFlight(trip, value, {intent: 'arrival', applyToDay: false}); assert.deepEqual(trip.days, before.days); assert.equal(trip.flights.length, 1);
});
check('DST repeated times require an explicit offset before day application', () => {
  const trip = fixture('2026-10-25', 2), value = flight({departure: moment('2026-10-24', '20:00', 'Europe/London'), arrival: moment('2026-10-25', '01:30', 'Europe/London')});
  assert.equal(flightDayBoundary(trip, value, 'arrival').ready, false);
  const confirmed = {...value, arrival: {...value.arrival, offsetMinutes: 0}};
  assert.equal(flightDayBoundary(trip, confirmed, 'arrival').minutes, 150); assert.equal(flightDayBoundary(trip, confirmed, 'arrival').ready, true);
});
check('applying a departure before the current day start fails without a partial booking write', () => {
  const trip = fixture(), value = outbound({departure: moment('2027-05-16', '08:00'), arrival: moment('2027-05-16', '12:00', 'Europe/London')}), before = structuredClone(trip);
  assert.equal(flightDayBoundary(trip, value, 'departure').ready, false);
  assert.throws(() => saveTripFlight(trip, value, {intent: 'departure', applyToDay: true}), /earlier start/); assert.deepEqual(trip, before);
});
check('an arrival after a manually chosen finish goal is explained without erasing that goal', () => {
  const trip = fixture(); trip.days[0].finishBy = 1100; const before = structuredClone(trip);
  assert.throws(() => saveTripFlight(trip, flight(), {intent: 'arrival', applyToDay: true}), /finish goal/); assert.deepEqual(trip, before);
});
check('legacy linked flights require explicit unlinking and never become duplicate airport stops', () => {
  const trip = fixture('2027-05-13', 4); trip.flights = [flight()]; linkFlight(trip, 'incoming', {dayId: trip.days[0].id, targetId: `end:${trip.days[0].id}`});
  const before = structuredClone(trip);
  const sameDay = flight({departure: moment('2027-05-13', '01:00', 'Europe/London'), arrival: moment('2027-05-13', '22:00')});
  assert.throws(() => saveTripFlight(trip, sameDay, {intent: 'arrival', applyToDay: true}), /Unlink|linked flight/i); assert.deepEqual(trip, before);
});
check('outside arrival application extends only the ground arrival date when explicitly requested', () => {
  const trip = fixture(), value = flight({departure: moment('2027-05-16', '22:00', 'Europe/London'), arrival: moment('2027-05-17', '18:00')}), before = structuredClone(trip);
  assert.throws(() => saveTripFlight(trip, value, {intent: 'arrival', applyToDay: true}), /outside/); assert.deepEqual(trip, before);
  saveTripFlight(trip, value, {intent: 'arrival', applyToDay: true, extendTrip: true});
  assert.equal(trip.days.length, 4); assert.equal(trip.startDate, '2027-05-14'); assert.equal(trip.days[3].startPlaceId, 'kix');
});
check('failed trip extension leaves the booking, days and stops unchanged', () => {
  const trip = fixture(), value = flight({departure: moment('2028-05-13', '22:00', 'Europe/London'), arrival: moment('2028-05-14', '18:00')}), before = structuredClone(trip);
  assert.throws(() => saveTripFlight(trip, value, {intent: 'arrival', applyToDay: true, extendTrip: true}), /30 days/); assert.deepEqual(trip, before);
});
check('stays apply matching nights while retaining arrival and departure airports', () => {
  const trip = fixture(); saveTripFlight(trip, flight(), {intent: 'arrival', applyToDay: true}); saveTripFlight(trip, outbound(), {intent: 'departure', applyToDay: true});
  saveTripStay(trip, stay(), {applyToDays: true});
  assert.equal(trip.days[0].startPlaceId, 'kix'); assert.equal(trip.days[0].endPlaceId, 'stayA');
  assert.equal(trip.days[1].startPlaceId, 'stayA'); assert.equal(trip.days[1].endPlaceId, 'stayA');
  assert.equal(trip.days[2].startPlaceId, 'stayA'); assert.equal(trip.days[2].endPlaceId, 'kix'); assert.equal(isTrip(trip), true);
});
check('changing stays starts the changeover day at the previous property and ends at the next', () => {
  const trip = fixture('2027-05-14', 4); trip.days[2].items = [stop()];
  saveTripStay(trip, stay(), {applyToDays: true});
  saveTripStay(trip, stay({id: 'stay-two', placeId: 'stayB', checkInDate: '2027-05-16', checkOutDate: '2027-05-17'}), {applyToDays: true});
  assert.equal(trip.days[2].startStayId, 'stay-one'); assert.equal(trip.days[2].startPlaceId, 'stayA');
  assert.equal(trip.days[2].endStayId, 'stay-two'); assert.equal(trip.days[2].endPlaceId, 'stayB');
  assert.equal(trip.days[3].startPlaceId, 'stayB'); assert.deepEqual(trip.days[2].items, [stop()]);
});
check('overlapping stay saves do not replace accepted accommodation with an arbitrary hotel', () => {
  const trip = fixture(); saveTripStay(trip, stay(), {applyToDays: true}); const days = structuredClone(trip.days);
  saveTripStay(trip, stay({id: 'overlap', placeId: 'stayB'}), {applyToDays: true});
  assert.deepEqual(trip.days, days); assert.equal(tripBookingSummary(trip).overlappingNights, 2);
});
check('shortening an applied hotel frees its expired night for the next stay', () => {
  const trip = fixture(); saveTripStay(trip, stay(), {applyToDays: true});
  saveTripStay(trip, stay({checkOutDate: '2027-05-15'}), {applyToDays: true});
  saveTripStay(trip, stay({id: 'ryokan', placeId: 'stayB', checkInDate: '2027-05-15', checkOutDate: '2027-05-16'}), {applyToDays: true});
  assert.equal(trip.days[1].startPlaceId, 'stayA'); assert.equal(trip.days[1].endPlaceId, 'stayB');
  assert.equal(trip.days[2].startPlaceId, 'stayB'); assert.equal(isTrip(trip), true);
});
check('resolving an overlapping stay switches only the expired accepted endpoints', () => {
  const trip = fixture(); saveTripStay(trip, stay(), {applyToDays: true});
  saveTripStay(trip, stay({id: 'ryokan', placeId: 'stayB', checkInDate: '2027-05-15', checkOutDate: '2027-05-16'}), {applyToDays: true});
  trip.days[2].endPlaceId = 'kix';
  saveTripStay(trip, stay({checkOutDate: '2027-05-15'}), {applyToDays: true});
  assert.equal(trip.days[1].startPlaceId, 'stayA'); assert.equal(trip.days[1].endPlaceId, 'stayB');
  assert.equal(trip.days[2].startPlaceId, 'stayB'); assert.equal(trip.days[2].endPlaceId, 'kix');
  assert.equal(tripBookingSummary(trip).overlappingNights, 0);
});
check('shortening a stay keeps a manually replaced airport endpoint', () => {
  const trip = fixture(); saveTripStay(trip, stay(), {applyToDays: true});
  trip.days[1].endPlaceId = 'kix'; delete trip.days[1].endStayId;
  saveTripStay(trip, stay({checkOutDate: '2027-05-15'}), {applyToDays: true});
  assert.equal(trip.days[1].endPlaceId, 'kix'); assert.equal(trip.days[1].endStayId, undefined);
});
check('saving stay details alone does not change day endpoints or visits', () => {
  const trip = fixture(); trip.days[1].items = [stop()]; const days = structuredClone(trip.days);
  saveTripStay(trip, stay(), {applyToDays: false}); assert.deepEqual(trip.days, days);
});
check('stay date extension is explicit and retains original day identities', () => {
  const trip = fixture(), ids = trip.days.map(day => day.id);
  saveTripStay(trip, stay({checkInDate: '2027-05-13', checkOutDate: '2027-05-17'}), {applyToDays: true, extendTrip: true});
  assert.equal(trip.startDate, '2027-05-13'); assert.equal(bookingDayDate(trip, 4), '2027-05-17');
  assert.deepEqual(trip.days.slice(1, 4).map(day => day.id), ids); assert.equal(isTrip(trip), true);
});
console.log(`\n${passed} trip booking journey checks passed.`);
