import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
const {travelTargets, travelTargetReferences, targetState, nextTravelTarget, travelDayDate, tripLocalDate, todayTravelDay, initialTravelDay, travelDateLabel, travelDirectionsURL} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
let assertions = 0;
function check(name, run) {run(); assertions++; console.log(`✓ ${name}`);}
const activity = (aid, placeId = 'museum') => ({aid, placeId, duration: 60, fixed: null, mode: 'walk', note: ''});
const day = (items = [], rest = {}) => ({id: 'day-one', label: 'Day 1', date: 'Sun 1', title: 'Explore', endMode: 'transit', items, ...rest});
const place = (rest = {}) => ({id: 'airport', name: '関西空港 · Terminal 1 & rail', cat: 'custom', x: 50, y: 50, typical: '', area: '', blurb: '', ...rest});

check('repeated places have separate progress and retain itinerary order', () => {
  const targets = travelTargets(day([activity('morning'), activity('evening')]));
  assert.equal(nextTravelTarget(targets, {})?.id, 'activity:morning');
  assert.equal(nextTravelTarget(targets, {'activity:morning': 'done'})?.id, 'activity:evening');
  assert.equal(nextTravelTarget(targets, {'activity:morning': 'skipped'})?.id, 'activity:evening');
  assert.equal(nextTravelTarget(targets, {'activity:morning': 'done', 'activity:evening': 'skipped'})?.id, 'end:day-one');
});
check('manual target selection never changes marks or jumps to the end early', () => {
  const targets = travelTargets(day([activity('a'), activity('b')]));
  const marks = Object.freeze({'activity:a': 'planned'});
  assert.equal(nextTravelTarget(targets, marks, 'activity:b')?.id, 'activity:b');
  assert.equal(nextTravelTarget(targets, marks, 'end:day-one')?.id, 'activity:a');
  assert.equal(nextTravelTarget(targets, marks, 'deleted-target')?.id, 'activity:a');
  assert.deepEqual(marks, {'activity:a': 'planned'});
  assert.equal(nextTravelTarget(targets, {'activity:b': 'done'}, 'activity:b')?.id, 'activity:a');
});
check('an arrival day with no visits still leads to its hotel endpoint', () => {
  const targets = travelTargets(day([], {startPlaceId: 'airport', endPlaceId: 'hotel'}));
  assert.equal(targets.length, 1); assert.equal(targets[0].kind, 'end');
  assert.equal(nextTravelTarget(targets, {})?.placeId, 'hotel');
  assert.equal(nextTravelTarget(targets, {'end:day-one': 'done'}), null);
  assert.deepEqual(travelTargets(day()), []);
});
check('resetting a stop makes it next again and unknown marks are planned', () => {
  const targets = travelTargets(day([activity('a')]));
  assert.equal(nextTravelTarget(targets, {'activity:a': 'done', 'end:day-one': 'done'}), null);
  assert.equal(nextTravelTarget(targets, {'activity:a': 'planned', 'end:day-one': 'done'})?.id, 'activity:a');
  assert.equal(targetState({'activity:a': 'invalid'}, 'activity:a'), 'planned');
});
check('today uses destination date across opposite device/calendar boundaries', () => {
  const trip = {startDate: '2027-05-14', timezone: 'Asia/Tokyo', days: [day(), day(), day()]};
  const now = new Date('2027-05-14T16:30:00Z');
  assert.equal(tripLocalDate(trip.timezone, now), '2027-05-15');
  assert.equal(todayTravelDay(trip, now), 1);
  assert.equal(tripLocalDate('America/Los_Angeles', now), '2027-05-14');
  assert.equal(todayTravelDay(trip, new Date('2027-05-16T15:00:00Z')), null);
  assert.equal(initialTravelDay(trip, 2, new Date('2027-05-10T12:00:00Z')), 2);
  assert.equal(initialTravelDay(trip, 29, new Date('2027-05-10T12:00:00Z')), 2);
});
check('calendar dates remain correct across leap day and DST changes', () => {
  assert.equal(travelDayDate('2028-02-28', 2), '2028-03-01');
  assert.equal(travelDayDate('2027-02-29', 0), null);
  assert.equal(travelDayDate('9999-12-31', 1), null);
  for (const now of ['2027-03-28T00:30:00Z', '2027-03-28T01:30:00Z', '2027-10-31T00:30:00Z', '2027-10-31T01:30:00Z']) {
    assert.equal(tripLocalDate('Europe/London', new Date(now)), now.slice(0, 10));
  }
  assert.equal(tripLocalDate('not/a-zone', new Date()), null);
  assert.match(travelDateLabel('2027-05-14'), /Fri.*14.*May/);
});
check('airport directions preserve exact place identity, Unicode label and selected mode', () => {
  for (const [mode, googleMode] of [['walk', 'walking'], ['drive', 'driving'], ['transit', 'transit']]) {
    const url = new URL(travelDirectionsURL(place({googlePlaceId: 'ChIJ_Terminal-1'}), mode));
    assert.equal(url.origin, 'https://www.google.com');
    assert.equal(url.searchParams.get('destination_place_id'), 'ChIJ_Terminal-1');
    assert.equal(url.searchParams.get('destination'), '関西空港 · Terminal 1 & rail');
    assert.equal(url.searchParams.get('travelmode'), googleMode);
    assert.equal(url.searchParams.has('origin'), false);
    assert.equal(url.searchParams.get('api'), '1');
  }
});
check('a provider ID works without hydrated details but a generic name never guesses a location', () => {
  assert.equal(travelDirectionsURL(place({name: 'Saved place'}), 'walk'), null);
  assert.equal(travelDirectionsURL(place({googlePlaceId: 'bad&origin=secret'}), 'walk'), null);
  assert.equal(travelDirectionsURL(place({lat: 91, lng: 0}), 'walk'), null);
  assert.equal(travelDirectionsURL(place({lat: 0, lng: Infinity}), 'walk'), null);
  const fallback = new URL(travelDirectionsURL(place({name: 'Saved place', googlePlaceId: 'ChIJExact'}), 'walk'));
  assert.equal(fallback.searchParams.get('destination_place_id'), 'ChIJExact');
  const coordinates = new URL(travelDirectionsURL(place({lat: 0, lng: -180}), 'drive'));
  assert.equal(coordinates.searchParams.get('destination'), '0,-180');
  assert.equal(coordinates.searchParams.has('destination_place_id'), false);
});
const flightTrip = () => {
  const flight={id:'outbound',fromPlaceId:'departure',toPlaceId:'arrival',departure:{date:'2027-05-14',time:'23:00',timezone:'Europe/London'},arrival:{date:'2027-05-15',time:'20:00',timezone:'Asia/Tokyo'}};
  return {startDate:'2027-05-14',timezone:'Asia/Tokyo',flights:[flight],days:[
    day([{...activity('airport','departure'),mode:'transit',departureForFlightId:'outbound'},{...activity('land','arrival'),duration:0,mode:'flight',flightId:'outbound'}],{timezone:'Europe/London'}),
    day([activity('sights')],{id:'day-two',startPlaceId:'arrival',timezone:'Asia/Tokyo'})]};
};
check('departure airport and landing are separate ordered targets with no zero-duration duplicate',()=>{
  const trip=flightTrip(), targets=travelTargets(trip.days[0],trip);
  assert.deepEqual(targets.map(target=>target.id),['activity:airport','flight:outbound','end:day-one']);
  assert.equal(targets[1].kind,'flight'); assert.equal(targets[1].placeId,'arrival'); assert.equal(targets[1].flight.id,'outbound');
  assert.equal(nextTravelTarget(targets,{'activity:airport':'done'}).id,'flight:outbound');
  assert.equal(nextTravelTarget(targets,{'activity:airport':'done','flight:outbound':'done'}).id,'end:day-one');
});
check('a nonzero visit at the arrival airport remains after the flight',()=>{
  const trip=flightTrip(); trip.days[0].items[1].duration=60;
  const targets=travelTargets(trip.days[0],trip);
  assert.deepEqual(targets.map(target=>target.id),['activity:airport','flight:outbound','activity:land','end:day-one']);
  assert.equal(targets[2].mode,'walk');
});
check('airport-only end flight replaces the arrival endpoint completion',()=>{
  const trip=flightTrip(); trip.days[0]=day([],{startPlaceId:'departure',endPlaceId:'arrival',endMode:'flight',endFlightId:'outbound'});
  const targets=travelTargets(trip.days[0],trip);
  assert.deepEqual(targets.map(target=>target.id),['flight:outbound']);
  assert.equal(nextTravelTarget(targets,{}).id,'flight:outbound');
  assert.equal(nextTravelTarget(targets,{'flight:outbound':'done'}),null);
});
check('overnight arrival day uses the same flight mark before new day visits',()=>{
  const trip=flightTrip(), targets=travelTargets(trip.days[1],trip);
  assert.equal(targets[0].id,'flight:outbound'); assert.equal(targets[0].dayId,'day-two');
  assert.equal(nextTravelTarget(targets,{'flight:outbound':'done'}).id,'activity:sights');
  assert.equal(nextTravelTarget(targets,{}).id,'flight:outbound');
});
check('cross-day flight projections deduplicate reference identities for the controller and hook',()=>{
  const trip=flightTrip(), references=travelTargetReferences(trip);
  assert.equal(Object.keys(references).filter(id=>id==='flight:outbound').length,1);
  assert.deepEqual(references,Object.fromEntries(trip.days.flatMap(value=>travelTargets(value,trip)).map(target=>[target.id,target.placeId])));
});
check('unattached bookings and flights on unrelated dates do not become travel targets',()=>{
  const trip=flightTrip(); trip.flights.push({...trip.flights[0],id:'unattached'});
  assert.equal(travelTargets(trip.days[1],trip).some(target=>target.id==='flight:unattached'),false);
  trip.flights[0].arrival.date='2027-05-16';
  assert.equal(travelTargets(trip.days[1],trip).some(target=>target.kind==='flight'),false);
});
check('flight completion never occurs automatically and skipped flights advance only explicitly',()=>{
  const trip=flightTrip(), targets=travelTargets(trip.days[0],trip), marks={'activity:airport':'done'};
  assert.equal(nextTravelTarget(targets,marks).id,'flight:outbound');
  assert.equal(nextTravelTarget(targets,{...marks,'flight:outbound':'skipped'}).kind,'end');
  assert.deepEqual(marks,{'activity:airport':'done'});
});
check('Today respects each selected day zone instead of only the trip destination zone',()=>{
  const trip={startDate:'2027-05-14',timezone:'Asia/Tokyo',days:[day([],{timezone:'America/Los_Angeles'})]};
  assert.equal(todayTravelDay(trip,new Date('2027-05-14T17:00:00Z')),0);
  assert.equal(tripLocalDate(trip.timezone,new Date('2027-05-14T17:00:00Z')),'2027-05-15');
});
check('flight directions are never sent as driving or transit routes',()=>{
  assert.equal(travelDirectionsURL(place({googlePlaceId:'ChIJAirport'}),'flight'),null);
  assert.equal(travelDirectionsURL(place({lat:10,lng:20}),'flight'),null);
});
console.log(`${assertions} travel selector and directions checks passed.`);
