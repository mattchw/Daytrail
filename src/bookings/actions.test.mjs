import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
globalThis.crypto ??= webcrypto;
const compile=(path,modules={})=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(match,_,name)=>modules[name]?`from ${JSON.stringify(modules[name])}`:match)).toString('base64');
const modelURL=compile('../model.ts');
const {createTrip,isTrip}=await import(modelURL);
const {linkFlight,unlinkFlight,saveFlight,deleteFlight,saveStay,applyStay,deleteStay,extendTripRange,startFromFlightArrival,setDayEndpoints,validateBookingLinks,linkFlightToJourney,saveFlightToJourney,setJourneyGroundMode}=await import(compile('./actions.ts',{'../model':modelURL}));
const place=(id,name=id)=>({id,name,cat:'custom',x:50,y:50,area:'',typical:'',blurb:''});
const fixture=()=>{const value=createTrip('Flight holiday','Japan','2027-05-14',3);value.customPlaces={departure:place('departure'),arrival:place('arrival'),stayA:place('stayA'),stayB:place('stayB')};return value;};
const flight=(patch={})=>({id:'flight-one',fromPlaceId:'departure',toPlaceId:'arrival',departure:{date:'2027-05-14',time:'11:00',timezone:'Europe/London'},arrival:{date:'2027-05-14',time:'23:00',timezone:'Asia/Tokyo'},airportBufferMinutes:120,arrivalBufferMinutes:60,bookingReference:'PRIVATE-REFERENCE',...patch});
const activity=(aid,placeId='nijo',rest={})=>({aid,placeId,duration:90,fixed:null,mode:'transit',note:'Keep my museum ticket note',...rest});
const stay=(patch={})=>({id:'stay-one',placeId:'stayA',checkInDate:'2027-05-14',checkOutDate:'2027-05-16',timezone:'Asia/Tokyo',...patch});
const clone=value=>structuredClone(value);
// Match App.commit: a failure never publishes its transaction draft.
const transaction=(value,change)=>{const draft=clone(value);change(draft);validateBookingLinks(draft);return draft;};
let passed=0,failed=0;
function check(name,run){try{run();passed++;console.log(`✓ ${name}`);}catch(error){failed++;console.error(`✗ ${name}: ${(error.stack||String(error)).replace(/data:text\/javascript;base64,[^ )]+/g,'[compiled module]')}`);}}

check('empty direct flight day uses exact airport endpoints and retains day identity',()=>{
 const value=fixture(),dayId=value.days[0].id;saveFlight(value,flight(),{dayId,targetId:`end:${dayId}`});
 assert.equal(value.days[0].id,dayId);assert.equal(value.days[0].startPlaceId,'departure');assert.equal(value.days[0].endPlaceId,'arrival');assert.equal(value.days[0].endMode,'flight');assert.equal(value.days[0].endFlightId,'flight-one');assert.equal(value.days[0].timezone,'Europe/London');assert.deepEqual(value.days[0].items,[]);assert.equal(isTrip(value),true);
});
check('midday flight insertion keeps attraction identity, booking time, notes and visit length',()=>{
 const value=fixture(),museum=activity('museum','nijo',{fixed:1200});value.days[0].items=[activity('breakfast','gion'),museum];
 saveFlight(value,flight(),{dayId:value.days[0].id,targetId:'activity:museum'});
 const items=value.days[0].items;assert.deepEqual(items.find(item=>item.aid==='museum'),museum);assert.deepEqual(items.map(item=>item.placeId),['gion','departure','arrival','nijo']);assert.equal(items[1].departureForFlightId,'flight-one');assert.equal(items[2].flightId,'flight-one');assert.equal(items[2].duration,0);assert.equal(isTrip(value),true);
});
check('linking into an existing arrival airport preserves its visit instead of inserting a duplicate',()=>{
 const value=fixture();value.days[0].startPlaceId='departure';value.days[0].items=[activity('airport-visit','arrival',{duration:45,note:'Meet family'})];saveFlight(value,flight(),{dayId:value.days[0].id,targetId:'activity:airport-visit'});
 assert.equal(value.days[0].items.length,1);assert.equal(value.days[0].items[0].aid,'airport-visit');assert.equal(value.days[0].items[0].duration,45);assert.equal(value.days[0].items[0].note,'Meet family');assert.equal(value.days[0].items[0].mode,'flight');assert.equal(isTrip(value),true);
});
check('unlink and delete keep airport places, activities and independent booking data',()=>{
 const value=fixture();value.days[0].items=[activity('museum')];saveFlight(value,flight(),{dayId:value.days[0].id,targetId:'activity:museum'});const ids=value.days[0].items.map(item=>item.aid),places=clone(value.customPlaces);unlinkFlight(value,'flight-one');
 assert.deepEqual(value.days[0].items.map(item=>item.aid),ids);assert.deepEqual(value.customPlaces,places);assert.equal(value.flights[0].bookingReference,'PRIVATE-REFERENCE');assert.equal(value.days[0].items.some(item=>item.flightId||item.departureForFlightId),false);assert.equal(isTrip(value),true);
 deleteFlight(value,'flight-one');assert.deepEqual(value.days[0].items.map(item=>item.aid),ids);assert.deepEqual(value.customPlaces,places);assert.deepEqual(value.flights,[]);assert.equal(isTrip(value),true);
});
check('unlinking an airport anchor preserves a traveller-edited fixed time',()=>{
 const value=fixture();value.days[0].items=[activity('museum')];saveFlight(value,flight(),{dayId:value.days[0].id,targetId:'activity:museum'});const anchor=value.days[0].items.find(item=>item.departureForFlightId);anchor.fixed=420;anchor.note='Meet travel partner at 07:00';unlinkFlight(value,'flight-one');
 assert.equal(anchor.fixed,420);assert.equal(anchor.note,'Meet travel partner at 07:00');
});
check('applying a stay changes only selected eligible endpoints and preserves airport overrides',()=>{
 const value=fixture();saveStay(value,stay());value.days[1].endPlaceId='arrival';const before=clone(value.days[2]);applyStay(value,'stay-one',[value.days[0].id,value.days[1].id]);
 assert.equal(value.days[0].startStayId,undefined);assert.equal(value.days[0].endStayId,'stay-one');assert.equal(value.days[0].endPlaceId,'stayA');assert.equal(value.days[1].startStayId,'stay-one');assert.equal(value.days[1].endPlaceId,'arrival');assert.deepEqual(value.days[2],before);assert.equal(isTrip(value),true);
});
check('overlapping stays do not silently choose one property',()=>{
 const value=fixture();saveStay(value,stay());saveStay(value,stay({id:'stay-two',placeId:'stayB'}));const before=clone(value.days);applyStay(value,'stay-one');assert.deepEqual(value.days,before);
});
check('stay edit updates previously accepted places and preserves manual overrides',()=>{
 const value=fixture();saveStay(value,stay());applyStay(value,'stay-one');value.days[1].endPlaceId='arrival';delete value.days[1].endStayId;
 saveStay(value,stay({placeId:'stayB'}));assert.equal(value.days[0].endPlaceId,'stayB');assert.equal(value.days[1].startPlaceId,'stayB');assert.equal(value.days[1].endPlaceId,'arrival');assert.equal(isTrip(value),true);
});
check('deleting accommodation detaches booking links but keeps chosen day locations',()=>{
 const value=fixture();saveStay(value,stay());applyStay(value,'stay-one');const endpoints=value.days.map(day=>[day.startPlaceId,day.endPlaceId]);deleteStay(value,'stay-one');assert.deepEqual(value.days.map(day=>[day.startPlaceId,day.endPlaceId]),endpoints);assert.equal(value.days.some(day=>day.startStayId||day.endStayId),false);assert.equal(isTrip(value),true);
});
check('extending both ends preserves original day and activity IDs and booking dates',()=>{
 const value=fixture();value.days[0].items=[activity('museum')];saveFlight(value,flight());saveStay(value,stay());const before=clone(value);extendTripRange(value,'2027-05-13','2027-05-18');assert.equal(value.startDate,'2027-05-13');assert.equal(value.days.length,6);assert.deepEqual(value.days.slice(1,4).map(day=>day.id),before.days.map(day=>day.id));assert.deepEqual(value.days[1].items,before.days[0].items);assert.deepEqual(value.flights,before.flights);assert.deepEqual(value.stays,before.stays);assert.equal(new Set(value.days.map(day=>day.id)).size,6);assert.equal(isTrip(value),true);
});
check('extension and failed link attempts leave the committed plan intact',()=>{
 const value=fixture(),before=clone(value);assert.throws(()=>transaction(value,draft=>extendTripRange(draft,'2027-04-01','2027-06-30')),/30 days/);assert.deepEqual(value,before);
 assert.throws(()=>transaction(value,draft=>saveFlight(draft,flight(),{dayId:draft.days[1].id,targetId:`end:${draft.days[1].id}`})),/departure date/);assert.deepEqual(value,before);
});
check('linked flight airport and departure date changes require explicit unlinking',()=>{
 const value=fixture();saveFlight(value,flight(),{dayId:value.days[0].id,targetId:`end:${value.days[0].id}`});const before=clone(value);
 for(const changed of [flight({fromPlaceId:'nijo'}),flight({toPlaceId:'gion'}),flight({departure:{...flight().departure,date:'2027-05-15'}})])assert.throws(()=>transaction(value,draft=>saveFlight(draft,changed)),/Unlink/);assert.deepEqual(value,before);
});
check('linked flight arrival outside the trip requires extension or unlinking first',()=>{
 const value=fixture();saveFlight(value,flight(),{dayId:value.days[0].id,targetId:`end:${value.days[0].id}`});const before=clone(value);
 assert.throws(()=>transaction(value,draft=>saveFlight(draft,flight({arrival:{...flight().arrival,date:'2027-05-18'}}))),/extend|unlink/i);assert.deepEqual(value,before);
});
check('unlinked future flight can be saved as a booking without inventing itinerary days',()=>{
 const value=fixture(),days=clone(value.days);saveFlight(value,flight({departure:{...flight().departure,date:'2028-01-01'},arrival:{...flight().arrival,date:'2028-01-02'}}));assert.deepEqual(value.days,days);assert.equal(value.flights.length,1);assert.equal(isTrip(value),true);
});
check('flight adjacency validation blocks a drag that would detach the departure airport',()=>{
 const value=fixture();value.days[0].items=[activity('museum')];saveFlight(value,flight(),{dayId:value.days[0].id,targetId:'activity:museum'});const before=clone(value);
 assert.throws(()=>transaction(value,draft=>draft.days[0].items.unshift(draft.days[0].items.splice(1,1)[0])),/break a flight or stay link/);assert.deepEqual(value,before);
});
check('retiming a direct flight updates only its unchanged generated airport start',()=>{
 const value=fixture();saveFlight(value,flight(),{dayId:value.days[0].id,targetId:`end:${value.days[0].id}`});const updated=flight({departure:{...flight().departure,time:'12:00'}});saveFlight(value,updated);assert.equal(value.days[0].startTime,600);value.days[0].startTime=450;saveFlight(value,flight());assert.equal(value.days[0].startTime,450);
});
check('arrival-day start is explicitly applied with destination zone and exit buffer',()=>{
 const value=fixture();const overnight=flight({arrival:{...flight().arrival,date:'2027-05-15',time:'08:00'}});saveFlight(value,overnight,{dayId:value.days[0].id,targetId:`end:${value.days[0].id}`});const day=value.days[1];day.finishBy=500;startFromFlightArrival(value,overnight.id,day.id);assert.equal(day.startPlaceId,'arrival');assert.equal(day.startTime,540);assert.equal(day.timezone,'Asia/Tokyo');assert.equal(day.finishBy,null);assert.equal(isTrip(value),true);
});
check('airport exit on the following calendar date cannot be applied to the landing date',()=>{
 const value=fixture();saveFlight(value,flight(),{dayId:value.days[0].id,targetId:`end:${value.days[0].id}`});assert.throws(()=>startFromFlightArrival(value,'flight-one',value.days[0].id),/day when you will leave/);startFromFlightArrival(value,'flight-one',value.days[1].id);assert.equal(value.days[1].startTime,0);
});
check('a direct flight can end at accommodation without losing the booked airport leg',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight(),{dayId:day.id,targetId:`end:${day.id}`});const booking=clone(value.flights[0]),dayId=day.id;
 setDayEndpoints(value,dayId,'departure','stayA');
 assert.equal(day.id,dayId);assert.equal(day.startPlaceId,'departure');assert.equal(day.endPlaceId,'stayA');assert.equal(day.endMode,'drive');assert.equal(day.endFlightId,undefined);
 assert.equal(day.items.length,1);assert.equal(day.items[0].placeId,'arrival');assert.equal(day.items[0].mode,'flight');assert.equal(day.items[0].flightId,'flight-one');assert.equal(day.items[0].duration,0);assert.deepEqual(value.flights[0],booking);assert.equal(isTrip(value),true);
});
check('home to airport to flight to accommodation keeps one flight and both ground transfers',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight(),{dayId:day.id,targetId:`end:${day.id}`});day.timezone='Asia/Tokyo';day.startTime=600;
 setDayEndpoints(value,day.id,'stayB','stayA');
 assert.deepEqual(day.items.map(item=>[item.placeId,item.mode]),[['departure','drive'],['arrival','flight']]);
 assert.equal(day.items[0].departureForFlightId,'flight-one');assert.equal(day.items[0].fixed,1020);assert.equal(day.items[0].duration,120);
 assert.equal(day.items[1].flightId,'flight-one');assert.equal(day.startPlaceId,'stayB');assert.equal(day.endPlaceId,'stayA');assert.equal(day.endMode,'drive');assert.equal(day.endFlightId,undefined);assert.equal(isTrip(value),true);
 const ids=day.items.map(item=>item.aid);setDayEndpoints(value,day.id,'stayB','stayA');assert.deepEqual(day.items.map(item=>item.aid),ids,'repeat save must not duplicate airport stops');
});
check('changing only a direct flight departure adds its airport anchor and preserves finalflight',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight(),{dayId:day.id,targetId:`end:${day.id}`});
 setDayEndpoints(value,day.id,'stayB','arrival');assert.equal(day.items.length,1);assert.equal(day.items[0].placeId,'departure');assert.equal(day.items[0].departureForFlightId,'flight-one');assert.equal(day.endFlightId,'flight-one');assert.equal(day.endMode,'flight');assert.equal(isTrip(value),true);
});
check('endpoint changes preserve existing attraction IDs, reservations, notes and flight links',()=>{
 const value=fixture(),day=value.days[0];day.items=[activity('breakfast','gion'),activity('museum','nijo',{fixed:1200})];saveFlight(value,flight(),{dayId:day.id,targetId:`end:${day.id}`});const before=clone(day.items),bookings=clone(value.flights);
 setDayEndpoints(value,day.id,'stayB','stayA');assert.deepEqual(day.items.slice(0,before.length),before);assert.deepEqual(value.flights,bookings);assert.equal(day.items.at(-1).flightId,'flight-one');assert.equal(isTrip(value),true);
});
check('an existing initial flight activity retains identity when a ground departure is prepended',()=>{
 const value=fixture(),day=value.days[0];day.startPlaceId='departure';day.items=[activity('arriving','arrival',{duration:45,note:'Meet family'}),activity('museum','nijo')];saveFlight(value,flight(),{dayId:day.id,targetId:'activity:arriving'});const before=clone(day.items);
 setDayEndpoints(value,day.id,'stayB','stayA');assert.deepEqual(day.items.slice(1),before);assert.equal(day.items[0].departureForFlightId,'flight-one');assert.equal(isTrip(value),true);
});
check('only changed manual endpoints lose stay source markers',()=>{
 const value=fixture(),day=value.days[1];saveStay(value,stay());applyStay(value,'stay-one');assert.equal(day.startStayId,'stay-one');assert.equal(day.endStayId,'stay-one');
 setDayEndpoints(value,day.id,'stayB','stayA');assert.equal(day.startStayId,undefined);assert.equal(day.endStayId,'stay-one');assert.equal(isTrip(value),true);
});
check('endpoint transfer capacity and stale places fail without publishing a broken trip',()=>{
 const value=fixture(),day=value.days[0];day.items=Array.from({length:99},(_,i)=>activity(`visit-${i}`));saveFlight(value,flight(),{dayId:day.id,targetId:`end:${day.id}`});const before=clone(value);
 assert.throws(()=>transaction(value,draft=>setDayEndpoints(draft,day.id,'stayB','stayA')),/day is full/);assert.deepEqual(value,before);
 assert.throws(()=>transaction(value,draft=>setDayEndpoints(draft,day.id,'unknown','arrival')),/saved location/);assert.deepEqual(value,before);
});
check('transport linking into an empty airport-to-hotel route preserves the hotel and manual day settings',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());saveStay(value,stay());
 Object.assign(day,{startPlaceId:'departure',endPlaceId:'stayA',endStayId:'stay-one',startTime:495,timezone:'Europe/Dublin',endMode:'drive',finishBy:1380});
 const before=clone(day);linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`});const linked=value.days[0];
 assert.equal(linked.startPlaceId,before.startPlaceId);assert.equal(linked.endPlaceId,'stayA');assert.equal(linked.endStayId,'stay-one');assert.equal(linked.startTime,495);assert.equal(linked.timezone,'Europe/Dublin');assert.equal(linked.finishBy,1380);assert.equal(linked.endMode,'drive');
 assert.equal(linked.items.length,1);assert.equal(linked.items[0].placeId,'arrival');assert.equal(linked.items[0].duration,0);assert.equal(linked.items[0].flightId,'flight-one');assert.equal(isTrip(value),true);
});
check('transport linking an exact empty airport pair does not reset the manually chosen start time',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());Object.assign(day,{startPlaceId:'departure',endPlaceId:'arrival',startTime:495,timezone:'Europe/Dublin'});
 linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`});
 assert.equal(value.days[0].startTime,495);assert.equal(value.days[0].timezone,'Europe/Dublin');assert.equal(value.days[0].endFlightId,'flight-one');assert.deepEqual(value.days[0].items,[]);
});
check('repeated flight-to-ground-to-flight cycles keep the hotel without invented airport visits',()=>{
 const value=fixture(),dayId=value.days[0].id;saveFlight(value,flight());saveStay(value,stay());Object.assign(value.days[0],{startPlaceId:'departure',endPlaceId:'stayA',endStayId:'stay-one',startTime:495,timezone:'Europe/Dublin',endMode:'drive'});
 const booking=clone(value.flights);
 for(const mode of ['walk','transit','drive']){
   linkFlightToJourney(value,'flight-one',{dayId,targetId:`end:${dayId}`});const landing=value.days[0].items[0];
   setJourneyGroundMode(value,{dayId,targetId:`activity:${landing.aid}`},mode);
   assert.deepEqual(value.days[0].items,[]);assert.equal(value.days[0].endMode,mode);assert.equal(value.days[0].endPlaceId,'stayA');assert.equal(value.days[0].endStayId,'stay-one');assert.equal(value.days[0].startTime,495);assert.deepEqual(value.flights,booking);assert.equal(isTrip(value),true);
 }
 linkFlightToJourney(value,'flight-one',{dayId,targetId:`end:${dayId}`});assert.equal(value.days[0].items.length,1);assert.equal(value.days[0].items[0].duration,0);assert.equal(value.days[0].endPlaceId,'stayA');
});
check('a real landing visit retains its identity, duration, fixed time and notes through transport changes',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());day.startPlaceId='departure';day.endPlaceId='stayA';day.items=[activity('meet-family','arrival',{duration:45,fixed:1230,note:'Meet family at arrivals'})];
 const original=clone(day.items[0]),target={dayId:day.id,targetId:'activity:meet-family'};
 linkFlightToJourney(value,'flight-one',target);setJourneyGroundMode(value,target,'drive');linkFlightToJourney(value,'flight-one',target);
 assert.deepEqual(value.days[0].items[0],{...original,mode:'flight',flightId:'flight-one'});assert.equal(value.days[0].endPlaceId,'stayA');
});
check('switching away from a generated flight removes its generated check-in anchor as well',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());Object.assign(day,{startPlaceId:'stayB',endPlaceId:'stayA',startTime:495,endMode:'transit'});
 linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`});assert.equal(value.days[0].items.length,2);const landing=value.days[0].items[1];
 setJourneyGroundMode(value,{dayId:day.id,targetId:`activity:${landing.aid}`},'drive');
 assert.deepEqual(value.days[0].items,[]);assert.equal(value.days[0].startPlaceId,'stayB');assert.equal(value.days[0].endPlaceId,'stayA');assert.equal(value.days[0].endMode,'drive');assert.equal(value.days[0].startTime,495);
});
check('a traveller-edited check-in anchor is retained as a real airport stop when unlinking transport',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());Object.assign(day,{startPlaceId:'stayB',endPlaceId:'stayA'});
 linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`});value.days[0].items[0].note='Meet our travel partner here';const anchor=clone(value.days[0].items[0]),landing=value.days[0].items[1];
 setJourneyGroundMode(value,{dayId:day.id,targetId:`activity:${landing.aid}`},'walk');delete anchor.departureForFlightId;
 assert.deepEqual(value.days[0].items,[anchor]);assert.equal(value.days[0].endMode,'walk');
});
check('removing a synthetic landing applies the requested ground mode to the next actual stop',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());day.startPlaceId='departure';day.endPlaceId='stayA';day.items=[activity('museum')];
 linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:'activity:museum'});const landing=value.days[0].items[0];
 setJourneyGroundMode(value,{dayId:day.id,targetId:`activity:${landing.aid}`},'transit');
 assert.equal(value.days[0].items.length,1);assert.equal(value.days[0].items[0].aid,'museum');assert.equal(value.days[0].items[0].mode,'transit');assert.equal(value.days[0].items[0].note,'Keep my museum ticket note');
});
check('stale journey endpoints or mode cannot be overwritten by a delayed flight-picker save',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());Object.assign(day,{startPlaceId:'departure',endPlaceId:'stayA',endMode:'drive'});
 const target={dayId:day.id,targetId:`end:${day.id}`},expected={fromPlaceId:'departure',toPlaceId:'stayA',mode:'drive',flightId:null};
 for(const change of [draft=>draft.days[0].startPlaceId='stayB',draft=>draft.days[0].endPlaceId='stayB',draft=>draft.days[0].endMode='walk']){
   const changed=clone(value);change(changed);const before=clone(changed);
   assert.throws(()=>saveFlightToJourney(changed,flight({id:'new-booking'}),target,expected),/changed/);assert.deepEqual(changed,before);
 }
});
check('missing activity targets never fall back to changing the final journey',()=>{
 const value=fixture();saveFlight(value,flight());const before=clone(value),target={dayId:value.days[0].id,targetId:'activity:deleted'};
 assert.throws(()=>setJourneyGroundMode(value,target,'drive'),/journey changed/);assert.deepEqual(value,before);
 assert.throws(()=>linkFlightToJourney(value,'flight-one',target),/journey changed/);assert.deepEqual(value,before);
});
check('linking the already selected flight is idempotent but using it elsewhere is rejected',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());Object.assign(day,{startPlaceId:'departure',endPlaceId:'stayA'});
 linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`});const target={dayId:day.id,targetId:`activity:${value.days[0].items[0].aid}`},before=clone(value);
 linkFlightToJourney(value,'flight-one',target);assert.deepEqual(value,before);
 assert.throws(()=>linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`}),/another journey/);assert.deepEqual(value,before);
});
check('capacity and annotated zero-duration landing failures leave the full trip unchanged',()=>{
 const value=fixture(),day=value.days[0];saveFlight(value,flight());day.endPlaceId='stayA';day.items=Array.from({length:99},(_,index)=>activity(`visit-${index}`));const before=clone(value);
 assert.throws(()=>linkFlightToJourney(value,'flight-one',{dayId:day.id,targetId:`end:${day.id}`}),/day is full/);assert.deepEqual(value,before);
 const other=fixture();saveFlight(other,flight());other.days[0].startPlaceId='departure';other.days[0].endPlaceId='stayA';linkFlightToJourney(other,'flight-one',{dayId:other.days[0].id,targetId:`end:${other.days[0].id}`});other.days[0].items[0].note='Important meeting note';const saved=clone(other);
 assert.throws(()=>setJourneyGroundMode(other,{dayId:other.days[0].id,targetId:`activity:${other.days[0].items[0].aid}`},'drive'),/visit duration/);assert.deepEqual(other,saved);
});
console.log(`\n${passed} booking action checks passed; ${failed} failed.`);if(failed)process.exitCode=1;
