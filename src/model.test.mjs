// Run with `node src/model.test.mjs` after installing the app's TypeScript dependency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const model = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const { PLACES, MAX_TRIP_DAYS, seedTrip, createTrip, appendTripDays, getPlaces, dayStartTime, dayStartPlace, formatTime, schedule, travel, proposeOrder, isTrip, persistableTrip } = model;
let assertions = 0;
function check(name, fn) { fn(); assertions += 1; console.log(`✓ ${name}`); }
const activity = (aid, placeId, overrides = {}) => ({ aid, placeId, duration: 60, fixed: null, mode: 'walk', note: '', ...overrides });
const day = (items, overrides = {}) => ({ id: 'test-day', label: 'Day 1', date: 'Fri 14', title: 'Test', endMode: 'walk', items, ...overrides });

check('seed and created trips survive strict JSON restoration', () => {
  assert.equal(isTrip(JSON.parse(JSON.stringify(seedTrip()))), true);
  assert.equal(isTrip(createTrip('City break', 'Edinburgh', '2028-02-28', 3)), true);
  assert.deepEqual(createTrip('Leap year', 'Tokyo', '2028-02-28', 3).days.map(d => d.date), ['Mon 28', 'Tue 29', 'Wed 1']);
  assert.throws(() => createTrip('Invalid', 'Tokyo', '2027-02-29', 3));
  assert.throws(() => createTrip('Invalid', 'Tokyo', '2027-05-14', 31));
});

check('adding days 4 and 5 preserves every existing plan and uses empty-day defaults', () => {
  const trip = seedTrip();
  Object.assign(trip.days[0], { startTime: 600, finishBy: 1200, startPlaceId: 'nijo' });
  const original = structuredClone(trip);
  Object.freeze(trip.days); Object.freeze(trip);
  const extended = appendTripDays(trip, 2);
  assert.notEqual(extended, trip);
  assert.notEqual(extended.days, trip.days);
  assert.deepEqual(trip, original);
  assert.deepEqual(extended.days.slice(0, 3), original.days);
  assert.deepEqual(extended.days.slice(3).map(d => [d.label, d.date]), [['Day 4', 'Mon 17'], ['Day 5', 'Tue 18']]);
  assert.equal(extended.id, trip.id);
  assert.equal(extended.startDate, trip.startDate);
  assert.deepEqual(extended.ideas, trip.ideas);
  assert.deepEqual(extended.customPlaces, trip.customPlaces);
  for (const added of extended.days.slice(3)) {
    assert.equal(added.title, 'A day to discover');
    assert.equal(dayStartTime(added), 540);
    assert.equal(dayStartPlace(added, getPlaces(extended)).id, 'hotel');
    assert.equal(added.endMode, 'walk');
    assert.equal(added.finishBy, null);
    assert.deepEqual(added.items, []);
  }
  assert.notEqual(extended.days[3].items, extended.days[4].items);
});

check('appended dates cross leap days, month boundaries and years correctly', () => {
  for (const [startDate, expected] of [
    ['2028-02-28', ['Mon 28', 'Tue 29', 'Wed 1']],
    ['2027-02-28', ['Sun 28', 'Mon 1', 'Tue 2']],
    ['2027-04-30', ['Fri 30', 'Sat 1', 'Sun 2']],
    ['2028-12-31', ['Sun 31', 'Mon 1', 'Tue 2']],
  ]) {
    const extended = appendTripDays(createTrip('Holiday', 'Kyoto', startDate, 1), 2);
    assert.deepEqual(extended.days.map(d => d.date), expected);
    assert.equal(isTrip(extended), true);
  }
});

check('appended day IDs stay unique across imports and repeated additions', () => {
  const trip = seedTrip();
  trip.days[0].id = 'day-4';
  trip.days[1].id = 'day-4-2';
  trip.days[2].id = 'day-5';
  const extended = appendTripDays(appendTripDays(trip, 1), 1);
  assert.deepEqual(extended.days.map(d => d.id), ['day-4', 'day-4-2', 'day-5', 'day-4-3', 'day-5-2']);
  assert.equal(new Set(extended.days.map(d => d.id)).size, extended.days.length);
  assert.equal(isTrip(extended), true);
});

check('add-day validation enforces whole counts and the shared trip limit', () => {
  const trip = seedTrip();
  for (const count of [0, -1, 0.5, NaN, Infinity, '2', null, undefined]) {
    assert.throws(() => appendTripDays(trip, count), /whole number/);
  }
  const full = appendTripDays(trip, MAX_TRIP_DAYS - trip.days.length);
  assert.equal(full.days.length, MAX_TRIP_DAYS);
  assert.equal(isTrip(full), true);
  assert.throws(() => appendTripDays(full, 1), new RegExp(`up to ${MAX_TRIP_DAYS} days`));
  assert.throws(() => appendTripDays(trip, MAX_TRIP_DAYS), /up to/);
  assert.throws(() => createTrip('Holiday', 'Kyoto', '2027-01-01', MAX_TRIP_DAYS + 1), /Choose between/);
  const invalid = structuredClone(full); invalid.days.push({ ...invalid.days.at(-1), id: 'over-limit' });
  assert.equal(isTrip(invalid), false);
});

check('creation, extension and restoration reject calendar overflow and invalid sources', () => {
  const lastDate = createTrip('Last day', 'Kyoto', '9999-12-31', 1);
  assert.equal(isTrip(lastDate), true);
  assert.throws(() => appendTripDays(lastDate, 1), /end date/);
  assert.throws(() => createTrip('Overflow', 'Kyoto', '9999-12-31', 2), /end date/);
  const invalidEnd = { ...lastDate, days: [...lastDate.days, { ...lastDate.days[0], id: 'next' }] };
  assert.equal(isTrip(invalidEnd), false);
  assert.throws(() => appendTripDays({ ...seedTrip(), startDate: '2027-02-29' }, 1), /invalid trip/);
  assert.throws(() => appendTripDays({ ...seedTrip(), days: [] }, 1), /invalid trip/);
});

check('extended trips survive persisted and share-style JSON restoration with planning intact', () => {
  const trip = seedTrip();
  Object.assign(trip.days[0], { startTime: 600, finishBy: 1200, startPlaceId: 'nijo' });
  trip.customPlaces.airport = { ...PLACES.hotel, id: 'airport', name: 'Provider airport', googlePlaceId: 'ChIJAirport', lat: 35, lng: 135 };
  trip.ideas.push('airport');
  const extended = appendTripDays(trip, 2);
  const restored = JSON.parse(JSON.stringify(persistableTrip(extended)));
  assert.equal(isTrip(restored), true);
  assert.deepEqual(restored.days, extended.days);
  assert.deepEqual(restored.ideas, extended.ideas);
  assert.equal(restored.customPlaces.airport.googlePlaceId, 'ChIJAirport');
  assert.equal(restored.customPlaces.airport.lat, undefined);
  assert.equal(restored.customPlaces.airport.name, 'Saved place');
  assert.deepEqual(appendTripDays(restored, 1).days.at(-1).label, 'Day 6');
});

check('legacy day setup restores with a 09:00 hotel departure without changing stored plans', () => {
  const trip = seedTrip();
  const restored = JSON.parse(JSON.stringify(persistableTrip(trip)));
  assert.equal(isTrip(restored), true);
  assert.equal(dayStartTime(restored.days[0]), 540);
  assert.equal(dayStartPlace(restored.days[0], getPlaces(restored)).id, 'hotel');
  assert.equal(Object.hasOwn(restored.days[0], 'startTime'), false);
  assert.equal(Object.hasOwn(restored.days[0], 'finishBy'), false);
  assert.equal(Object.hasOwn(restored.days[0], 'startPlaceId'), false);
});

check('day timing and alternate departure survive storage without provider content', () => {
  const trip = seedTrip();
  trip.customPlaces.airport = { ...PLACES.hotel, id: 'airport', name: 'Provider airport', googlePlaceId: 'ChIJAirport', lat: 35, lng: 135 };
  Object.assign(trip.days[0], { startTime: 780, finishBy: 1260, startPlaceId: 'airport' });
  const restored = JSON.parse(JSON.stringify(persistableTrip(trip)));
  assert.equal(isTrip(restored), true);
  assert.equal(dayStartTime(restored.days[0]), 780);
  assert.equal(dayStartPlace(restored.days[0], getPlaces(restored)).id, 'airport');
  assert.equal(restored.days[0].finishBy, 1260);
  assert.equal(restored.customPlaces.airport.lat, undefined);
  assert.equal(restored.customPlaces.airport.googlePlaceId, 'ChIJAirport');
  assert.doesNotMatch(JSON.stringify(restored), /Provider airport/);
});

check('departure uses the selected location and time while return stays at the hotel', () => {
  const plan = day([activity('one', 'kiyomizu')], { startTime: 720, startPlaceId: 'fushimi' });
  const result = schedule(plan, PLACES);
  assert.equal(result.rows[0].arrive, 720 + travel(PLACES.fushimi, PLACES.kiyomizu, 'walk').min);
  assert.deepEqual(result.endLeg, travel(PLACES.kiyomizu, PLACES.hotel, 'walk'));
  assert.equal(schedule({ ...plan, items: [] }, PLACES).finish, 720);
  assert.throws(() => dayStartPlace({ ...plan, startPlaceId: 'missing' }, PLACES), /starting point/);
});

check('preferred finish is a soft goal and never truncates visits, bookings or return travel', () => {
  const plan = day([activity('one', 'fushimi', { duration: 180 }), activity('two', 'kiyomizu', { fixed: 1200 })], { startTime: 600 });
  const ordinary = schedule(plan, PLACES);
  const withGoal = schedule({ ...plan, finishBy: 700 }, PLACES);
  assert.deepEqual(withGoal, ordinary);
  assert.ok(withGoal.finish > 700);
});

check('restoration validates departure times, finish goals and starting-place references', () => {
  const invalid = [
    { startTime: null }, { startTime: -1 }, { startTime: 1440 }, { startTime: 600.5 }, { startTime: '09:00' },
    { finishBy: 540 }, { finishBy: 539 }, { finishBy: 1440 }, { finishBy: '17:00' },
    { startTime: 720, finishBy: 720 }, { startTime: 720, finishBy: 700 },
    { startPlaceId: 'missing' }, { startPlaceId: null }, { startPlaceId: 'constructor' }, { startPlaceId: '' },
  ];
  for (const settings of invalid) {
    const trip = seedTrip(); Object.assign(trip.days[0], settings);
    assert.equal(isTrip(trip), false, JSON.stringify(settings));
  }
  for (const settings of [{ startTime: 0, finishBy: 1 }, { startTime: 1439, finishBy: null }, { startPlaceId: 'hotel' }, { startPlaceId: 'fushimi', finishBy: 1439 }]) {
    const trip = seedTrip(); Object.assign(trip.days[0], settings);
    assert.equal(isTrip(trip), true, JSON.stringify(settings));
  }
});

check('seed data is independent between callers and has no placeholder brackets', () => {
  const first = seedTrip(); first.days[0].items[0].note = 'Changed'; first.ideas.pop();
  assert.notEqual(seedTrip().days[0].items[0].note, 'Changed');
  assert.equal(seedTrip().ideas.length, 3);
  assert.doesNotMatch(JSON.stringify(seedTrip()) + JSON.stringify(PLACES), /\[(?:ADDRESS|DURATION|CONFIRMATION|RESTAURANT|CHOOSE)/);
});

check('late reservations keep booked times and propagate feasible departure', () => {
  const plan = day([
    activity('one', 'fushimi', { duration: 300 }),
    activity('two', 'kiyomizu', { fixed: 600, duration: 90 }),
    activity('three', 'sannenzaka'),
  ]);
  const result = schedule(plan, PLACES);
  assert.equal(result.rows[1].start, 600);
  assert.equal(result.rows[1].end, 690);
  assert.ok(result.rows[1].late > 0);
  assert.equal(result.rows[1].physicalEnd, result.rows[1].arrive + 90);
  assert.equal(result.rows[2].arrive, result.rows[1].physicalEnd + result.rows[2].leg.min);
});

check('known early arrivals show waiting; unknown journeys remain uncertain through bookings', () => {
  const known = schedule(day([activity('one', 'fushimi', { fixed: 900 })]), PLACES);
  assert.equal(known.rows[0].wait, 900 - known.rows[0].arrive);
  assert.equal(known.rows[0].approx, false);
  const unknown = schedule(day([
    activity('one', 'tea', { mode: 'transit', fixed: 1000 }),
    activity('two', 'nijo'),
  ]), PLACES);
  assert.equal(unknown.rows[0].leg.min, null);
  assert.equal(unknown.rows[0].start, 1000);
  assert.equal(unknown.rows[0].wait, 0);
  assert.equal(unknown.rows[0].approx, true);
  assert.equal(unknown.rows[1].approx, true);
  assert.equal(unknown.finishApprox, true);
  assert.equal(unknown.unknown, 1);
});

check('return journeys contribute time and uncertainty, including empty days', () => {
  const empty = schedule(day([]), PLACES);
  assert.equal(empty.finish, 540); assert.equal(empty.travel, 0);
  const plan = day([activity('one', 'tea', { mode: 'drive' })], { endMode: 'transit' });
  const result = schedule(plan, PLACES);
  assert.equal(result.rows[0].approx, false);
  assert.equal(result.endLeg.min, null);
  assert.equal(result.unknown, 1);
  assert.equal(result.finishApprox, true);
  assert.equal(travel(PLACES.hotel, PLACES.hotel, 'transit').min, 0);
});

check('live route durations replace sample estimates and retain route metadata', () => {
  const plan = day([activity('one', 'fushimi', { duration: 120 }), activity('two', 'kiyomizu', { duration: 90, fixed: 840 })]);
  const legs = {
    one: { min: 23, km: '4.2', mode: 'walk', status: 'ready', path: [{ lat: 35, lng: 135 }], warning: 'Use pedestrian crossings.' },
    two: { min: 37, km: '6.1', mode: 'walk', status: 'ready' },
    return: { min: 18, km: '3.0', mode: 'walk', status: 'ready' },
  };
  const result = schedule(plan, PLACES, legs);
  assert.equal(result.rows[0].arrive, 563);
  assert.equal(result.rows[1].arrive, 720);
  assert.equal(result.rows[1].wait, 120);
  assert.equal(result.finish, 948);
  assert.equal(result.travel, 78);
  assert.equal(result.unknown, 0);
  assert.equal(result.rows[0].leg, legs.one);
  assert.equal(result.endLeg, legs.return);
});

check('missing, stale and invalid live routes stay unknown without synthetic fallback', () => {
  const plan = day([activity('one', 'fushimi'), activity('two', 'kiyomizu', { fixed: 900 })]);
  const missing = schedule(plan, PLACES, { two: { min: 30, km: '2', mode: 'walk', status: 'ready' } });
  assert.equal(missing.rows[0].leg.min, null);
  assert.equal(missing.rows[0].leg.status, 'loading');
  assert.equal(missing.rows[0].arrive, 540);
  assert.equal(missing.travel, 30);
  assert.equal(missing.unknown, 2);
  assert.equal(missing.rows[1].wait, 0);
  assert.equal(missing.rows[1].approx, true);
  assert.equal(missing.finishApprox, true);
  for (const leg of [
    { min: 12, km: '1', mode: 'drive', status: 'ready' },
    { min: 12, km: '1', mode: 'walk', status: 'loading' },
    { min: 12, km: '1', mode: 'walk', status: 'unavailable' },
    { min: -1, km: '1', mode: 'walk', status: 'ready' },
    { min: NaN, km: '1', mode: 'walk', status: 'ready' },
    { min: Infinity, km: '1', mode: 'walk', status: 'ready' },
  ]) {
    const result = schedule(plan, PLACES, { one: leg });
    assert.equal(result.rows[0].leg.min, null);
    assert.equal(result.travel, 0);
    assert.equal(result.unknown, 3);
  }
  const empty = schedule(day([]), PLACES, {});
  assert.equal(empty.travel, 0);
  assert.equal(empty.unknown, 0);
  assert.equal(empty.finish, 540);
  assert.equal(empty.finishApprox, false);
  assert.equal(empty.endLeg.min, 0);
});

check('overnight times cannot masquerade as same-day times', () => {
  assert.equal(formatTime(1439), '23:59');
  assert.equal(formatTime(1440), '00:00 +1d');
  assert.equal(formatTime(2945), '01:05 +2d');
});

check('optimisation shortens the sample walking/driving day without mutating the source', () => {
  const trip = seedTrip(); const source = structuredClone(trip.days[2]);
  const proposal = proposeOrder(trip.days[2], getPlaces(trip));
  assert.ok(proposal); assert.ok(proposal.saved >= 2);
  assert.equal(proposal.before - proposal.after, proposal.saved);
  assert.deepEqual(trip.days[2], source);
  assert.deepEqual(proposal.items.map(x => x.aid).sort(), source.items.map(x => x.aid).sort());
  assert.equal(proposeOrder(trip.days[0], PLACES), null);
});

check('fixed reservations divide uncrossable optimisation runs', () => {
  const plan = day([
    activity('one', 'heian'), activity('two', 'ginkakuji'),
    activity('booking', 'pontocho', { fixed: 1200 }),
    activity('three', 'nanzenji'), activity('four', 'philosopher'),
  ]);
  const proposed = proposeOrder(plan, PLACES);
  assert.ok(proposed);
  assert.equal(proposed.items[2].aid, 'booking');
  assert.deepEqual(proposed.items.slice(0, 2).map(x => x.aid).sort(), ['one', 'two']);
  assert.deepEqual(proposed.items.slice(3).map(x => x.aid).sort(), ['four', 'three']);
  const before = schedule(plan, PLACES);
  const after = schedule({ ...plan, items: proposed.items }, PLACES);
  for (const row of after.rows) assert.ok(row.late <= before.rows.find(old => old.it.aid === row.it.aid).late);
});

check('optimisation is bounded for large days', () => {
  const items = Array.from({ length: 9 }, (_, i) => activity(`large-${i}`, i % 2 ? 'heian' : 'gion'));
  assert.equal(proposeOrder(day(items), PLACES), null);
});

check('sample optimiser never claims savings for a live-route itinerary', () => {
  const plan = seedTrip().days[2];
  assert.ok(proposeOrder(plan, PLACES));
  assert.equal(proposeOrder(plan, PLACES, {}), null);
  assert.equal(proposeOrder(plan, { ...PLACES, heian: { ...PLACES.heian, lat: 35, lng: 135 } }), null);
  assert.equal(proposeOrder(plan, { ...PLACES, hotel: { ...PLACES.hotel, googlePlaceId: 'ChIJExample' } }), null);
});

check('live place metadata validates and provider content is removed from persisted trips', () => {
  const trip = seedTrip();
  const googlePlace = {
    id: 'google-ChIJExample', name: 'Provider place name', cat: 'attr', x: 40, y: 60,
    area: 'Provider street address', typical: '1 h', blurb: 'Provider description',
    lat: 35, lng: 135, googlePlaceId: 'ChIJExample', googleMapsURI: 'https://maps.google.com/?cid=123',
    attributions: [{ provider: 'Example provider', providerURI: 'https://example.com/attribution' }],
  };
  trip.customPlaces[googlePlace.id] = googlePlace;
  trip.customPlaces.hotel = { ...googlePlace, id: 'hotel', cat: 'custom' };
  trip.customPlaces.personal = { ...PLACES.hotel, id: 'personal', name: 'My picnic spot', blurb: 'Under the big tree.', lat: 35.5, lng: 135.5 };
  trip.ideas.push(googlePlace.id);
  trip.days[0].items.push(activity('new-live-visit', googlePlace.id, { duration: 90, fixed: 1200, note: 'Bring tickets.' }));
  assert.equal(isTrip(trip), true);
  const stored = persistableTrip(trip);
  assert.equal(isTrip(JSON.parse(JSON.stringify(stored))), true);
  assert.deepEqual(stored.customPlaces[googlePlace.id], {
    id: googlePlace.id, name: 'Saved place', cat: 'attr', x: 50, y: 50, area: '', typical: '1 h', blurb: '', googlePlaceId: 'ChIJExample',
  });
  assert.equal(stored.customPlaces.hotel.name, 'Your stay');
  assert.deepEqual(stored.customPlaces.personal, trip.customPlaces.personal);
  assert.deepEqual(stored.days, trip.days);
  assert.deepEqual(stored.ideas, trip.ideas);
  assert.equal(trip.customPlaces[googlePlace.id].name, 'Provider place name');
  assert.notEqual(stored.days[0].items[0], trip.days[0].items[0]);
  assert.notEqual(stored.customPlaces.personal, trip.customPlaces.personal);
  assert.doesNotMatch(JSON.stringify(stored), /Provider place name|Provider street address|Provider description|maps\.google|Example provider/);
});

check('restoration rejects invalid coordinates, provider IDs and attribution links', () => {
  const base = { ...PLACES.hotel, id: 'google-test' };
  const invalid = [
    { lat: 35 }, { lng: 135 }, { lat: NaN, lng: 135 }, { lat: 91, lng: 135 }, { lat: 35, lng: -181 },
    { lat: null, lng: 135 }, { lat: 35, lng: Infinity },
    { googlePlaceId: '' }, { googlePlaceId: 'bad id' }, { googlePlaceId: 'x'.repeat(513) },
    { googleMapsURI: 'javascript:alert(1)' }, { googleMapsURI: 'http://maps.google.com/' }, { googleMapsURI: 'https://user:pass@example.com/' },
    { attributions: [{ provider: 'Name', providerURI: 'data:text/html,hi' }] },
    { attributions: [{ provider: '', providerURI: 'https://example.com/' }] },
    { attributions: [null] }, { attributions: 'Invalid' },
    { userLabel: 'x'.repeat(161) }, { userLabel: null },
    { userNotes: 'x'.repeat(4001) }, { userNotes: 12 },
  ];
  for (const fields of invalid) {
    const trip = seedTrip(); trip.customPlaces[base.id] = { ...base, ...fields };
    assert.equal(isTrip(trip), false, JSON.stringify(fields));
  }
  const boundaries = seedTrip(); boundaries.customPlaces[base.id] = { ...base, lat: -90, lng: 180, attributions: [{ provider: 'Name' }] };
  assert.equal(isTrip(boundaries), true);
});

check('linking a custom place retains its user label, notes and default duration in saved data', () => {
  const trip = seedTrip();
  const id = 'google-personal';
  trip.customPlaces[id] = {
    ...PLACES.hotel, id, name: 'Provider venue name', blurb: 'Provider description',
    googlePlaceId: 'ChIJPersonal', lat: 35, lng: 135,
    userLabel: 'Birthday lunch', userNotes: 'Ask for the table by the window.', typical: '90 min',
  };
  trip.ideas.push(id);
  const stored = persistableTrip(trip);
  assert.equal(stored.customPlaces[id].name, 'Saved place');
  assert.equal(stored.customPlaces[id].blurb, '');
  assert.equal(stored.customPlaces[id].lat, undefined);
  assert.equal(stored.customPlaces[id].userLabel, 'Birthday lunch');
  assert.equal(stored.customPlaces[id].userNotes, 'Ask for the table by the window.');
  assert.equal(stored.customPlaces[id].typical, '90 min');
  assert.equal(isTrip(JSON.parse(JSON.stringify(stored))), true);
  trip.customPlaces[id].userNotes = '';
  assert.equal(persistableTrip(trip).customPlaces[id].userNotes, '');
});

check('restoration rejects corrupt nested data, duplicate IDs, invalid dates and prototype keys', () => {
  const corruptions = [
    t => { t.days[0].items[0].duration = -2; },
    t => { t.days[0].items[0].duration = Infinity; },
    t => { t.days[0].items[0].fixed = 1440; },
    t => { t.days[0].items[0].fixed = undefined; },
    t => { t.days[0].items[0].placeId = 'missing'; },
    t => { t.days[1].items[0].aid = t.days[0].items[0].aid; },
    t => { t.days[1].id = t.days[0].id; },
    t => { t.days[0].endMode = 'plane'; },
    t => { t.ideas.push(t.ideas[0]); },
    t => { t.ideas.push('constructor'); },
    t => { t.startDate = '2027-02-29'; },
    t => { t.timezone = 'Not/A-Timezone'; },
    t => { t.customPlaces = JSON.parse('{"__proto__":{"id":"__proto__"}}'); },
    t => { t.customPlaces.bad = { ...PLACES.hotel, id: 'bad', x: NaN }; },
  ];
  for (const mutate of corruptions) { const trip = seedTrip(); mutate(trip); assert.equal(isTrip(trip), false); }
  assert.equal(isTrip(null), false); assert.equal(isTrip([]), false);
});

console.log(`\n${assertions} planning model checks passed.`);
