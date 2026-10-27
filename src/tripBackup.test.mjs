import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';

globalThis.crypto ??= webcrypto;
const transpile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const modelUrl = url(transpile('./model.ts'));
const model = await import(modelUrl);
const backup = await import(url(transpile('./tripBackup.ts').replace("from './model'", `from '${modelUrl}'`)));
const {createTripBackup, serializeTripBackup, parseTripBackup, mergeTripBackup, MAX_BACKUP_BYTES} = backup;
const {seedTrip, createTrip, isTrip} = model;
let assertions = 0;
async function check(name, fn) { await fn(); assertions += 1; console.log(`✓ ${name}`); }
const clone = value => JSON.parse(JSON.stringify(value));
const stamp = '2026-10-26T12:30:00.000Z';
const snapshot = trip => createTripBackup([trip], trip.id, stamp);

await check('workspace JSON round-trips every user planning field without sharing references', () => {
  const trip = seedTrip();
  trip.days[0].startTime = 500; trip.days[0].finishBy = 1200; trip.days[0].startPlaceId = 'nijo'; trip.days[0].endPlaceId = 'meeting';
  trip.days[0].items[0].note = 'Tickets in my bag. Meet at the east gate. 日本語';
  trip.customPlaces.meeting = {id: 'meeting', name: 'Friends’ place', cat: 'custom', x: 23, y: 35, area: 'Old town', typical: '45 min', blurb: 'Ring twice', noTransit: true, lat: 35, lng: 135, userLabel: 'Meet Aki', userNotes: 'Bring the gift'};
  trip.ideas.push('meeting');
  const source = clone(trip), restored = parseTripBackup(serializeTripBackup([trip], trip.id, stamp));
  assert.deepEqual(restored.trips[0], source); assert.equal(restored.activeId, trip.id); assert.equal(restored.exportedAt, stamp);
  assert.equal(isTrip(restored.trips[0]), true);
  restored.trips[0].days[0].items[0].note = 'Changed';
  assert.deepEqual(trip, source);
});

await check('airport endpoints survive backup export, parsing and additive import', async () => {
  const trip = seedTrip();
  trip.customPlaces.airport = {id: 'airport', name: 'Hydrated airport name', cat: 'custom', x: 50, y: 50, area: 'Airport address', typical: '', blurb: '', googlePlaceId: 'ChIJ_airport', lat: 35, lng: 135};
  trip.days[0].startPlaceId = 'airport';
  trip.days[0].items = [];
  trip.days[2].endPlaceId = 'airport';
  trip.days[2].endMode = 'transit';
  const file = parseTripBackup(serializeTripBackup([trip], trip.id, stamp));
  const result = await mergeTripBackup([], file);
  const restored = result.addedTrips[0];
  assert.equal(restored.days[0].startPlaceId, 'airport');
  assert.deepEqual(restored.days[0].items, []);
  assert.equal(restored.days[2].endPlaceId, 'airport');
  assert.equal(restored.days[2].endMode, 'transit');
  assert.equal(restored.customPlaces.airport.googlePlaceId, 'ChIJ_airport');
  assert.equal(restored.customPlaces.airport.lat, undefined);
  assert.equal(restored.customPlaces.airport.name, 'Saved place');
  assert.equal(isTrip(restored), true);
});

await check('confirmed weekday admission cutoffs survive canonical cloud and backup round trips', async () => {
  const trip = seedTrip();
  trip.customPlaces.admission = {id:'admission',name:'Provider museum',cat:'attr',x:50,y:50,area:'',typical:'',blurb:'',googlePlaceId:'ChIJ_admission',lastEntryMinutes:{0:0,1:990,6:1439}};
  trip.ideas.push('admission');
  const canonical=backup.canonicalTrip(trip);
  assert.deepEqual(canonical.customPlaces.admission.lastEntryMinutes,{0:0,1:990,6:1439});
  assert.equal(canonical.customPlaces.admission.name,'Saved place');
  const restored=parseTripBackup(serializeTripBackup([trip],trip.id,stamp));
  assert.deepEqual(restored.trips[0].customPlaces.admission.lastEntryMinutes,{0:0,1:990,6:1439});
  const merged=await mergeTripBackup([],restored);
  assert.deepEqual(merged.addedTrips[0].customPlaces.admission.lastEntryMinutes,{0:0,1:990,6:1439});
  canonical.customPlaces.admission.lastEntryMinutes[1]=975;
  assert.equal(trip.customPlaces.admission.lastEntryMinutes[1],990);
  assert.equal(model.persistableTrip(trip).customPlaces.admission.lastEntryMinutes[1],990);
});

await check('admission metadata rejects malformed weekdays and noninteger local times',()=>{
  const trip=seedTrip();
  trip.customPlaces.admission={id:'admission',name:'Museum',cat:'attr',x:50,y:50,area:'',typical:'',blurb:''};
  for(const invalid of [null,[],3,true,'16:30',{'7':900},{'-1':900},{'01':900},{Monday:900},{1:-1},{1:1440},{1:900.5},{1:'990'},{1:null},{1:true},{1:{}}]){
    const next=clone(trip);next.customPlaces.admission.lastEntryMinutes=invalid;
    assert.equal(isTrip(next),false,JSON.stringify(invalid));
    assert.throws(()=>parseTripBackup(JSON.stringify({format:'daytrail-workspace',version:2,activeId:next.id,exportedAt:stamp,trips:[next]})));
  }
  for(const valid of [{},{0:0},{6:1439}]){
    const next=clone(trip);next.customPlaces.admission.lastEntryMinutes=valid;assert.equal(isTrip(next),true);
  }
});

await check('backups retain legacy default endpoints and distinguish airport departures for duplicate detection', async () => {
  const original = seedTrip();
  const legacy = parseTripBackup(serializeTripBackup([original], original.id, stamp));
  assert.equal(Object.hasOwn(legacy.trips[0].days[0], 'endPlaceId'), false);
  const departure = clone(original);
  departure.days[2].endPlaceId = 'nijo';
  const merged = await mergeTripBackup([original], snapshot(departure));
  assert.equal(merged.addedTrips.length, 1);
  assert.equal(merged.skippedCount, 0);
  assert.equal(merged.addedTrips[0].days[2].endPlaceId, 'nijo');
});

await check('Google fields and unrecognized private metadata never enter exported or imported plans', () => {
  const trip = seedTrip();
  trip.accountToken = 'secret-account-token'; trip.routeCache = {duration: 80};
  trip.days[0].session = {token: 'secret-session'};
  trip.days[0].items[0].ratings = [5];
  trip.customPlaces.saved = {id: 'saved', name: 'Hydrated provider name', cat: 'food', x: 4, y: 5, area: 'Provider address', typical: '45 min', blurb: 'Provider description', lat: 35, lng: 135, googlePlaceId: 'ChIJ_saved', googleMapsURI: 'https://maps.google.com/example', attributions: [{provider: 'Provider', providerURI: 'https://example.com'}], rating: 4.9, photos: ['private-photo-token'], openingHours: {monday: true}, userLabel: 'Our lunch', userNotes: 'Birthday table'};
  trip.customPlaces.custom = {id: 'custom', name: 'My place', cat: 'custom', x: 50, y: 50, area: '', typical: '', blurb: 'My note', rating: 5, photos: ['more-private-data'], googleMapsURI: 'https://maps.google.com/example'};
  trip.ideas.push('saved', 'custom');
  const text = serializeTripBackup([trip], trip.id, stamp);
  for (const marker of ['accountToken', 'secret-account-token', 'routeCache', 'secret-session', 'ratings', 'Hydrated provider name', 'Provider address', 'Provider description', 'googleMapsURI', 'attributions', 'rating', 'photos', 'private-photo-token', 'openingHours']) assert.equal(text.includes(marker), false, marker);
  const restored = parseTripBackup(JSON.stringify({format: 'daytrail-workspace', version: 1, activeId: trip.id, exportedAt: stamp, trips: [trip]}));
  assert.deepEqual(restored.trips[0].customPlaces.saved, {id: 'saved', name: 'Saved place', cat: 'food', x: 50, y: 50, area: '', typical: '45 min', blurb: '', googlePlaceId: 'ChIJ_saved', userLabel: 'Our lunch', userNotes: 'Birthday table'});
  assert.equal(restored.trips[0].customPlaces.custom.blurb, 'My note');
  assert.equal('rating' in restored.trips[0].customPlaces.custom, false);
});

await check('import is additive and source ID collisions never replace current trips', async () => {
  const original = seedTrip(), incoming = clone(original);
  incoming.name = 'Different plan with the same source ID'; incoming.days[0].items[0].note = 'Keep this too';
  const before = clone(original), file = snapshot(incoming), beforeFile = clone(file);
  const result = await mergeTripBackup([original], file);
  assert.equal(result.trips.length, 2); assert.equal(result.addedTrips.length, 1); assert.equal(result.skippedCount, 0);
  assert.equal(result.trips[0], original); assert.deepEqual(original, before); assert.deepEqual(file, beforeFile);
  assert.match(result.addedTrips[0].id, /^import-[a-f0-9]{64}$/); assert.notEqual(result.addedTrips[0].id, original.id);
  assert.equal(result.activeId, result.addedTrips[0].id); assert.equal(result.addedTrips[0].name, incoming.name);
});

await check('repeat import is idempotent, including after editing the imported trip', async () => {
  const file = snapshot(seedTrip()), first = await mergeTripBackup([], file);
  const repeated = await mergeTripBackup(first.trips, file);
  assert.equal(repeated.addedTrips.length, 0); assert.equal(repeated.skippedCount, 1);
  first.trips[0].name = 'A newer local name'; first.trips[0].days[0].items[0].note = 'New local note';
  const edited = clone(first.trips), again = await mergeTripBackup(first.trips, file);
  assert.equal(again.addedTrips.length, 0); assert.equal(again.skippedCount, 1); assert.deepEqual(again.trips, edited);
});

await check('identical planning content is skipped even with different trip IDs or object-key order', async () => {
  const existing = seedTrip(), imported = clone(existing);
  imported.id = 'another-browser-id';
  imported.customPlaces = Object.fromEntries(Object.entries(imported.customPlaces).reverse());
  const result = await mergeTripBackup([existing], snapshot(imported));
  assert.equal(result.skippedCount, 1); assert.equal(result.addedTrips.length, 0); assert.equal(result.activeId, existing.id);
});

await check('identical content within a multi-trip backup is added only once', async () => {
  const a = seedTrip(), b = {...clone(a), id: 'same-content'};
  const result = await mergeTripBackup([], createTripBackup([a, b], b.id, stamp));
  assert.equal(result.addedTrips.length, 1); assert.equal(result.skippedCount, 1); assert.equal(result.activeId, result.addedTrips[0].id);
});

await check('truncated, unsupported, invalid and inconsistent backup data is rejected', () => {
  assert.throws(() => parseTripBackup('{'), /could not be read/);
  for (const value of [null, [], {}, '<html>Not a backup</html>']) assert.throws(() => parseTripBackup(JSON.stringify(value)));
  const invalids = [
    value => { value.version = 3; },
    value => { value.format = 'other-format'; },
    value => { value.activeId = 'missing-trip'; },
    value => { value.activeId = null; },
    value => { value.exportedAt = '2026-02-30T12:30:00.000Z'; },
    value => { value.trips.push(clone(value.trips[0])); },
    value => { value.trips[0].days[0].items[0].placeId = 'missing-place'; },
    value => { value.trips[0].days[0].endPlaceId = 'missing-airport'; },
    value => { value.trips[0].days[0].endPlaceId = null; },
    value => { value.trips[0].days[1].items.push(clone(value.trips[0].days[0].items[0])); },
    value => { value.trips[0].days[0].items[0].duration = -1; },
    value => { value.trips[0].timezone = 'Not/A_Zone'; },
  ];
  for (const mutate of invalids) { const value = snapshot(seedTrip()); mutate(value); assert.throws(() => parseTripBackup(JSON.stringify(value))); }
});

await check('unsafe property names, prototype pollution and deeply nested payloads are rejected', () => {
  const text = serializeTripBackup([seedTrip()], undefined, stamp);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => parseTripBackup(text.replace('"version": 2', `"${key}": {"polluted": true}, "version": 2`)), /unsafe/);
  }
  const nested = snapshot(seedTrip()); nested.extra = JSON.parse('['.repeat(30) + '0' + ']'.repeat(30));
  assert.throws(() => parseTripBackup(JSON.stringify(nested)), /nested data/);
  const wide = snapshot(seedTrip()); wide.extra = Array(250_001).fill(0);
  assert.throws(() => parseTripBackup(JSON.stringify(wide)), /nested data/);
  assert.equal({}.polluted, undefined);
});

await check('oversized byte payloads and trip counts are rejected before merging', async () => {
  assert.throws(() => parseTripBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), /too large/);
  const value = snapshot(seedTrip()); value.extra = '界'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3));
  assert.throws(() => parseTripBackup(JSON.stringify(value)), /too large/);
  const trips = Array.from({length: 100}, (_, index) => ({...createTrip('Trip ' + index, 'Kyoto', '2027-05-14', 1), id: 'trip-' + index}));
  const before = clone(trips);
  await assert.rejects(() => mergeTripBackup(trips, snapshot(seedTrip())), /exceed 100/);
  assert.deepEqual(trips, before);
  assert.throws(() => createTripBackup([...trips, {...clone(trips[0]), id: 'one-too-many'}]), /up to 100/);
});

await check('empty workspaces can be exported and restored without inventing a sample trip', async () => {
  const file = parseTripBackup(serializeTripBackup([], '', stamp));
  assert.equal(file.activeId, null); assert.deepEqual(file.trips, []);
  const result = await mergeTripBackup([], file);
  assert.deepEqual(result, {trips: [], addedTrips: [], skippedCount: 0, activeId: null});
});

const bookedTrip = () => {
  const trip = seedTrip();
  trip.flights = [{id:'flight-one',fromPlaceId:'nijo',toPlaceId:'gion',departure:{date:'2027-05-14',time:'11:30',timezone:'Europe/London'},arrival:{date:'2027-05-15',time:'07:30',timezone:'Asia/Tokyo',offsetMinutes:540},airline:'Test Air',flightNumber:'TA123',departureTerminal:'T1',arrivalTerminal:'T2',departureGate:'PRIVATE-GATE-1',arrivalGate:'PRIVATE-GATE-2',bookingReference:'PRIVATE-FLIGHT-REF',privateNotes:'PRIVATE-FLIGHT-NOTE',airportBufferMinutes:120,arrivalBufferMinutes:60,groupId:'outbound'}];
  trip.stays = [{id:'stay-one',placeId:'hotel',checkInDate:'2027-05-14',checkOutDate:'2027-05-17',timezone:'Asia/Tokyo',checkInTime:'15:00',checkOutTime:'11:00',bookingReference:'PRIVATE-STAY-REF',contact:'PRIVATE-CONTACT',bookingUrl:'https://example.com/PRIVATE-BOOKING',privateNotes:'PRIVATE-STAY-NOTE'}];
  trip.days[0]={...trip.days[0],timezone:'Europe/London',startPlaceId:'nijo',endStayId:'stay-one',items:[{aid:'flight-activity',placeId:'gion',duration:0,fixed:null,mode:'flight',flightId:'flight-one',note:'Public transfer note'}]};
  trip.days[1].startStayId='stay-one';
  trip.days[1].items=[{aid:'airport-departure',placeId:'nijo',duration:5,fixed:null,mode:'transit',note:'',departureForFlightId:'flight-one'}];
  return trip;
};
await check('v2 private backup round-trips flights, stays, links and exact IDs',()=>{
  const trip=bookedTrip(), file=parseTripBackup(serializeTripBackup([trip],trip.id,stamp));
  assert.equal(file.version,2); assert.deepEqual(file.trips[0],trip);
  file.trips[0].flights[0].departure.time='12:30'; assert.equal(trip.flights[0].departure.time,'11:30');
});
await check('legacy v1 backup upgrades without changing existing activity and day IDs',()=>{
  const trip=seedTrip(); const file=parseTripBackup(JSON.stringify({format:'daytrail-workspace',version:1,exportedAt:stamp,activeId:trip.id,trips:[trip]}));
  assert.equal(file.version,2); assert.deepEqual(file.trips[0],trip);
});
await check('public projection omits booking secrets while retaining useful flight and stay details',()=>{
  const trip=bookedTrip(), before=clone(trip), shared=backup.publicTrip(trip), text=JSON.stringify(shared);
  assert.equal(text.includes('PRIVATE-'),false); assert.equal(isTrip(shared),true); assert.deepEqual(trip,before);
  assert.equal(shared.flights[0].flightNumber,'TA123'); assert.equal(shared.flights[0].departureTerminal,'T1');
  assert.equal(shared.stays[0].checkInTime,'15:00'); assert.equal(shared.days[0].items[0].note,'Public transfer note');
  assert.equal(shared.flights[0].id,trip.flights[0].id);
});
await check('additive booking import preserves linked records but gets an independent trip ID',async()=>{
  const trip=bookedTrip(), result=await mergeTripBackup([],snapshot(trip));
  assert.notEqual(result.addedTrips[0].id,trip.id); assert.deepEqual(result.addedTrips[0].flights,trip.flights);
  assert.equal(result.addedTrips[0].days[0].items[0].flightId,'flight-one');
});
await check('different private booking information is not deduplicated away',async()=>{
  const original=bookedTrip(), changed=clone(original); changed.flights[0].bookingReference='CHANGED';
  const result=await mergeTripBackup([original],snapshot(changed)); assert.equal(result.addedTrips.length,1);
});
await check('invalid flight and stay references fail before changing the workspace',()=>{
  for(const mutate of [t=>t.flights[0].fromPlaceId='missing',t=>t.days[0].items[0].flightId='missing',t=>t.days[0].startPlaceId='hotel',t=>t.stays[0].checkOutDate=t.stays[0].checkInDate,t=>t.stays[0].bookingUrl='javascript:alert(1)',t=>t.flights[0].arbitraryToken='SECRET']) {
    const trip=bookedTrip(); mutate(trip); assert.throws(()=>snapshot(trip));
  }
});

await check('comfort metadata and independently authored offline references round-trip without provider payloads',()=>{
 const value=seedTrip();value.pace='moderate';value.days[0].pace='active';Object.assign(value.days[0].items[0],{meal:'snack',walkingMeters:1200,exposure:'outdoor'});
 value.customPlaces.offline={id:'offline',name:'Provider business',cat:'attr',x:50,y:50,area:'Provider address',typical:'1 h',blurb:'Provider text',lat:35,lng:135,googlePlaceId:'googleOffline',offlineDetails:{name:'My saved name',address:'Entered by me',localAddress:'日本語',hours:'Check venue'}};
 const restored=parseTripBackup(serializeTripBackup([value])).trips[0];assert.equal(restored.pace,'moderate');assert.equal(restored.days[0].pace,'active');assert.equal(restored.days[0].items[0].meal,'snack');assert.equal(restored.days[0].items[0].walkingMeters,1200);assert.equal(restored.days[0].items[0].exposure,'outdoor');
 assert.deepEqual(restored.customPlaces.offline.offlineDetails,value.customPlaces.offline.offlineDetails);assert.equal(restored.customPlaces.offline.name,'Saved place');assert.equal(restored.customPlaces.offline.area,'');assert.equal(restored.customPlaces.offline.lat,undefined);
 restored.customPlaces.offline.offlineDetails.name='Changed';assert.equal(value.customPlaces.offline.offlineDetails.name,'My saved name');
});
console.log(`${assertions} trip-backup tests passed.`);
