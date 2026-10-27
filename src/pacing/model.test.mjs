import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const cache=new Map(),root=dirname(fileURLToPath(import.meta.url));
function moduleURL(file){if(cache.has(file))return cache.get(file);let source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replaceAll('import.meta.env','({})');source=source.replace(/from (['"])([^'"]+)\1/g,(match,_,name)=>{if(!name.startsWith('.'))return `from ${JSON.stringify(import.meta.resolve(name))}`;const base=resolve(dirname(file),name),target=[base,base+'.ts'].find(existsSync);return `from ${JSON.stringify(moduleURL(target))}`;});const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');cache.set(file,url);return url;}
const model=await import(moduleURL(resolve(root,'../model.ts'))),pacing=await import(moduleURL(resolve(root,'model.ts'))),fixes=await import(moduleURL(resolve(root,'fixes.ts'))),traits=await import(moduleURL(resolve(root,'traits.ts')));
let count=0;async function check(name,run){await run();count++;console.log(`✓ ${name}`);}
const place=id=>({id,name:id,cat:'attr',x:0,y:0,area:'',typical:'',blurb:'',lat:51,lng:-.1});
const ready=(mode='walk',distanceMeters=1000,min=15)=>({mode,distanceMeters,walkingMeters:mode==='drive'?0:distanceMeters,min,km:(distanceMeters/1000).toFixed(1),status:'ready'});
const allDay={fetchedAt:0,regularHours:{periods:[{open:{day:0,hour:0,minute:0}}],weekdayDescriptions:[]}};
function fixture(){const trip=model.createTrip('Pace','London','2026-10-27',2);trip.timezone='UTC';trip.customPlaces=Object.fromEntries(['hotel','a','b','food','airport','arrival'].map(id=>[id,place(id)]));trip.days[0].items=['a','b'].map(aid=>({aid,placeId:aid,duration:180,fixed:null,mode:'walk',note:'',walkingMeters:500}));return {trip,dayIndex:0,places:model.getPlaces(trip),hours:{a:allDay,b:allDay,food:allDay}};}
const resolver=async(trip,index)=>Object.fromEntries([...trip.days[index].items.map(item=>[item.aid,ready(item.mode,item.aid==='a'?7000:1000)]),['return',ready(trip.days[index].endMode)]]);
const assess=(input,legs)=>pacing.assessPacing(input.trip,0,model.schedule(input.trip.days[0],input.places,legs,{trip:input.trip,dayIndex:0}),input.places);
const free=(kind='explore',duration=60,untilBooking=false)=>({id:'free-a',kind,duration,untilBooking});
await check('exploring and shopping count 1.5 km an hour separately from visit and route walking',async()=>{
 const x=fixture(),legs=await resolver(x.trip,0),baseline=assess(x,legs);x.trip.days[0].items[0].freeTime=free();
 const explored=assess(x,legs);assert.equal(explored.walking.freeTimeMeters,1500);assert.equal(explored.walking.knownMeters,baseline.walking.knownMeters+1500);
 assert.equal(explored.walking.routeMeters,baseline.walking.routeMeters);assert.equal(explored.walking.onSiteMeters,baseline.walking.onSiteMeters);assert.ok(explored.walking.estimatedVisitIds.includes('free-a'));
 x.trip.days[0].items[0].freeTime=free('shopping',30);assert.equal(assess(x,legs).walking.freeTimeMeters,750);
 x.trip.days[0].items[0].freeTime=free('nothing');assert.equal(assess(x,legs).walking.freeTimeMeters,0);
});
await check('walking uses available time until the booking instead of the requested hour',async()=>{
 const x=fixture(),legs=await resolver(x.trip,0);x.trip.days[0].items[0].freeTime=free('explore',60,true);x.trip.days[0].items[1].fixed=750;
 assert.equal(assess(x,legs).walking.freeTimeMeters,0);
 x.trip.days[0].items[1].fixed=780;assert.equal(assess(x,legs).walking.freeTimeMeters,750);
 x.trip.days[0].items[1].fixed=840;assert.equal(assess(x,legs).walking.freeTimeMeters,2250);
});
await check('a rest or café block of at least 30 minutes over lunch counts as a meal',async()=>{
 const x=fixture(),legs=await resolver(x.trip,0);x.trip.days[0].items[0].freeTime=free('rest',45);
 const result=assess(x,legs);assert.deepEqual(result.meals.map(m=>[m.activityId,m.start,m.end,m.kind]),[['free-a',735,780,'meal']]);assert.equal(result.gaps.length,0);
 x.trip.days[0].items[0].freeTime.duration=15;assert.equal(assess(x,legs).meals.length,0);assert.equal(assess(x,legs).gaps.length,1);
 x.trip.days[0].items[0].freeTime=free('rest',60,true);x.trip.days[0].items[1].fixed=770;assert.equal(assess(x,legs).meals.length,0);
});
await check('rest outside lunch and an uncertain free block do not claim a meal',async()=>{
 const x=fixture(),legs=await resolver(x.trip,0);x.trip.days[0].items[0].duration=75;x.trip.days[0].items[0].freeTime=free('rest',60);
 assert.equal(assess(x,legs).meals.length,0); // 10:30–11:30 only touches the lunch window.
 x.trip.days[0].items[0].duration=180;legs.a={mode:'walk',min:null,km:'—',status:'unavailable'};assert.equal(assess(x,legs).meals.length,0);
});
await check('post-flight rest uses the arrival location lunchtime and date',()=>{
 const x=fixture(),day=x.trip.days[0];x.trip.timezone='Pacific/Honolulu';day.startTime=1200;day.startPlaceId='airport';
 x.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'22:00',timezone:'Pacific/Honolulu'},arrival:{date:'2026-10-29',time:'06:00',timezone:'Asia/Tokyo'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 day.items=[{aid:'landing',placeId:'arrival',duration:0,fixed:null,mode:'flight',flightId:'f',note:'',freeTime:free('rest',330)},{aid:'a',placeId:'a',duration:60,fixed:null,mode:'walk',note:'',walkingMeters:0}];
 const result=assess(x,{a:ready('walk',100,15),return:ready('walk',100,15)});assert.equal(result.meals[0].date,'2026-10-29');assert.equal(result.meals[0].start,420);assert.equal(result.meals[0].end,750);assert.equal(result.gaps.length,0);
});
await check('pace defaults relaxed and day override wins without changing trip preference',async()=>{const x=fixture(),legs=await resolver(x.trip,0);assert.equal(assess(x,legs).limitMeters,8000);x.trip.pace='moderate';assert.equal(assess(x,legs).limitMeters,12000);x.trip.days[0].pace='active';assert.equal(assess(x,legs).limitMeters,16000);assert.equal(x.trip.pace,'moderate');});
await check('walking counts real numeric routes, transit walking only, end leg and visit estimates',async()=>{const x=fixture(),legs=await resolver(x.trip,0);x.trip.days[0].items[1].mode='transit';legs.b={...ready('transit',9000),walkingMeters:300};const result=assess(x,legs);assert.equal(result.walking.routeMeters,8300);assert.equal(result.walking.onSiteMeters,1000);assert.equal(result.walking.knownMeters,9300);assert.equal(result.walking.exceedsLimit,true);});
await check('display km and missing transit steps never become invented walking distances',async()=>{const x=fixture(),legs=await resolver(x.trip,0);legs.a={mode:'walk',min:15,km:'7.0',status:'ready'};legs.b={mode:'transit',min:15,km:'9.0',distanceMeters:9000,status:'ready'};delete x.trip.days[0].items[0].walkingMeters;const result=assess(x,legs);assert.deepEqual(result.walking.unknownLegIds,['a','b']);assert.deepEqual(result.walking.unknownVisitIds,['a']);assert.equal(result.walking.knownMeters,1500);});
await check('a long gap flags only when it covers the complete meal window',async()=>{const x=fixture(),legs=await resolver(x.trip,0);let result=assess(x,legs);assert.equal(result.gaps.length,1);assert.equal(result.gaps[0].window,'lunch');x.trip.days[0].startTime=720;result=assess(x,legs);assert.equal(result.gaps.some(g=>g.window==='lunch'),false);x.trip.days[0].startTime=810;result=assess(x,legs);assert.equal(result.gaps.some(g=>g.window==='lunch'),false);});
await check('snacks and food category do not erase a meal gap; explicit meal does',async()=>{const x=fixture();x.trip.customPlaces.a.cat='food';x.trip.days[0].items[0].meal='snack';let result=assess(x,await resolver(x.trip,0));assert.equal(result.gaps.length,1);x.trip.days[0].items[0].meal='meal';result=assess(x,await resolver(x.trip,0));assert.equal(result.gaps.length,0);});
await check('less than four hours and late-night gaps do not produce meal notices',async()=>{const x=fixture();x.trip.days[0].items.forEach(item=>item.duration=60);x.trip.days[0].startTime=660;assert.equal(assess(x,await resolver(x.trip,0)).gaps.length,0);x.trip.days[0].items.forEach(item=>item.duration=180);x.trip.days[0].startTime=1260;assert.equal(assess(x,await resolver(x.trip,0)).gaps.length,0);});
await check('unknown journeys suppress precise meal claims while preserving known walking',async()=>{const x=fixture(),legs=await resolver(x.trip,0);legs.b={mode:'walk',min:null,km:'—',status:'unavailable'};const result=assess(x,legs);assert.equal(result.timingComplete,false);assert.deepEqual(result.gaps,[]);assert.ok(result.walking.knownMeters>0);});
await check('sample traits are labelled estimates and authored choices override them',()=>{const item={aid:'x',placeId:'tea',duration:90,fixed:null,mode:'walk',note:''};assert.equal(traits.visitTraits(item,model.PLACES.tea).meal,'snack');assert.equal(traits.visitTraits(item,model.PLACES.tea).walkingSource,'sample');assert.equal(traits.visitTraits({...item,meal:'meal',walkingMeters:123},model.PLACES.tea).walkingMeters,123);assert.equal(traits.visitTraits(item,{...model.PLACES.tea,googlePlaceId:'real'}).walkingMeters,undefined);});
await check('verified taxi preview reduces walking and applies exactly one mode',async()=>{const x=fixture(),fix=await fixes.findPacingFix(x,{kind:'taxi',targetId:'activity:a'},{resolveRoutes:resolver});assert.ok(fix);assert.equal(fix.after.assessment.walking.knownMeters,3000);assert.equal(x.trip.days[0].items[0].mode,'walk');fixes.applyPacingFix(x.trip,fix);assert.equal(x.trip.days[0].items[0].mode,'drive');assert.equal(x.trip.days[0].items[1].mode,'walk');});
await check('meal insertion must actually resolve a gap without worsening walking excess',async()=>{const x=fixture();x.trip.pace='active';const before=assess(x,await resolver(x.trip,0)),fix=await fixes.findPacingFix(x,{kind:'meal-insert',place:x.places.food,insertIndex:1,gapId:before.gaps[0].id},{resolveRoutes:resolver});assert.ok(fix);assert.equal(fix.after.assessment.gaps.length,0);fixes.applyPacingFix(x.trip,fix);assert.equal(x.trip.days[0].items[1].meal,'meal');assert.equal(x.trip.days[0].items[1].duration,45);});
await check('unknown routes, unconfirmed restaurant hours and unsafe reservations never yield checked fixes',async()=>{const x=fixture();x.trip.pace='active';assert.equal(await fixes.findPacingFix(x,{kind:'taxi',targetId:'activity:a'},{resolveRoutes:async()=>({})}),null);delete x.hours.food;assert.equal(await fixes.findPacingFix(x,{kind:'meal-insert',place:x.places.food,insertIndex:1},{resolveRoutes:resolver}),null);x.hours.food=allDay;x.trip.days[0].items[1].fixed=750;assert.equal(await fixes.findPacingFix(x,{kind:'meal-insert',place:x.places.food,insertIndex:1},{resolveRoutes:resolver}),null);});
await check('expired or changed previews cannot mutate the trip and note edits survive',async()=>{const x=fixture(),fix=await fixes.findPacingFix(x,{kind:'taxi',targetId:'activity:a'},{resolveRoutes:resolver});assert.throws(()=>fixes.applyPacingFix(x.trip,fix,fix.verifiedAt+300001),/expired/);x.trip.days[0].items[0].note='Shared note';fixes.applyPacingFix(x.trip,fix);assert.equal(x.trip.days[0].items[0].note,'Shared note');const y=fixture(),other=await fixes.findPacingFix(y,{kind:'taxi',targetId:'activity:a'},{resolveRoutes:resolver});y.trip.days[0].pace='active';assert.throws(()=>fixes.applyPacingFix(y.trip,other),/changed/);});
await check('cancelled work never returns an actionable preview',async()=>{const x=fixture();await assert.rejects(()=>fixes.findPacingFix(x,{kind:'taxi',targetId:'activity:a'},{current:()=>false,resolveRoutes:resolver}),e=>e.name==='AbortError');});
await check('editing attached free time invalidates a reviewed pacing fix',async()=>{
 const x=fixture(),fix=await fixes.findPacingFix(x,{kind:'taxi',targetId:'activity:a'},{resolveRoutes:resolver});assert.ok(fix);x.trip.days[0].items[0].freeTime=free('rest');assert.throws(()=>fixes.applyPacingFix(x.trip,fix),/changed/);
});
await check('fresh restaurant hours are supplied to the route resolver for onward transit',async()=>{const x=fixture();x.trip.pace='active';x.places.food={...x.places.food,googlePlaceId:'restaurant'};let saw=false;await fixes.findPacingFix(x,{kind:'meal-insert',place:x.places.food,insertIndex:1},{fetchHours:async()=>allDay,resolveRoutes:async(trip,index,current,context)=>{if(context.hours.food?.regularHours)saw=true;return resolver(trip,index);}});assert.equal(saw,true);});
await check('exactly four hours covering lunch qualifies, 239 minutes does not',async()=>{
 const x=fixture();x.trip.days[0].startTime=590;x.trip.days[0].items=[{...x.trip.days[0].items[0],duration:210}];
 assert.equal(assess(x,await resolver(x.trip,0)).gaps.length,1);x.trip.days[0].items[0].duration=209;assert.equal(assess(x,await resolver(x.trip,0)).gaps.length,0);
});
await check('flight time is not mistaken for a missed ground-day meal',()=>{
 const x=fixture(),day=x.trip.days[0];day.startTime=480;day.startPlaceId='airport';day.endPlaceId='arrival';day.endMode='flight';day.endFlightId='f';day.items=[];
 x.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'10:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'18:00',timezone:'UTC'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 assert.equal(assess(x,{}).gaps.length,0);
});
await check('a late earlier airport stop does not erase safe free time before the final flight',()=>{
 const x=fixture(),day=x.trip.days[0];day.endPlaceId='arrival';day.endMode='flight';day.endFlightId='f';
 day.items=[{aid:'airport-stop',placeId:'airport',duration:60,fixed:540,mode:'walk',note:'',freeTime:free('rest',60,true)}];
 x.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'12:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'13:00',timezone:'UTC'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 const result=model.schedule(day,x.places,{'airport-stop':ready('walk',100,15)},{trip:x.trip,dayIndex:0});
 assert.equal(result.rows[0].late,15);assert.equal(result.rows[0].freeTime.duration,105);assert.equal(result.finishApprox,false);assert.equal(result.late,15);
});
await check('post-flight meal windows use the destination calendar and local clock',()=>{
 const x=fixture(),day=x.trip.days[0];x.trip.timezone='Pacific/Honolulu';day.startTime=1200;day.startPlaceId='airport';
 x.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'22:00',timezone:'Pacific/Honolulu'},arrival:{date:'2026-10-29',time:'06:00',timezone:'Asia/Tokyo'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 day.items=[{aid:'landing',placeId:'arrival',duration:0,fixed:null,mode:'flight',flightId:'f',note:''},{aid:'a',placeId:'a',duration:420,fixed:null,mode:'walk',note:'',walkingMeters:0}];
 const result=assess(x,{a:ready('walk',100,15),return:ready('walk',100,15)});assert.equal(result.gaps.length,1);assert.equal(result.gaps[0].date,'2026-10-29');assert.equal(result.gaps[0].window,'lunch');
});
await check('meal insertion cannot break an airport-to-airport flight link',async()=>{
 const x=fixture(),day=x.trip.days[0];day.startPlaceId='airport';day.endPlaceId='arrival';day.endMode='flight';day.endFlightId='f';day.items=[];
 x.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'16:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'17:00',timezone:'UTC'}}];
 assert.equal(await fixes.findPacingFix(x,{kind:'meal-insert',place:x.places.food,insertIndex:0},{resolveRoutes:resolver}),null);
});
await check('a taxi that arrives even later after an existing admission cutoff is not a safe fix',async()=>{
 const x=fixture();x.places.a.lastEntryMinutes={2:550};x.trip.customPlaces.a.lastEntryMinutes={2:550};x.hours.a={...allDay,lastEntryMinutes:{2:550}};
 const slower=async(trip,index)=>{const legs=await resolver(trip,index);if(trip.days[index].items[0].mode==='drive')legs.a.min=30;return legs;};
 assert.equal(await fixes.findPacingFix(x,{kind:'taxi',targetId:'activity:a'},{resolveRoutes:slower}),null);
});
await check('authoring offline details preserves scheduled sample traits and explicit overrides',async()=>{
 const {setPlaceOfflineDetails}=await import(moduleURL(resolve(root,'../placeOfflineDetails.ts')));
 const trip=model.seedTrip(),original=trip.days.flatMap(day=>day.items).find(item=>item.placeId==='kinkakuji');original.meal='snack';original.walkingMeters=1750;
 setPlaceOfflineDetails(trip,'kinkakuji',{name:'My saved temple',address:'My independently written address'},'custom-offline-kinkakuji');
 const item=trip.days.flatMap(day=>day.items).find(item=>item.aid===original.aid);
 assert.equal(item.placeId,'custom-offline-kinkakuji');assert.equal(item.walkingMeters,1750);assert.equal(item.meal,'snack');assert.equal(item.exposure,'outdoor');
 assert.equal(model.isTrip(trip),true);assert.equal(traits.visitTraits(item,trip.customPlaces[item.placeId]).walkingMeters,1750);
 const provider=fixture();provider.trip.customPlaces.a.googlePlaceId='provider-place';
 setPlaceOfflineDetails(provider.trip,'a',{name:'Saved provider venue'},'custom-unused');
 assert.equal(provider.trip.days[0].items[0].exposure,undefined);
});
console.log(`${count} pacing model and verified fix checks passed.`);
