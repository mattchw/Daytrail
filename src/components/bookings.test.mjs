import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

// Render the real components while resolving TS and stylesheet imports in memory.
const compiled = new Map();
function moduleURL(path) {
  if (compiled.has(path)) return compiled.get(path);
  let source = ts.transpileModule(readFileSync(path, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText;
  source = source.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '').replaceAll('import.meta.env', '({})');
  source = source.replace(/^((?:import|export)\s[^\n]*?\sfrom\s)(['"])([^'"]+)\2/gm, (_, prefix, quote, specifier) => {
    if (!specifier.startsWith('.')) return `${prefix}${JSON.stringify(import.meta.resolve(specifier))}`;
    const base = resolve(dirname(path), specifier), dependency = [base, `${base}.ts`, `${base}.tsx`].find(candidate => existsSync(candidate));
    return `${prefix}${JSON.stringify(moduleURL(dependency))}`;
  });
  const value = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  compiled.set(path, value); return value;
}
const root = dirname(fileURLToPath(import.meta.url));
const {default: FlightCard, previousFlightConnection} = await import(moduleURL(resolve(root, 'FlightCard.tsx')));
const {default: StartingFlightCard} = await import(moduleURL(resolve(root, 'StartingFlightCard.tsx')));
const {default: AddToTripDialog} = await import(moduleURL(resolve(root, 'AddToTripDialog.tsx')));
const {default: BookingEssentials, StayCard} = await import(moduleURL(resolve(root, 'BookingEssentials.tsx')));
const {default: FlightsStaysPanel} = await import(moduleURL(resolve(root, 'FlightsStaysPanel.tsx')));
const {default: TripBookingsBar} = await import(moduleURL(resolve(root, 'TripBookingsBar.tsx')));
const {default: DayEndpointPicker,createEndpointDraft,DayEndpointRow} = await import(moduleURL(resolve(root, 'DayEndpointPicker.tsx')));
const {default: IncomingFlightNotice} = await import(moduleURL(resolve(root, 'IncomingFlightNotice.tsx')));
const {default: BookingDayBoundary} = await import(moduleURL(resolve(root, 'BookingDayBoundary.tsx')));
const {default: TravelMode} = await import(moduleURL(resolve(root, 'TravelMode.tsx')));
const {default: TripOverview} = await import(moduleURL(resolve(root, 'TripOverview.tsx')));
const {createTrip} = await import(moduleURL(resolve(root, '../model.ts')));
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const place = (id, name) => ({id, name, userLabel:name, cat:'custom', area:'', typical:'', blurb:'', x:50, y:50, googlePlaceId:`test_${id}`});
const places = {from:place('from','Departure airport'),to:place('to','Arrival airport'),hotel:place('hotel','Our stay')};
const flight = {id:'flight1',fromPlaceId:'from',toPlaceId:'to',departure:{date:'2026-11-01',time:'22:00',timezone:'Europe/London'},arrival:{date:'2026-11-02',time:'20:00',timezone:'Asia/Tokyo'},flightNumber:'DT123',bookingReference:'SECRET-FLIGHT-REF',privateNotes:'SECRET-FLIGHT-NOTE'};
const stay = {id:'stay1',placeId:'hotel',checkInDate:'2026-11-02',checkOutDate:'2026-11-04',timezone:'Asia/Tokyo',bookingReference:'SECRET-STAY-REF',contact:'SECRET-CONTACT',bookingUrl:'https://booking.example/private-booking',privateNotes:'SECRET-STAY-NOTE'};
const trip = {...createTrip('Bookings test','Tokyo','2026-11-01',4),flights:[flight],stays:[stay],customPlaces:places};
const noop = async () => {};
const panelProps = {trip,places,onSaveFlight:noop,onDeleteFlight:noop,onSaveStay:noop,onDeleteStay:noop,onRememberPlace:noop};
let checks = 0;
function check(name, run) {run(); checks++; console.log(`✓ ${name}`);}

check('flight cards exclude private references and notes unless explicitly enabled', () => {
  const privateFlight={...flight,departureGate:'SECRET-DEPARTURE-GATE',arrivalGate:'SECRET-ARRIVAL-GATE'};
  const publicCard = render(FlightCard,{flight:privateFlight,places});
  assert.doesNotMatch(publicCard,/SECRET-/);
  const ownerCard = render(FlightCard,{flight:privateFlight,places,showPrivate:true});
  assert.match(ownerCard,/SECRET-FLIGHT-REF/); assert.match(ownerCard,/SECRET-FLIGHT-NOTE/);
  assert.match(ownerCard,/SECRET-DEPARTURE-GATE/); assert.match(ownerCard,/SECRET-ARRIVAL-GATE/);
});
check('accommodation cards omit contact details, links and references in shared views', () => {
  const publicCard=render(StayCard,{stay,places});
  assert.doesNotMatch(publicCard,/SECRET-|private-booking/);
  const ownerCard=render(StayCard,{stay,places,showPrivate:true});
  assert.match(ownerCard,/SECRET-STAY-REF/); assert.match(ownerCard,/SECRET-CONTACT/); assert.match(ownerCard,/private-booking/);
});
check('private booking links allow only HTTPS without embedded credentials', () => {
  for(const bookingUrl of ['javascript:alert(1)','data:text/html,secret','http://booking.example','https://user:password@booking.example']) {
    const html=render(StayCard,{stay:{...stay,bookingUrl},places,showPrivate:true});
    assert.doesNotMatch(html,/Open booking website/);
  }
});
check('overnight flight cards show both local dates, true elapsed time and airport goal', () => {
  const html=render(FlightCard,{flight,places});
  assert.match(html,/1 Nov 2026/); assert.match(html,/2 Nov 2026/); assert.match(html,/13h flight/);
  assert.match(html,/Airport arrival goal:/); assert.match(html,/20:00/); assert.match(html,/Europe\/London/); assert.match(html,/Asia\/Tokyo/);
});
check('a starting flight presents each airport once in origin, flight, arrival order', () => {
  const html=render(StartingFlightCard,{flight,places,startTime:1200,startTimezone:'Europe/London'});
  const origin='<h3>Departure airport</h3>',arrival='<h3>Arrival airport</h3>';
  assert.equal(html.split(origin).length-1,1); assert.equal(html.split(arrival).length-1,1);
  assert.ok(html.indexOf(origin)<html.indexOf('<h4>DT123</h4>'));
  assert.ok(html.indexOf('<h4>DT123</h4>')<html.indexOf(arrival));
  assert.match(html,/aria-label="Starting flight"/);
});
check('starting flights keep the day start distinct from scheduled departure and local landing time', () => {
  const html=render(StartingFlightCard,{flight,places,startTime:1200,startTimezone:'Europe/London'});
  assert.match(html,/Day starts at <strong>20:00<\/strong>/);
  assert.match(html,/<span>Departs<\/span><strong>22:00<\/strong>/);
  assert.match(html,/1 Nov 2026/); assert.match(html,/2 Nov 2026/); assert.match(html,/\+1 day/);
  assert.match(html,/13\s*h flight/); assert.match(html,/Europe\/London/); assert.match(html,/Asia\/Tokyo/);
  assert.match(html,/Ready to leave at <strong>21:00<\/strong>/);
});
check('the starting flight ready time names the next local date when the landing buffer crosses midnight', () => {
  const html=render(StartingFlightCard,{flight:{...flight,arrival:{...flight.arrival,time:'23:30'},arrivalBufferMinutes:90},places,startTime:1200,startTimezone:'Europe/London'});
  assert.match(html,/Ready to leave at <strong>01:00 · 3 Nov 2026<\/strong>/);
  assert.match(html,/Allow 1 h 30 min after landing/);
  assert.match(html,/2 Nov 2026/); assert.match(html,/\+1 day/);
});
check('starting flights expose edit controls only through supplied capabilities and never reveal private details', () => {
  const privateFlight={...flight,departureTerminal:'2',arrivalTerminal:'1',departureGate:'SECRET-DEPARTURE-GATE',arrivalGate:'SECRET-ARRIVAL-GATE'};
  const props={flight:privateFlight,places,startTime:1200,startTimezone:'Europe/London'};
  const viewer=render(StartingFlightCard,props);
  assert.doesNotMatch(viewer,/<button|<select|SECRET-/); assert.match(viewer,/Terminal 2/); assert.match(viewer,/Terminal 1/);
  const editor=render(StartingFlightCard,{...props,onChooseStart:noop,onChooseEnd:noop,onEdit:noop,onChangeMode:noop});
  for(const label of ['Choose day start','Choose day end','Edit DT123','Transport to Arrival airport']) assert.ok(editor.includes(`aria-label="${label}"`));
  assert.doesNotMatch(editor,/SECRET-/);
});
check('starting flights retain the airport conflict warning when the separate travel leg is hidden', () => {
  const warning='This plan misses the flight’s airport arrival goal or departure. Review the transfer and airport buffer.';
  const html=render(StartingFlightCard,{flight,places,startTime:1320,startTimezone:'Europe/London',journey:{mode:'flight',min:780,km:'—',status:'ready',warning}});
  assert.match(html,/role="status"/); assert.equal(html.split(warning).length-1,1);
});
check('incomplete flight timing cannot display a confirmed duration or ready time', () => {
  const unknownFlight={...flight,arrival:{...flight.arrival,time:null}};
  const html=render(StartingFlightCard,{flight:unknownFlight,places,startTime:1200,startTimezone:'Europe/London',journey:{mode:'flight',min:null,km:'—',status:'unavailable',reason:'Confirm arrival before continuing.'}});
  assert.match(html,/Flight duration to confirm/); assert.match(html,/To confirm/); assert.match(html,/Confirm arrival before continuing/);
  assert.match(html,/role="status"/); assert.doesNotMatch(html,/Ready to leave at/);
});
check('starting flight warnings retain unavailable journey context even when the booking clock is complete', () => {
  const html=render(StartingFlightCard,{flight,places,startTime:1200,startTimezone:'Europe/London',journey:{mode:'flight',min:null,km:'—',status:'loading'}});
  assert.match(html,/Calculating journey…/); assert.match(html,/role="status"/);
});
check('adding to an empty direct flight previews the stop after landing, without a before-flight option', () => {
  const day={...trip.days[0],startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'};
  const html=render(AddToTripDialog,{place:places.hotel,days:[day],places,initialDayIndex:0,onAdd:noop});
  assert.match(html,/<option value="end" selected="">After landing<\/option>/);
  assert.match(html,/Land at Arrival airport/); assert.doesNotMatch(html,/<option value="start"/);
  assert.ok(html.indexOf('Land at Arrival airport')<html.indexOf('<strong>Our stay</strong><small>'));
});
check('adding after an existing leading flight offers an after-flight start position', () => {
  const day={...trip.days[0],startPlaceId:'from',endPlaceId:'to',endMode:'walk',items:[{aid:'landing',placeId:'to',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''}]};
  const html=render(AddToTripDialog,{place:places.hotel,days:[day],places,initialDayIndex:0,onAdd:noop});
  assert.match(html,/<option value="start">After the starting flight<\/option>/);
  assert.doesNotMatch(html,/<option[^>]*>Start of day|<option value="after:landing"/);
  assert.match(html,/<span>Arrival airport<\/span>/);
});
check('flight and stay notes are escaped as text, including owner views', () => {
  const html=render(FlightCard,{flight:{...flight,privateNotes:'<script>run()</script>'},places,showPrivate:true});
  assert.doesNotMatch(html,/<script>/); assert.match(html,/&lt;script&gt;/);
});
check('Essentials includes overnight arrival and checkout days without unrelated days', () => {
  assert.match(render(BookingEssentials,{trip,places,dayIndex:1}),/DT123/);
  assert.match(render(BookingEssentials,{trip,places,dayIndex:3}),/Our stay/);
  assert.doesNotMatch(render(BookingEssentials,{trip,places,dayIndex:3}),/DT123/);
  assert.equal(render(BookingEssentials,{trip,places,date:'2027-01-01'}),'');
});
check('flight editor asks for the precise UTC offset during a repeated DST hour', () => {
  const html=render(FlightsStaysPanel,{...panelProps,initialKind:'flight',initialFlightDraft:{...flight,departure:{date:'2026-10-25',time:'01:30',timezone:'Europe/London'},arrival:{date:'2026-10-25',time:'04:30',timezone:'Europe/London'}}});
  assert.match(html,/This time occurs twice/); assert.match(html,/UTC\+01:00/); assert.match(html,/UTC\+00:00/);
});
check('flight editor distinguishes out-of-range bookings from itinerary links', () => {
  const html=render(FlightsStaysPanel,{...panelProps,initialKind:'flight',initialFlightDraft:{...flight,departure:{...flight.departure,date:'2026-12-01'},arrival:{...flight.arrival,date:'2026-12-02'}}});
  assert.match(html,/outside your trip dates/); assert.match(html,/Save booking only/); assert.doesNotMatch(html,/Save &amp; use flight/);
});
check('connecting segments show an elapsed layover only when timing is confirmed', () => {
  const connecting={...flight,id:'flight2',groupId:'flight1',fromPlaceId:'to',toPlaceId:'hotel',departure:{date:'2026-11-02',time:'22:00',timezone:'Asia/Tokyo'},arrival:{date:'2026-11-03',time:'01:00',timezone:'Asia/Tokyo'}};
  assert.equal(previousFlightConnection(connecting,[connecting,flight])?.id,'flight1');
  assert.match(render(FlightCard,{flight:connecting,places,previousFlight:flight}),/2h layover/);
  assert.match(render(FlightCard,{flight:{...connecting,departure:{...connecting.departure,time:null}},places,previousFlight:flight}),/Connection time to confirm/);
});
check('saved flights from another day cannot be linked with the current day action', () => {
  const html=render(FlightsStaysPanel,{...panelProps,initialKind:'flight',initialTarget:{dayId:trip.days[2].id,targetId:`end:${trip.days[2].id}`},onLinkFlight:noop});
  assert.doesNotMatch(html,/Use this flight|Add to departure day/); assert.match(html,/No saved flights depart on this day/);
});
check('transport flight selection stays focused on the selected journey and preserves its plan', () => {
  const day={...trip.days[0],startPlaceId:'from',endPlaceId:'hotel',endMode:'drive'};
  const choiceTrip={...trip,days:[day,...trip.days.slice(1)]};
  const html=render(FlightsStaysPanel,{...panelProps,trip:choiceTrip,initialKind:'flight',initialTarget:{dayId:day.id,targetId:`end:${day.id}`},onLinkFlight:noop});
  assert.match(html,/aria-label="Choose a flight for this journey"/);
  assert.match(html,/Keeps your day’s start, end and stops/); assert.match(html,/Adds airport connections where needed/);
  assert.match(html,/Departure airport/); assert.match(html,/Our stay/); assert.match(html,/Use this flight/);
  assert.match(html,/>Cancel</); assert.match(html,/>Add a flight</);
  assert.doesNotMatch(html,/SECRET-|private-booking|Add to departure day|Unlink|Delete flight|Remove stay|Add a stay/);
});
check('flight selection identifies already-used bookings without offering a duplicate link', () => {
  const day={...trip.days[0],startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:flight.id};
  const html=render(FlightsStaysPanel,{...panelProps,trip:{...trip,days:[day,...trip.days.slice(1)]},initialTarget:{dayId:day.id,targetId:`end:${day.id}`},onLinkFlight:noop});
  assert.match(html,/Already used on Day 1/); assert.doesNotMatch(html,/Use this flight/);
});
check('a removed journey shows a recovery message without offering flight mutations', () => {
  const html=render(FlightsStaysPanel,{...panelProps,initialTarget:{dayId:trip.days[0].id,targetId:'activity:removed'},onLinkFlight:noop});
  assert.match(html,/This position changed/); assert.match(html,/Close this picker and choose Flight again/);
  assert.doesNotMatch(html,/Use this flight|>Add a flight</);
});
check('Travel mode uses Mark landed and ground directions only to the departure airport', () => {
  const flightTrip={...trip,days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const html=render(TravelMode,{trip:flightTrip,places,dayIndex:0,onDayChange:()=>{},onEditPlan:()=>{},onBack:()=>{},marks:{},onSetState:noop,map:null,schedule:{rows:[],endLeg:{min:null,mode:'flight',km:'—'},finish:0,finishApprox:true}});
  assert.match(html,/Mark landed/); assert.match(html,/Directions to departure airport/);
  const directions=[...html.matchAll(/href="([^\"]*google\.com\/maps\/dir\/[^\"]*)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&')));
  assert.ok(directions.length>0); for(const url of directions){assert.equal(url.searchParams.get('destination_place_id'),'test_from');assert.equal(url.searchParams.get('travelmode'),'transit');}
});
check('arrival-only Travel mode never offers directions back to the departure airport', () => {
  const flightTrip={...trip,days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const html=render(TravelMode,{trip:flightTrip,places,dayIndex:1,onDayChange:()=>{},onEditPlan:()=>{},onBack:()=>{},marks:{},onSetState:noop,map:null,schedule:{rows:[],endLeg:{min:null,mode:'walk',km:'—'},finish:0,finishApprox:true}});
  assert.match(html,/Mark landed/); assert.doesNotMatch(html,/Directions to departure airport/); assert.doesNotMatch(html,/destination_place_id=test_from/);
});
check('arrival-day endpoint changes have an explicit place, ready-time and finish-goal preview', () => {
  const flightTrip={...trip,days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const html=render(BookingEssentials,{trip:flightTrip,places,dayIndex:1,onStartFromFlight:noop});
  assert.match(html,/Continue from Arrival airport/); assert.match(html,/21:00/); assert.match(html,/Asia\/Tokyo/);
  assert.match(html,/Start this day at arrival airport/); assert.match(html,/earlier finish goal will be cleared/);
  assert.doesNotMatch(render(BookingEssentials,{trip:flightTrip,places,dayIndex:1}),/Start this day at arrival airport/);
  flightTrip.days[1]={...flightTrip.days[1],startPlaceId:'to',timezone:'Asia/Tokyo',startTime:1320};
  assert.doesNotMatch(render(BookingEssentials,{trip:flightTrip,places,dayIndex:1,onStartFromFlight:noop}),/Start this day at arrival airport/);
});
check('a same-day flight with a midnight arrival buffer offers the next day airport start', () => {
  const lateFlight={...flight,departure:{date:'2026-11-01',time:'20:00',timezone:'Europe/London'},arrival:{date:'2026-11-01',time:'23:30',timezone:'Europe/London'},arrivalBufferMinutes:90};
  const flightTrip={...trip,flights:[lateFlight],days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const html=render(BookingEssentials,{trip:flightTrip,places,dayIndex:1,onStartFromFlight:noop});
  assert.match(html,/DT123/); assert.match(html,/Ready to leave: 2 Nov, 01:00/);
  assert.match(html,/Continue from Arrival airport/);
  const action=html.match(/<button\b[^>]*>[^]*?Start this day at arrival airport<\/button>/)?.[0];
  assert.ok(action); assert.doesNotMatch(action,/disabled/);
  flightTrip.days[1]={...flightTrip.days[1],startPlaceId:'to',timezone:'Europe/London',startTime:120};
  assert.doesNotMatch(render(BookingEssentials,{trip:flightTrip,places,dayIndex:1,onStartFromFlight:noop}),/Start this day at arrival airport/);
});
check('an overnight flight with a second midnight buffer disables landing-day setup and enables the ready day', () => {
  const lateFlight={...flight,arrival:{...flight.arrival,time:'23:30'},arrivalBufferMinutes:90};
  const flightTrip={...trip,flights:[lateFlight],days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const landing=render(BookingEssentials,{trip:flightTrip,places,dayIndex:1,onStartFromFlight:noop});
  assert.match(landing,/arrival buffer ends on 3 Nov 2026/);
  assert.match(landing,/<button\b[^>]*disabled=""[^>]*>[^]*?Start this day at arrival airport/);
  const ready=render(BookingEssentials,{trip:flightTrip,places,dayIndex:2,onStartFromFlight:noop});
  assert.match(ready,/Ready to leave: 3 Nov, 01:00/);
  const action=ready.match(/<button\b[^>]*>[^]*?Start this day at arrival airport<\/button>/)?.[0];
  assert.ok(action); assert.doesNotMatch(action,/disabled/);
  const unlinked={...flightTrip,days:trip.days};
  assert.doesNotMatch(render(BookingEssentials,{trip:unlinked,places,dayIndex:2,onStartFromFlight:noop}),/Start this day at arrival airport/);
});
check('collaborative booking editors retain schedule controls without private booking fields', () => {
  const privateFlight={...flight,departureGate:'SECRET-DEPARTURE-GATE',arrivalGate:'SECRET-ARRIVAL-GATE'};
  const props={...panelProps,trip:{...trip,flights:[privateFlight]},showPrivate:false};
  const list=render(FlightsStaysPanel,props);
  assert.match(list,/DT123/);assert.match(list,/Our stay/);assert.doesNotMatch(list,/SECRET-|private-booking/);
  const flightEditor=render(FlightsStaysPanel,{...props,initialKind:'flight',initialFlightDraft:privateFlight});
  assert.match(flightEditor,/Flight number/);assert.match(flightEditor,/terminal/i);
  assert.doesNotMatch(flightEditor,/SECRET-|Private booking details|Booking reference|Private notes|>Gate/);
  const stayEditor=render(FlightsStaysPanel,{...props,initialKind:'stay'});
  assert.match(stayEditor,/Check-in/);assert.doesNotMatch(stayEditor,/Private booking details|Booking reference|Booking website|Private notes|<label>Contact/);
});
check('viewer Travel mode keeps personal flight progress while hiding editing and private data', () => {
  const flightTrip={...trip,days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const html=render(TravelMode,{trip:flightTrip,places,dayIndex:0,onDayChange:()=>{},onEditPlan:()=>{},onBack:()=>{},marks:{},onSetState:noop,map:null,schedule:{rows:[],endLeg:{min:null,mode:'flight',km:'—'},finish:0,finishApprox:true},canEditPlan:false,showPrivate:false,onChooseLocation:noop,onManageBookings:noop,onStartFromFlight:noop});
  assert.match(html,/View plan/);assert.match(html,/Mark landed/);assert.doesNotMatch(html,/SECRET-|private-booking/);
  assert.doesNotMatch(html,/<button\b[^>]*>Flight details|<button\b[^>]*>Choose location|>Edit plan</);
  const landed=html.match(/<button\b[^>]*class="dt-travel-button is-primary"[^>]*>[^]*?Mark landed<\/button>/)?.[0];
  assert.ok(landed);assert.doesNotMatch(landed,/disabled/);
});
check('viewer Travel mode can check off ordinary stops without access to location editors', () => {
  const walking={...trip,flights:[],stays:[],days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',items:[{aid:'visit',placeId:'to',duration:60,fixed:null,mode:'walk',note:'A shared note'}]})};
  const unlocated={...places,to:{...places.to,googlePlaceId:undefined}};
  const html=render(TravelMode,{trip:walking,places:unlocated,dayIndex:0,onDayChange:()=>{},onEditPlan:()=>{},onBack:()=>{},marks:{},onSetState:noop,map:null,schedule:{rows:[],endLeg:{min:null,mode:'walk',km:'—'},finish:0,finishApprox:true},canEditPlan:false,showPrivate:false,onChooseLocation:noop});
  assert.match(html,/View plan/);assert.match(html,/Skip for now/);assert.match(html,/A shared note/);
  assert.doesNotMatch(html,/<button\b[^>]*>Choose location|>Edit plan</);
  const done=html.match(/<button\b[^>]*class="dt-travel-button is-done"[^>]*>[^]*?Done<\/button>/)?.[0];
  assert.ok(done);assert.doesNotMatch(done,/disabled/);
});
check('whole-trip overview applies private-booking capability independently of edit permission', () => {
  const props={trip,places,summaries:{},loading:false,readOnly:false,onOpenDay:()=>{},onMove:noop,onAddIdea:noop,onAddDays:noop,onDiscover:noop,onRetry:noop};
  const editor=render(TripOverview,{...props,showPrivate:false});
  assert.doesNotMatch(editor,/SECRET-|private-booking/);assert.match(editor,/Add days/);
  const owner=render(TripOverview,{...props,showPrivate:true});assert.match(owner,/SECRET-FLIGHT-REF/);assert.match(owner,/SECRET-STAY-REF/);
  const viewer=render(TripOverview,{...props,readOnly:true,showPrivate:false});assert.doesNotMatch(viewer,/SECRET-|private-booking|>Add days</);
});
check('trip booking entry points distinguish arrival, stays and departure', () => {
  const html = render(FlightsStaysPanel, panelProps);
  assert.match(html, /Arrival flight/); assert.match(html, /Departure flight/); assert.match(html, /Add a stay/);
  assert.match(html, /Add another flight or connection/);
});
check('direct booking actions edit the selected flight and stay instead of starting duplicates', () => {
  const flightEditor = render(FlightsStaysPanel, {...panelProps, initialFlightId:'flight1', initialIntent:'arrival'});
  assert.match(flightEditor, /Edit flight/); assert.match(flightEditor, /value="DT123"/); assert.match(flightEditor, /value="20:00"/);
  const stayEditor = render(FlightsStaysPanel, {...panelProps, initialStayId:'stay1'});
  assert.match(stayEditor, /Edit your stay/); assert.match(stayEditor, /Our stay/); assert.match(stayEditor, /value="2026-11-04"/);
});
check('arrival setup previews the actual local ready time and overnight day before applying', () => {
  const html = render(FlightsStaysPanel, {...panelProps, initialFlightId:'flight1', initialIntent:'arrival'});
  assert.match(html, /Ready to leave the airport at/); assert.match(html, /21:00/); assert.match(html, /Asia\/Tokyo/);
  assert.match(html, /\+1 day on arrival/); assert.match(html, /Save &amp; update day/);
  assert.match(html, /Airport transfer/); assert.doesNotMatch(html, /flight found|matched flight/i);
});
check('unconfirmed flight times can be saved without implying the day will change', () => {
  const html = render(FlightsStaysPanel, {...panelProps, initialKind:'flight', initialIntent:'arrival', initialFlightDraft:{...flight,arrival:{...flight.arrival,time:null}}});
  assert.match(html, /Save booking only/); assert.doesNotMatch(html, /Save &amp; update day/);
  assert.match(html, /type="checkbox" disabled=""/);
});
check('arrival dates outside the trip require explicit extension before updating a day', () => {
  const html = render(FlightsStaysPanel, {...panelProps, initialKind:'flight', initialIntent:'arrival', initialFlightDraft:{...flight,departure:{...flight.departure,date:'2026-12-01'},arrival:{...flight.arrival,date:'2026-12-02'}}});
  assert.match(html, /outside your current trip dates/); assert.match(html, /Include 2 Dec 2026 in my trip/);
  assert.match(html, /Save booking only/); assert.doesNotMatch(html, /Save &amp; update day/);
});
check('an uncovered night opens stay dates for that night and shows editable suggested times', () => {
  const html = render(FlightsStaysPanel, {...panelProps, initialKind:'stay',initialStayDate:'2026-11-03'});
  assert.match(html, /value="2026-11-03"/); assert.match(html, /value="2026-11-04"/);
  assert.match(html, /value="15:00"/); assert.match(html, /value="11:00"/); assert.match(html, /Check these times against your booking/);
});
check('new arrival flow offers another way to arrive without inventing a flight lookup', () => {
  const html = render(FlightsStaysPanel, {...panelProps, initialKind:'flight', initialIntent:'arrival', onNotFlying:()=>{}});
  assert.match(html, /Not flying\? Choose a start or end place/);
  assert.match(html, /Copy the airports and local times from your booking/);
  assert.doesNotMatch(html, /Search flights|Find flight|flight found|matched flight/i);
});
const arrivalBooking = {...flight,id:'arrival-booking',departure:{date:'2026-10-31',time:'22:00',timezone:'Europe/London'},arrival:{date:'2026-11-01',time:'11:50',timezone:'Asia/Tokyo'},flightNumber:'ARR123',arrivalBufferMinutes:60};
const departureBooking = {...flight,id:'departure-booking',fromPlaceId:'to',toPlaceId:'from',departure:{date:'2026-11-03',time:'18:00',timezone:'Asia/Tokyo'},arrival:{date:'2026-11-03',time:'21:00',timezone:'Europe/London'},flightNumber:'DEP456',airportBufferMinutes:120};
const journeyStay = {...stay,id:'journey-stay',checkInDate:'2026-11-01',checkOutDate:'2026-11-03',checkInTime:'15:00',checkOutTime:'11:00'};
const journeyTrip = {...createTrip('A grounded holiday','Tokyo','2026-11-01',3),timezone:'Asia/Tokyo',customPlaces:places,flights:[arrivalBooking,departureBooking],stays:[journeyStay]};
journeyTrip.days = journeyTrip.days.map((day,index)=>({...day,startTime:index===0?770:540,startPlaceId:index===0?'to':'hotel',endPlaceId:index===2?'to':'hotel',startStayId:index===0?undefined:'journey-stay',endStayId:index===2?undefined:'journey-stay',finishBy:index===2?960:null,endMode:'transit'}));
const boundaryProps = {trip:journeyTrip,places,finish:900,uncertain:false};
check('the trip booking bar counts occupied nights without counting check-out as a night', () => {
  const covered = render(TripBookingsBar,{trip:journeyTrip,places,onOpen:noop,onManage:noop});
  assert.match(covered,/2\/2 nights covered/); assert.match(covered,/Somewhere to rest each night/);
  const gap = render(TripBookingsBar,{trip:{...journeyTrip,stays:[{...journeyStay,checkInDate:'2026-11-02'}]},places,onOpen:noop,onManage:noop});
  assert.match(gap,/1\/2 nights covered/); assert.match(gap,/1 night to plan/); assert.match(gap,/needs-attention/); assert.match(gap,/>Add stay</);
});
check('overlapping nights ask for review instead of being counted twice', () => {
  const html = render(TripBookingsBar,{trip:{...journeyTrip,stays:[journeyStay,{...journeyStay,id:'second-stay',checkOutDate:'2026-11-02'}]},places,onOpen:noop,onManage:noop});
  assert.match(html,/2\/2 nights covered/); assert.match(html,/1 overlapping night/); assert.match(html,/>Review</);
  assert.doesNotMatch(html,/3\/2 nights covered|Somewhere to rest each night/);
});
check('multiple flights are shown as a choice for both editors and viewers', () => {
  const multiple = {...journeyTrip,flights:[arrivalBooking,{...arrivalBooking,id:'arrival-two',flightNumber:'OTHER-ARR'},departureBooking,{...departureBooking,id:'departure-two',flightNumber:'OTHER-DEP'}]};
  for (const callbacks of [{onOpen:noop,onManage:noop},{}]) {
    const html = render(TripBookingsBar,{trip:multiple,places,...callbacks});
    assert.match(html,/2 arrival flights/); assert.match(html,/2 departure flights/);
    assert.doesNotMatch(html,/ARR123|OTHER-ARR|DEP456|OTHER-DEP|No flight added/);
  }
});
check('read-only trip bookings expose information without edit or add buttons', () => {
  const html = render(TripBookingsBar,{trip:journeyTrip,places});
  assert.match(html,/ARR123/); assert.match(html,/DEP456/); assert.match(html,/Our stay/);
  assert.doesNotMatch(html,/Manage all flights|Add another stay/); assert.equal((html.match(/<button/g)||[]).length,1); assert.match(html,/aria-label="Collapse bookings"/); assert.match(html,/aria-expanded="true"/);
  const empty = render(TripBookingsBar,{trip:{...journeyTrip,flights:[],stays:[]},places});
  assert.match(empty,/No flight added/); assert.match(empty,/No stay added/); assert.equal((empty.match(/<button/g)||[]).length,1);
});
check('trip booking summaries and day boundaries never render owner-private fields', () => {
  const views = [render(TripBookingsBar,{trip:journeyTrip,places,onOpen:noop,onManage:noop}),render(BookingDayBoundary,{...boundaryProps,dayIndex:0,position:'start',onEdit:noop,onBagStop:noop}),render(BookingDayBoundary,{...boundaryProps,dayIndex:0,position:'end',onEdit:noop}),render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'end',onEdit:noop,onBagStop:noop})];
  for (const html of views) assert.doesNotMatch(html,/SECRET-|private-booking/);
});
check('known departure overruns warn while incomplete estimates do not promise spare time', () => {
  const late = render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'end',finish:1000});
  assert.match(late,/Flight conflict/); assert.match(late,/40 min/); assert.doesNotMatch(late,/to spare/);
  const uncertain = render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'end',finish:900,uncertain:true});
  assert.match(uncertain,/estimates|incomplete/i); assert.doesNotMatch(uncertain,/to spare|Flight conflict/);
  const uncertainLate = render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'end',finish:1000,uncertain:true});
  assert.match(uncertainLate,/incomplete|uncertain|estimate|missing transfer/i); assert.match(uncertainLate,/at least/i); assert.doesNotMatch(uncertainLate,/to spare/);
  const onTime = render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'end',finish:900});
  assert.match(onTime,/1 h to spare/); assert.doesNotMatch(onTime,/Flight conflict/);
});
check('arrival boundaries show the landing buffer and warn against starting too early', () => {
  const normal = render(BookingDayBoundary,{...boundaryProps,dayIndex:0,position:'start'});
  assert.match(normal,/Land 11:50/); assert.match(normal,/Allow 1 h for immigration and bags/); assert.match(normal,/12:50/);
  const earlyTrip = {...journeyTrip,days:journeyTrip.days.map((day,index)=>index?day:{...day,startTime:720})};
  const early = render(BookingDayBoundary,{...boundaryProps,trip:earlyTrip,dayIndex:0,position:'start'});
  assert.match(early,/before you are ready to leave the airport/); assert.match(early,/is-warning/);
});
check('bag stops require an explicit action and are hidden when editing is unavailable', () => {
  const start = render(BookingDayBoundary,{...boundaryProps,dayIndex:0,position:'start',onEdit:noop,onBagStop:noop});
  assert.match(start,/Add bag-drop stop/); assert.match(start,/Check luggage storage with your accommodation/);
  const end = render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'end',onEdit:noop,onBagStop:noop});
  assert.match(end,/Add bag-collection stop/);
  for (const [dayIndex,position] of [[0,'start'],[2,'end']]) {
    const viewer = render(BookingDayBoundary,{...boundaryProps,dayIndex,position});
    assert.doesNotMatch(viewer,/<button|Add bag-|Edit flight|Edit stay/);
  }
});
check('stay reminders show actual check-in and checkout times on the relevant days', () => {
  const checkIn = render(BookingDayBoundary,{...boundaryProps,dayIndex:0,position:'end',finish:840});
  assert.match(checkIn,/Check in from 15:00/); assert.match(checkIn,/Our stay/);
  const checkOut = render(BookingDayBoundary,{...boundaryProps,dayIndex:2,position:'start'});
  assert.match(checkOut,/Check out by 11:00/); assert.match(checkOut,/Our stay/);
  const middleStart = render(BookingDayBoundary,{...boundaryProps,dayIndex:1,position:'start'});
  assert.doesNotMatch(middleStart,/Check out/);
});
check('applied arrival and departure bookings show their day role without a redundant link action', () => {
  const html = render(FlightsStaysPanel,{...panelProps,trip:journeyTrip,onLinkFlight:noop});
  assert.match(html,/Sets day start/); assert.match(html,/Sets day end/);
  assert.doesNotMatch(html,/Add to departure day/);
  const unapplied = {...journeyTrip,days:journeyTrip.days.map(day=>({...day,startPlaceId:'hotel',endPlaceId:'hotel'}))};
  const available = render(FlightsStaysPanel,{...panelProps,trip:unapplied,onLinkFlight:noop});
  assert.match(available,/Add to departure day/); assert.doesNotMatch(available,/Sets day start|Sets day end/);
});
check('applied trip boundaries do not ask to extend for the other airport’s outside date', () => {
  const returnNextDay = {...departureBooking,arrival:{...departureBooking.arrival,date:'2026-11-04',time:'01:00'}};
  const outsideAirports = {...journeyTrip,flights:[arrivalBooking,returnNextDay]};
  const applied = render(FlightsStaysPanel,{...panelProps,trip:outsideAirports,onLinkFlight:noop,onExtendTrip:noop});
  assert.match(applied,/Sets day start/); assert.match(applied,/Sets day end/);
  assert.doesNotMatch(applied,/This flight is outside your trip dates|Extend trip to include flight/);
  const unbound = {...outsideAirports,days:outsideAirports.days.map(day=>({...day,startPlaceId:'hotel',endPlaceId:'hotel'}))};
  const unboundHtml = render(FlightsStaysPanel,{...panelProps,trip:unbound,onExtendTrip:noop});
  assert.equal((unboundHtml.match(/This flight is outside your trip dates/g)||[]).length,2);
  assert.equal((unboundHtml.match(/Extend trip to include flight/g)||[]).length,2);
});
check('endpoint picker offers relevant bookings without exposing private details', () => {
  const value=createEndpointDraft(journeyTrip,0,'start',places);
  const html=render(DayEndpointPicker,{trip:journeyTrip,places,value,onChange:noop,onSearch:noop,onSave:noop});
  assert.match(html,/ARR123/); assert.doesNotMatch(html,/DEP456|SECRET-|private-booking/);
  assert.match(html,/Ready to leave the airport/); assert.match(html,/12:50/); assert.match(html,/Save start/);
  assert.doesNotMatch(html,/aria-label="Day start time"/);
});
check('stay endpoint picker exposes one relevant time control and collapsed timezone', () => {
  const value=createEndpointDraft(journeyTrip,1,'end',places);
  const html=render(DayEndpointPicker,{trip:journeyTrip,places,value,onChange:noop,onSearch:noop,onSave:noop});
  assert.match(html,/Your stay tonight/); assert.match(html,/Preferred finish time/); assert.match(html,/Search another place/);
  assert.doesNotMatch(html,/Day start time|SECRET-/); assert.match(html,/<details class="endpoint-settings">/);
});
check('empty booking picker keeps current location and search available', () => {
  const empty={...journeyTrip,flights:[],stays:[],days:journeyTrip.days.map(day=>({...day,startStayId:undefined,endStayId:undefined}))};
  const html=render(DayEndpointPicker,{trip:empty,places,value:createEndpointDraft(empty,1,'start',places),onChange:noop,onSearch:noop,onSave:noop});
  assert.match(html,/No bookings match/); assert.match(html,/Current place/); assert.match(html,/Day start time/); assert.match(html,/Search another place/);
});
check('endpoint rows hide change actions for viewers', () => {
  const html=render(DayEndpointRow,{endpoint:'end',place:places.hotel,detail:'Arrive 18:00'});
  assert.match(html,/End at/); assert.match(html,/Arrive 18:00/); assert.doesNotMatch(html,/<button/);
});
check('legacy arrival repair survives removal of the daily booking cards', () => {
  const legacy={...trip,days:trip.days.map((day,index)=>index?day:{...day,startPlaceId:'from',endPlaceId:'to',endMode:'flight',endFlightId:'flight1'})};
  const html=render(IncomingFlightNotice,{trip:legacy,places,dayIndex:1,onStartFromFlight:noop});
  assert.match(html,/Continue after your flight/); assert.match(html,/Start this day at arrival airport/); assert.match(html,/starting place, start time and time zone/); assert.doesNotMatch(html,/SECRET-/);
  const viewer=render(IncomingFlightNotice,{trip:legacy,places,dayIndex:1});assert.doesNotMatch(viewer,/<button/);
  assert.equal(render(IncomingFlightNotice,{trip:journeyTrip,places,dayIndex:0}), '');
});
check('a matching booked hotel is one choice even when the endpoint was previously set manually', () => {
  const existing={...journeyTrip,days:journeyTrip.days.map(day=>({...day,endStayId:undefined}))};
  const value=createEndpointDraft(existing,0,'end',places);
  assert.deepEqual(value.choice,{kind:'stay',id:'journey-stay'});
  const html=render(DayEndpointPicker,{trip:existing,places,value,onChange:noop,onSearch:noop,onSave:noop});
  assert.equal((html.match(/Our stay/g)||[]).length,1); assert.doesNotMatch(html,/Current place/);
});
check('the morning hotel start does not show an airport repair after a planned midnight transfer', () => {
  const lateFlight={id:'late-arrival',fromPlaceId:'from',toPlaceId:'to',departure:{date:'2026-10-27',time:'22:15',timezone:'UTC'},arrival:{date:'2026-10-27',time:'23:20',timezone:'UTC'},arrivalBufferMinutes:60};
  const value={...createTrip('Late arrival','Dublin','2026-10-27',3),timezone:'UTC',customPlaces:places,flights:[lateFlight]};
  Object.assign(value.days[0],{startPlaceId:'from',endPlaceId:'hotel',endMode:'drive',items:[{aid:'landing',placeId:'to',mode:'flight',flightId:'late-arrival',duration:0,fixed:null,note:''}]});
  Object.assign(value.days[1],{startPlaceId:'hotel',endPlaceId:'hotel',startTime:540});
  assert.equal(render(IncomingFlightNotice,{trip:value,places,dayIndex:1,onStartFromFlight:noop}), '');
  assert.doesNotMatch(render(BookingEssentials,{trip:value,places,dayIndex:1,onStartFromFlight:noop}), /Start this day at arrival airport/);
  // If the previous day stops at the airport, the onward journey still needs planning.
  value.days[0].endPlaceId='to';
  assert.match(render(IncomingFlightNotice,{trip:value,places,dayIndex:1,onStartFromFlight:noop}),/Start this day at arrival airport/);
});

check('accommodation cards expose supplied bilingual offline addresses without private references',()=>{
 const authored={...places,hotel:{...places.hotel,area:'Transient provider address',offlineDetails:{name:'Our stay',address:'12 Saved Street',localAddress:'京都市 下京区 12'}}};
 const html=render(StayCard,{stay,places:authored});assert.match(html,/12 Saved Street/);assert.match(html,/京都市 下京区 12/);assert.match(html,/Copy address/);assert.doesNotMatch(html,/Transient provider address|SECRET-|Japanese address|English address/);
 const oneLanguage=render(StayCard,{stay,places:{...places,hotel:{...places.hotel,offlineDetails:{name:'Our stay',localAddress:'京都市 下京区 12'}}}});assert.match(oneLanguage,/京都市 下京区 12/);assert.match(oneLanguage,/Copy address/);
});
check('Today exposes offline access when progress cannot sync without promising downloaded maps',()=>{
 const html=render(TravelMode,{trip,places,dayIndex:1,onDayChange:noop,onEditPlan:noop,onBack:noop,marks:{},onSetState:noop,progressStatus:'offline',onOffline:noop,map:null,schedule:{rows:[],endLeg:{min:null,mode:'walk',km:'—'},travel:0,unknown:1,late:0,finish:540,finishApprox:true,wait:0}});
 assert.match(html,/Progress waiting to sync/);assert.match(html,/Check offline access/);assert.match(html,/Maps and fresh journey estimates need a connection/);assert.doesNotMatch(html,/Downloaded offline map|38 MB/);
 const source=readFileSync(resolve(root,'TravelMode.tsx'),'utf8');assert.match(source,/const online=useConnectivity\(\)/);assert.match(source,/!online \|\| status === 'offline'/);
});
console.log(`\n${checks} booking presentation checks passed.`);
