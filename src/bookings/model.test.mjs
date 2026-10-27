import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const modelURL = url(compile('../model.ts'));
const openingURL = url(compile('../openingHours.ts'));
const visitURL = url(compile('../visitHours.ts').replace(/from ['"]\.\/openingHours['"]/g, `from ${JSON.stringify(openingURL)}`));
const model = await import(modelURL);
const planningURL = url(compile('../hoursPlanning.ts').replace(/from ['\"]\.\/model['\"]/g, `from ${JSON.stringify(modelURL)}`).replace(/from ['\"]\.\/visitHours['\"]/g, `from ${JSON.stringify(visitURL)}`));
const serviceURL = url(compile('../googleMaps.ts').replaceAll('import.meta.env', '({})'));
const routes = await import(url(compile('../useLiveRoutes.ts').replace(/from ['"]react['"]/g, `from ${JSON.stringify(import.meta.resolve('react'))}`).replace(/from ['"]\.\/model['"]/g, `from ${JSON.stringify(modelURL)}`).replace(/from ['"]\.\/visitHours['"]/g, `from ${JSON.stringify(visitURL)}`).replace(/from ['"]\.\/hoursPlanning['"]/g, `from ${JSON.stringify(planningURL)}`).replace(/from ['"]\.\/googleMaps['"]/g, `from ${JSON.stringify(serviceURL)}`)));
const { computeJourney } = await import(serviceURL);
const { isFlight, isStay, resolveFlightMoment, flightTiming, isTrip, createTrip, getPlaces, schedule, flightJourney, flightsForDay, staysForDay, accommodationSuggestions, applyAccommodationSuggestions, proposeOrder, travel } = model;
let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log(`✓ ${name}`); };
const moment = (date, time, timezone = 'Europe/London', extra = {}) => ({ date, time, timezone, ...extra });
const flight = extra => ({ id: 'flight1', fromPlaceId: 'lhr', toPlaceId: 'jfk', departure: moment('2026-11-01', '10:00'), arrival: moment('2026-11-01', '13:00', 'America/New_York'), airportBufferMinutes: 120, arrivalBufferMinutes: 60, ...extra });
const place = id => ({ id, name: id.toUpperCase(), cat: 'custom', area: '', typical: '', blurb: '', x: 50, y: 50 });
const fixture = () => {
  const trip = createTrip('Flight test', 'New York', '2026-11-01', 4);
  trip.timezone = 'Europe/London'; trip.customPlaces.lhr = place('lhr'); trip.customPlaces.jfk = place('jfk');
  trip.customPlaces.stayA = place('stayA'); trip.customPlaces.stayB = place('stayB');
  trip.flights = [flight()];
  trip.days[0] = { ...trip.days[0], startPlaceId: 'lhr', endPlaceId: 'jfk', endMode: 'flight', endFlightId: 'flight1', startTime: 480 };
  return trip;
};
const stay = extra => ({ id: 'stay1', placeId: 'stayA', checkInDate: '2026-11-01', checkOutDate: '2026-11-03', timezone: 'America/New_York', ...extra });
await check('flight duration uses actual instants across airport time zones', () => {
  const result = flightTiming(flight());
  assert.equal(result.status, 'ready'); assert.equal(result.durationMinutes, 480);
  assert.equal(new Date(result.departureGoalMs).toISOString(), '2026-11-01T08:00:00.000Z');
  assert.equal(new Date(result.arrivalReadyMs).toISOString(), '2026-11-01T19:00:00.000Z');
});
await check('overnight flights retain their next-day arrival', () => {
  const result = flightTiming(flight({ departure: moment('2026-11-01','22:00'), arrival: moment('2026-11-02','07:00','Asia/Tokyo') }));
  assert.equal(result.status,'invalid');
  const valid = flightTiming(flight({ departure: moment('2026-11-01','22:00'), arrival: moment('2026-11-02','20:00','Asia/Tokyo') }));
  assert.equal(valid.durationMinutes,780);
});
await check('date-line westbound arrival may be on the previous local date', () => {
  const result = flightTiming(flight({ departure: moment('2026-11-02','00:30','Pacific/Auckland'), arrival: moment('2026-11-01','16:30','America/Los_Angeles') }));
  assert.equal(result.status, 'ready'); assert.equal(result.durationMinutes,780);
});
await check('missing times remain incomplete without invented duration', () => {
  assert.equal(flightTiming(flight({ departure: moment('2026-11-01',null) })).durationMinutes,null);
  assert.equal(resolveFlightMoment(moment('2026-11-01',null)).status,'incomplete');
});
await check('DST gap is invalid and repeated local hour requires explicit offset', () => {
  assert.equal(resolveFlightMoment(moment('2026-03-29','01:30')).status,'invalid');
  const repeated = resolveFlightMoment(moment('2026-10-25','01:30'));
  assert.equal(repeated.status,'ambiguous'); assert.deepEqual(repeated.candidates.map(c=>c.offsetMinutes),[60,0]);
  assert.equal(resolveFlightMoment(moment('2026-10-25','01:30','Europe/London',{offsetMinutes:0})).timestamp,Date.parse('2026-10-25T01:30:00Z'));
  assert.equal(resolveFlightMoment(moment('2026-10-25','01:30','Europe/London',{offsetMinutes:120})).status,'invalid');
});
await check('half-hour time zones and half-hour DST changes are supported', () => {
  assert.equal(new Date(resolveFlightMoment(moment('2026-11-01','10:00','Asia/Kolkata')).timestamp).toISOString(),'2026-11-01T04:30:00.000Z');
  assert.equal(resolveFlightMoment(moment('2026-04-05','01:45','Australia/Lord_Howe')).status,'ambiguous');
});
await check('nonpositive and implausible flight duration is rejected as timing', () => {
  assert.equal(flightTiming(flight({ arrival: moment('2026-11-01','09:00') })).status,'invalid');
  assert.equal(flightTiming(flight({ arrival: moment('2026-11-05','10:00') })).status,'invalid');
});
await check('strict flight validation bounds fields and rejects unknown keys', () => {
  assert.equal(isFlight(flight()),true);
  for (const patch of [{ fromPlaceId:'jfk' },{airline:'x'.repeat(161)},{airportBufferMinutes:-1},{privateNotes:'x'.repeat(8001)},{unknown:true},{departure:moment('2026-02-30','10:00')},{arrival:moment('2026-11-01','13:00','Not/AZone')}]) assert.equal(isFlight(flight(patch)),false);
  assert.equal(isFlight(flight({departure:moment('2026-03-29','01:30')})),true,'uncertain timing can be saved for confirmation');
});
await check('strict stay validation uses exclusive valid check-out and safe links', () => {
  assert.equal(isStay(stay()),true);
  for (const patch of [{checkOutDate:'2026-11-01'},{checkOutDate:'2027-11-03'},{checkInTime:null},{checkOutTime:'25:00'},{bookingUrl:'javascript:alert(1)'},{contact:'x'.repeat(501)},{unknown:true}]) assert.equal(isStay(stay(patch)),false);
});
await check('linked direct airport-to-airport trip is valid and survives persistence', () => {
  const trip=fixture(); assert.equal(isTrip(trip),true);
  assert.equal(isTrip(JSON.parse(JSON.stringify(model.persistableTrip(trip)))),true);
});
await check('dangling, mismatched, duplicate and ground-mode flight links reject', () => {
  for (const change of [t=>t.days[0].endFlightId='missing',t=>t.days[0].endPlaceId='stayA',t=>t.days[0].endMode='drive',t=>t.days[0].endFlightId=undefined,t=>t.days[1]={...t.days[0],id:'other'}]) {
    const trip=fixture(); change(trip); assert.equal(isTrip(trip),false);
  }
});
await check('unknown booking places and duplicate booking identities reject', () => {
  const trip=fixture(); trip.flights[0].fromPlaceId='missing'; assert.equal(isTrip(trip),false);
  const other=fixture(); other.flights.push(flight()); assert.equal(isTrip(other),false);
});
await check('unlinked flight bookings are valid without rewriting the itinerary', () => {
  const trip=fixture(); trip.days[0].endMode='walk'; delete trip.days[0].endFlightId; assert.equal(isTrip(trip),true);
});
await check('flight journeys bypass illustrative and Google ground estimates', async () => {
  assert.equal(travel(place('a'),place('b'),'flight').min,null);
  const result = await computeJourney({...place('a'),lat:1,lng:2},{...place('b'),lat:1,lng:2},'flight');
  assert.equal(result.status,'unavailable'); assert.equal(result.min,null);
  assert.equal(flightJourney(flight(),'other','jfk').min,null);
});
await check('direct flight schedule waits for departure and applies arrival buffer once', () => {
  const trip=fixture(), sc=schedule(trip.days[0],getPlaces(trip),{}, {trip,dayIndex:0});
  assert.equal(sc.travel,480); assert.equal(sc.finish,1140); assert.equal(sc.wait,120); assert.equal(sc.unknown,0); assert.equal(sc.late,0);
});
await check('flight in the middle of a day fixes arrival and grounds subsequent journeys', async () => {
  const trip=fixture(), day=trip.days[0];
  day.endPlaceId='stayA'; day.endMode='walk'; delete day.endFlightId;
  day.items=[{aid:'arrival',placeId:'jfk',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''}];
  const places=getPlaces(trip); places.jfk={...places.jfk,lat:40,lng:-73}; places.stayA={...places.stayA,lat:40.1,lng:-73};
  const calls=[];
  const legs=await routes.calculateDayRoutes({date:'2026-11-01',timezone:trip.timezone,day,places,flights:trip.flights},()=>{},()=>true,async(a,b,mode)=>{calls.push([a.id,b.id,mode]); return {mode,min:30,km:'10',status:'ready'};});
  assert.deepEqual(calls,[['jfk','stayA','walk']]);
  const sc=schedule(day,places,legs,{trip,dayIndex:0});
  assert.equal(sc.rows[0].arrive,1080); assert.equal(sc.rows[0].physicalEnd,1140); assert.equal(sc.finish,1170); assert.equal(sc.travel,510);
});
await check('postflight transit requests use the scheduled arrival plus exit buffer', async () => {
  const trip=fixture(),day=trip.days[0];
  day.endMode='transit';day.endPlaceId='stayA';delete day.endFlightId;
  day.items=[{aid:'arrival',placeId:'jfk',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''}];
  const places=getPlaces(trip); places.jfk={...places.jfk,lat:40,lng:-73};places.stayA={...places.stayA,lat:40.1,lng:-73};
  let departure;
  await routes.calculateDayRoutes({date:'2026-11-01',timezone:trip.timezone,day,places,flights:trip.flights},()=>{},()=>true,async(a,b,mode,date)=>{departure=date;return {mode,min:30,km:'10',status:'ready'};},Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(departure.toISOString(),'2026-11-01T19:00:00.000Z');
});
await check('late arrival at a departure airport flags uncertainty without moving flight times', () => {
  const trip=fixture(); trip.days[0].startTime=660;
  const sc=schedule(trip.days[0],getPlaces(trip),{}, {trip,dayIndex:0});
  assert.equal(sc.late,180); assert.equal(sc.finish,1140); assert.equal(sc.finishApprox,true);
});
await check('missing flight times keep downstream transit unknown and make no requests', async () => {
  const trip=fixture();trip.flights[0].arrival.time=null;
  const input=JSON.parse(routes.routeInputSignature(trip,0,getPlaces(trip)));
  let calls=0;const legs=await routes.calculateDayRoutes(input,()=>{},()=>true,async()=>{calls++;throw new Error('must not call');});
  assert.equal(calls,0);assert.equal(legs.return.min,null);
});
await check('route signature uses day zone and refreshes flight timing without private notes', () => {
  const trip=fixture(),places=getPlaces(trip);const a=routes.routeInputSignature(trip,0,places);
  trip.flights[0].privateNotes='private';trip.flights[0].bookingReference='secret';assert.equal(routes.routeInputSignature(trip,0,places),a);
  trip.flights[0].arrival.time='14:00';assert.notEqual(routes.routeInputSignature(trip,0,places),a);
  trip.days[0].timezone='America/New_York';assert.equal(JSON.parse(routes.routeInputSignature(trip,0,places)).timezone,'America/New_York');
});
await check('static route reuse never reuses a changed scheduled flight', () => {
  const trip=fixture(),places=getPlaces(trip),first=JSON.parse(routes.routeInputSignature(trip,0,places));
  const legs=routes.pendingLegs(first);trip.flights[0].arrival.time='14:00';
  const next=routes.reuseReadyStaticLegs(JSON.parse(routes.routeInputSignature(trip,0,places)),first,legs);
  assert.equal(next.return.min,540);
});
await check('flight days cannot use sample route reordering', () => {
  const trip=fixture();assert.equal(proposeOrder(trip.days[0],getPlaces(trip)),null);
});
await check('one overnight booking appears on departure and arrival days without duplication', () => {
  const trip=fixture();trip.flights[0].arrival=moment('2026-11-02','06:00','Asia/Tokyo');
  assert.equal(flightsForDay(trip,0)[0].departure,true);assert.equal(flightsForDay(trip,0)[0].arrival,false);
  assert.equal(flightsForDay(trip,1)[0].arrival,true);assert.equal(flightsForDay(trip,1)[0].flight.id,'flight1');
});
await check('stay change day starts at previous night and ends at the coming night', () => {
  const trip=fixture();trip.stays=[stay(),stay({id:'stay2',placeId:'stayB',checkInDate:'2026-11-03',checkOutDate:'2026-11-05'})];
  const suggestion=accommodationSuggestions(trip)[2];
  assert.equal(suggestion.startPlaceId,'stayA');assert.equal(suggestion.endPlaceId,'stayB');
  const old=staysForDay(trip,2).find(item=>item.stay.id==='stay1');assert.equal(old.checkOut,true);assert.equal(old.overnight,false);
});
await check('applying stay suggestions preserves explicit airport endpoints and uses preview selection', () => {
  const trip=fixture();trip.stays=[stay()];
  const next=applyAccommodationSuggestions(trip,[trip.days[0].id,trip.days[1].id]);
  assert.equal(next.days[0].startPlaceId,'lhr');assert.equal(next.days[0].endPlaceId,'jfk');
  assert.equal(next.days[1].startStayId,'stay1');assert.equal(next.days[1].endStayId,'stay1');
  assert.equal(trip.days[1].startStayId,undefined);assert.equal(next.days[2].startStayId,undefined);
  assert.equal(isTrip(next),true);
});
await check('overlapping stays and missing nights surface warnings without choosing arbitrarily', () => {
  const trip=fixture();trip.stays=[stay(),stay({id:'stay2',placeId:'stayB'})];
  const overlap=accommodationSuggestions(trip)[1];assert.equal(overlap.startStayId,undefined);assert.equal(overlap.endStayId,undefined);assert.ok(overlap.warnings.some(text=>text.includes('Overlapping')));
  assert.ok(accommodationSuggestions(trip)[2].warnings.some(text=>text.includes('No accommodation')));
});
await check('stay source markers and departure anchors reject stale references', () => {
  const trip=fixture();trip.stays=[stay()];trip.days[1].startStayId='stay1';assert.equal(isTrip(trip),false);
  trip.days[1].startPlaceId='stayA';assert.equal(isTrip(trip),true);
  trip.days[1].items=[{aid:'depart',placeId:'lhr',mode:'walk',duration:120,fixed:null,note:'',departureForFlightId:'flight1'}];assert.equal(isTrip(trip),true);
  trip.days[1].items[0].placeId='jfk';assert.equal(isTrip(trip),false);
});
await check('destination visit hours after a flight use arrival-zone clocks', () => {
  const trip=fixture(), day=trip.days[0];
  day.endMode='walk';day.endPlaceId='stayA';delete day.endFlightId;
  day.items=[{aid:'arrival',placeId:'jfk',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''},{aid:'museum',placeId:'stayB',duration:60,fixed:null,mode:'walk',note:''}];
  const sc=schedule(day,getPlaces(trip),{museum:{mode:'walk',min:30,km:'2',status:'ready'},return:{mode:'walk',min:10,km:'1',status:'ready'}},{trip,dayIndex:0});
  assert.equal(sc.rows[1].start,1170);
  assert.deepEqual(model.scheduleVisitWindow(sc.rows[1],'2026-11-01'),{date:'2026-11-01',start:870,end:930,approx:false});
});
await check('postflight transit retains the selected second DST occurrence', async () => {
  const trip=fixture(), day=trip.days[0]; trip.timezone='America/New_York';day.startTime=0;
  trip.flights[0]=flight({departure:moment('2026-11-01','00:30','America/New_York'),arrival:moment('2026-11-01','01:30','America/New_York',{offsetMinutes:-300}),airportBufferMinutes:0,arrivalBufferMinutes:0});
  day.endMode='transit';day.endPlaceId='stayA';delete day.endFlightId;
  day.items=[{aid:'arrival',placeId:'jfk',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''}];
  const places=getPlaces(trip);places.jfk={...places.jfk,lat:40,lng:-73};places.stayA={...places.stayA,lat:40.1,lng:-73};let depart;
  await routes.calculateDayRoutes({date:'2026-11-01',timezone:trip.timezone,day,places,flights:trip.flights},()=>{},()=>true,async(a,b,mode,date)=>{depart=date;return {mode,min:30,km:'2',status:'ready'};},Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(depart.toISOString(),'2026-11-01T06:30:00.000Z');
});
await check('arrival-day routes stay unknown until an airport start after landing is confirmed', async () => {
  const trip=fixture();trip.flights[0]=flight({departure:moment('2026-11-01','22:00'),arrival:moment('2026-11-02','08:00','America/New_York')});
  trip.days[1].items=[{aid:'museum',placeId:'stayB',mode:'walk',duration:60,fixed:null,note:''}];
  const places=getPlaces(trip);for(const place of Object.values(places)){place.lat=40;place.lng=-73;}
  assert.ok(model.incomingFlightStartIssue(trip,1));
  const input=JSON.parse(routes.routeInputSignature(trip,1,places));let calls=0;
  const legs=await routes.calculateDayRoutes(input,()=>{},()=>true,async()=>{calls++;throw Error('No premature route request');});
  assert.equal(calls,0);assert.equal(legs.museum.min,null);
  const sc=schedule(trip.days[1],places,{museum:{mode:'walk',min:5,km:'1',status:'ready'},return:{mode:'walk',min:5,km:'1',status:'ready'}},{trip,dayIndex:1});
  assert.equal(sc.rows[0].leg.min,null);assert.equal(sc.rows[0].approx,true);
  trip.days[1].startPlaceId='jfk';trip.days[1].timezone='America/New_York';trip.days[1].startTime=540;
  assert.equal(model.incomingFlightStartIssue(trip,1),null);
  trip.days[1].startTime=539;assert.ok(model.incomingFlightStartIssue(trip,1));
  trip.days[1].startTime=600;assert.equal(model.incomingFlightStartIssue(trip,1),null,'later manual departure remains accepted');
});
await check('incoming flight timing edits invalidate previously confirmed arrival-day routes', () => {
  const trip=fixture();trip.flights[0]=flight({departure:moment('2026-11-01','22:00'),arrival:moment('2026-11-02','08:00','America/New_York')});
  Object.assign(trip.days[1],{startPlaceId:'jfk',timezone:'America/New_York',startTime:540});
  assert.equal(model.incomingFlightStartIssue(trip,1),null);
  const signature=routes.routeInputSignature(trip,1,getPlaces(trip));
  trip.flights[0].arrival.time='10:00';assert.ok(model.incomingFlightStartIssue(trip,1));
  assert.notEqual(routes.routeInputSignature(trip,1,getPlaces(trip)),signature);
  trip.flights[0].arrival.time=null;assert.match(model.incomingFlightStartIssue(trip,1),/Confirm/);
});
await check('existing departure-airport stop is checked against the airport arrival goal', () => {
  const trip=fixture(),day=trip.days[0];day.startTime=540;
  day.items=[{aid:'airport',placeId:'lhr',mode:'walk',duration:5,fixed:null,note:''}];
  const sc=schedule(day,getPlaces(trip),{airport:{mode:'walk',status:'ready',min:0,km:'0'}},{trip,dayIndex:0});
  assert.equal(sc.rows[0].arrive,540);assert.equal(sc.late,60);assert.equal(sc.finishApprox,true);
});
await check('a zero airport buffer does not add an artificial five-minute missed flight', async () => {
  const trip=fixture(),day=trip.days[0];trip.flights[0].airportBufferMinutes=0;day.startTime=540;
  day.items=[{aid:'airport',placeId:'lhr',mode:'walk',duration:5,fixed:600,note:'',departureForFlightId:'flight1'}];
  const sc=schedule(day,getPlaces(trip),{airport:{mode:'walk',status:'ready',min:0,km:'0'}},{trip,dayIndex:0});
  assert.equal(sc.rows[0].physicalEnd,600);assert.equal(sc.late,0);assert.equal(sc.finishApprox,false);
  const places=getPlaces(trip);places.lhr={...places.lhr,lat:51,lng:0};
  const input=JSON.parse(routes.routeInputSignature(trip,0,places));
  const result=await routes.calculateDayRoutes(input,()=>{},()=>true,async(a,b,mode)=>({mode,min:0,km:'0',status:'ready'}));
  assert.equal(result.return.min,480);
});
await check('a later wall clock before a repeated-hour departure is not falsely late', () => {
  const trip=fixture(),day=trip.days[0];trip.timezone='America/New_York';day.startTime=30;
  trip.flights[0]=flight({departure:moment('2026-11-01','01:30','America/New_York',{offsetMinutes:-300}),arrival:moment('2026-11-01','04:30','America/New_York'),airportBufferMinutes:0,arrivalBufferMinutes:0});
  day.items=[{aid:'airport',placeId:'lhr',mode:'walk',duration:80,fixed:null,note:''}];
  const sc=schedule(day,getPlaces(trip),{airport:{mode:'walk',status:'ready',min:0,km:'0'}},{trip,dayIndex:0});
  assert.equal(sc.rows[0].physicalEnd,110);assert.equal(sc.late,0);assert.equal(sc.wait,40);assert.equal(sc.finishApprox,false);
});
await check('a same-day flight with a midnight exit buffer continues onto the ready date', () => {
  const trip=fixture();trip.timezone='America/New_York';
  trip.flights[0]=flight({departure:moment('2026-11-01','18:00','America/New_York'),arrival:moment('2026-11-01','23:30','America/New_York'),arrivalBufferMinutes:60});
  assert.equal(flightsForDay(trip,0)[0].arrival,true);
  const continuation=flightsForDay(trip,1)[0];
  assert.equal(continuation.flight.id,'flight1');assert.equal(continuation.departure,false);assert.equal(continuation.arrival,false);assert.equal(continuation.continuation,true);
  assert.ok(model.incomingFlightStartIssue(trip,1));
  Object.assign(trip.days[1],{startPlaceId:'jfk',timezone:'America/New_York',startTime:30});
  assert.equal(model.incomingFlightStartIssue(trip,1),null);
  trip.days[1].startTime=29;assert.ok(model.incomingFlightStartIssue(trip,1));
  assert.equal(flightsForDay(trip,2).length,0);
});
await check('overnight arrival with a midnight buffer gates both arrival and ready days', async () => {
  const trip=fixture();trip.flights[0]=flight({departure:moment('2026-11-01','22:00'),arrival:moment('2026-11-02','23:30','America/New_York'),arrivalBufferMinutes:60});
  const days=[1,2];for(const index of days)assert.ok(model.incomingFlightStartIssue(trip,index));
  const readyProjection=flightsForDay(trip,2)[0];assert.equal(readyProjection.continuation,true);assert.equal(readyProjection.arrival,false);
  let calls=0;await routes.calculateDayRoutes(JSON.parse(routes.routeInputSignature(trip,2,getPlaces(trip))),()=>{},()=>true,async()=>{calls++;throw Error('Premature request');});assert.equal(calls,0);
  Object.assign(trip.days[2],{startPlaceId:'jfk',timezone:'America/New_York',startTime:30});assert.equal(model.incomingFlightStartIssue(trip,2),null);
  Object.assign(trip.days[1],{startPlaceId:'jfk',timezone:'America/New_York',startTime:1439});assert.ok(model.incomingFlightStartIssue(trip,1));
});
const plannedMidnightTransfer = () => {
  const trip=fixture();trip.timezone='Europe/Dublin';
  trip.flights[0]=flight({departure:moment('2026-11-01','22:15','Europe/London'),arrival:moment('2026-11-01','23:20','Europe/Dublin'),arrivalBufferMinutes:60});
  Object.assign(trip.days[0],{endMode:'drive',endPlaceId:'stayA',items:[{aid:'landing',placeId:'jfk',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''}]});delete trip.days[0].endFlightId;
  Object.assign(trip.days[1],{startPlaceId:'stayA',endPlaceId:'stayA',startTime:540,items:[{aid:'museum',placeId:'stayB',duration:60,fixed:null,mode:'walk',note:''}]});
  return trip;
};
await check('a planned midnight hotel transfer lets the following day start from that hotel', async () => {
  const trip=plannedMidnightTransfer(),places=getPlaces(trip);
  for(const value of Object.values(places)){value.lat=53;value.lng=-6;}
  const previousLegs=await routes.calculateDayRoutes(JSON.parse(routes.routeInputSignature(trip,0,places)),()=>{},()=>true,async(a,b,mode)=>({mode,min:18,km:'10',status:'ready'}));
  assert.equal(schedule(trip.days[0],places,previousLegs,{trip,dayIndex:0}).finish,1478,'Day 1 continues to 00:38');
  assert.equal(model.incomingFlightStartIssue(trip,1),null);
  let calls=0;const legs=await routes.calculateDayRoutes(JSON.parse(routes.routeInputSignature(trip,1,places)),()=>{},()=>true,async(a,b,mode)=>{calls++;return {mode,min:5,km:'1',status:'ready'};});
  assert.equal(calls,2);const next=schedule(trip.days[1],places,legs,{trip,dayIndex:1});assert.equal(next.unknown,0);assert.equal(next.finishApprox,false);
});
await check('an actual next-date landing also recognises an explicit prior-day onward hotel plan', () => {
  const trip=plannedMidnightTransfer();trip.flights[0].arrival=moment('2026-11-02','00:15','Europe/Dublin');
  assert.equal(model.incomingFlightStartIssue(trip,1),null);
  trip.days[1].startTime=75;assert.ok(model.incomingFlightStartIssue(trip,1),'arrival-ready alone does not allow time for the onward transfer');
  trip.days[1].startTime=74;assert.ok(model.incomingFlightStartIssue(trip,1));
});
await check('missing transfer and a different next-day starting hotel keep the airport warning', () => {
  const trip=plannedMidnightTransfer();trip.days[0].endPlaceId='jfk';assert.ok(model.incomingFlightStartIssue(trip,1));
  trip.days[0].endPlaceId='stayA';trip.days[1].startPlaceId='stayB';assert.ok(model.incomingFlightStartIssue(trip,1));
  trip.days[1].startPlaceId='stayA';trip.days[0].items=[];trip.days[0].endMode='flight';trip.days[0].endPlaceId='jfk';trip.days[0].endFlightId='flight1';assert.ok(model.incomingFlightStartIssue(trip,1));
});
await check('uncertain arrival times and mismatched earlier flight links cannot bypass the warning', () => {
  const trip=plannedMidnightTransfer();trip.flights[0].arrival=moment('2026-11-02',null,'Europe/Dublin');
  assert.match(model.incomingFlightStartIssue(trip,1),/Confirm/);
  trip.flights[0].arrival=moment('2026-11-01','23:20','Europe/Dublin');trip.days[0].items[0].placeId='stayB';assert.ok(model.incomingFlightStartIssue(trip,1));
  trip.days[0].items[0].placeId='jfk';trip.days[0].startPlaceId='stayB';assert.ok(model.incomingFlightStartIssue(trip,1));
});
await check('known post-landing visits must finish before the following day can start', () => {
  const trip=plannedMidnightTransfer();trip.days[0].items[0].duration=540;
  assert.ok(model.incomingFlightStartIssue(trip,1));trip.days[1].startTime=600;assert.equal(model.incomingFlightStartIssue(trip,1),null);
});
await check('fixed free time after landing also delays the next day start', () => {
  const trip=plannedMidnightTransfer();trip.days[0].items[0].freeTime={id:'free-landing',kind:'rest',duration:540,untilBooking:false};
  assert.ok(model.incomingFlightStartIssue(trip,1));trip.days[1].startTime=600;assert.equal(model.incomingFlightStartIssue(trip,1),null);
});
await check('fixed post-flight visits use the prior day zone and their actual end instant', () => {
  const trip=plannedMidnightTransfer();trip.days[0].timezone='America/Los_Angeles';trip.flights[0].arrival=moment('2026-11-02','00:15','Europe/Dublin');
  trip.days[0].items.push({aid:'late-visit',placeId:'stayB',duration:120,fixed:1410,mode:'drive',note:''});
  assert.ok(model.incomingFlightStartIssue(trip,1),'23:30 Los Angeles appointment finishes at 09:30 Dublin');
  trip.days[1].startTime=600;assert.equal(model.incomingFlightStartIssue(trip,1),null);
});
await check('an onward flight airport anchor checks arrival before its buffer and departure after it', () => {
  const trip=plannedMidnightTransfer();trip.timezone='Asia/Tokyo';trip.days[0].timezone='UTC';trip.days[1].startTime=720;
  trip.flights[0]=flight({departure:moment('2026-11-01','00:00','Europe/London'),arrival:moment('2026-11-02','00:00','Asia/Tokyo'),arrivalBufferMinutes:60});
  trip.flights.push(flight({id:'onward',fromPlaceId:'jfk',toPlaceId:'stayB',departure:moment('2026-11-01','20:00','UTC'),arrival:moment('2026-11-01','16:00','America/Los_Angeles'),airportBufferMinutes:120,arrivalBufferMinutes:0}));
  trip.days[0].items.push({aid:'connection-checkin',placeId:'jfk',duration:5,fixed:1080,mode:'walk',note:'',departureForFlightId:'onward'},
    {aid:'connection-flight',placeId:'stayB',duration:0,fixed:null,mode:'flight',flightId:'onward',note:''});
  assert.equal(model.incomingFlightStartIssue(trip,1),null);
  trip.days[0].items[1].fixed=1081;assert.ok(model.incomingFlightStartIssue(trip,1),'late check-in buffer would finish after departure');
  trip.days[0].items[1].fixed=1080;trip.flights[1].arrival.time=null;assert.ok(model.incomingFlightStartIssue(trip,1));
});
await check('an incoming-flight warning counts only the actual unavailable journeys', () => {
  const trip=plannedMidnightTransfer();trip.days[1].startPlaceId='stayB';
  const result=schedule(trip.days[1],getPlaces(trip),{museum:{mode:'walk',min:5,km:'1',status:'ready'},return:{mode:'walk',min:5,km:'1',status:'ready'}},{trip,dayIndex:1});
  assert.equal(result.unknown,2);assert.equal(result.finishApprox,true);
});
console.log(`\n${count} booking model and routing checks passed.`);
