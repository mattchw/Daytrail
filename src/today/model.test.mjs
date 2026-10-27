import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const url=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const modelURL=url(compile('../model.ts')),travelURL=url(compile('../travel/model.ts')),openingURL=url(compile('../openingHours.ts'));
const visitURL=url(compile('../visitHours.ts').replace(/from ['"]\.\/openingHours['"]/g,`from ${JSON.stringify(openingURL)}`));
const replace=source=>source.replace(/from ['"]\.\.\/model['"]/g,`from ${JSON.stringify(modelURL)}`).replace(/from ['"]\.\.\/travel\/model['"]/g,`from ${JSON.stringify(travelURL)}`).replace(/from ['"]\.\.\/visitHours['"]/g,`from ${JSON.stringify(visitURL)}`);
const todayURL=url(replace(compile('./model.ts')));
const model=await import(modelURL),today=await import(todayURL);
const actions=await import(url(replace(compile('./actions.ts')).replace(/from ['"]\.\/model['"]/g,`from ${JSON.stringify(todayURL)}`)));
const googleURL=url(compile('../googleMaps.ts').replaceAll('import.meta.env','({})'));
const routeSource=replace(compile('./useTodayRoutes.ts')).replace(/from ['"]react['"]/g,`from ${JSON.stringify(import.meta.resolve('react'))}`).replace(/from ['"]\.\.\/googleMaps['"]/g,`from ${JSON.stringify(googleURL)}`).replace(/from ['"]\.\/model['"]/g,`from ${JSON.stringify(todayURL)}`);
const routes=await import(url(routeSource));
let count=0;const check=async(name,run)=>{await run();count++;console.log(`✓ ${name}`);};
const at=(time,date='2026-10-27')=>Date.parse(`${date}T${time}:00Z`),minute=value=>new Date(value).toISOString().slice(11,16);
const place=id=>({id,name:id.toUpperCase(),cat:'custom',x:0,y:0,area:'',typical:'',blurb:'',lat:51.5,lng:-0.1});
function fixture(){
  const trip=model.createTrip('Today test','Test city','2026-10-27',2);trip.timezone='UTC';
  for(const id of ['hotel','a','b','c','airport','arrival'])trip.customPlaces[id]=place(id);
  const item=(aid,duration,fixed=null)=>({aid,placeId:aid,duration,fixed,mode:'walk',note:''});
  trip.days[0]={...trip.days[0],startTime:540,startPlaceId:'hotel',endPlaceId:'hotel',endMode:'walk',items:[item('a',60),item('b',60,720),item('c',30)]};
  const places=model.getPlaces(trip),legs=Object.fromEntries(['a','b','c','return'].map(key=>[key,{mode:'walk',min:10,km:'1',status:'ready'}]));
  return {trip,dayIndex:0,places,schedule:model.schedule(trip.days[0],places,legs,{trip,dayIndex:0}),marks:{},now:at('09:00')};
}
const visitRuntime=(options,extra={})=>({...today.initialTodayRuntime(options),phase:'visit',targetId:'activity:a',placeId:'a',since:at('09:15'),leaveAt:at('10:15'),updatedAt:at('09:15'),...extra});

await check('clock advances estimates without completing or skipping any visit',()=>{
  const options=fixture(),early=today.buildTodayProjection(options),late=today.buildTodayProjection({...options,now:at('11:00')});
  assert.equal(early.phase,'start');assert.equal(early.next.target.id,'activity:a');assert.equal(minute(early.next.start),'09:10');
  assert.equal(late.phase,'start');assert.equal(late.next.target.id,'activity:a');assert.equal(late.booking.lateMinutes,20);assert.deepEqual(options.marks,{});
});
await check('actual visit exposes countdown and shifts later estimates while respecting pinned starts',()=>{
  const options=fixture(),projection=today.buildTodayProjection({...options,now:at('09:30'),runtime:visitRuntime(options)});
  assert.equal(projection.current.target.id,'activity:a');assert.equal(projection.next.target.id,'activity:b');assert.equal(projection.leaveInMinutes,45);
  assert.equal(minute(projection.next.arrival),'10:25');assert.equal(minute(projection.next.start),'12:00');assert.equal(projection.booking.slackMinutes,95);
});
await check('overstaying keeps current visit active and reflows from now',()=>{
  const options=fixture(),projection=today.buildTodayProjection({...options,now:at('12:30'),runtime:visitRuntime(options)});
  assert.equal(projection.phase,'visit');assert.equal(projection.leaveInMinutes,-135);assert.equal(minute(projection.next.arrival),'12:40');assert.equal(projection.booking.lateMinutes,40);
});
await check('missing journey remains unknown through a pinned booking',()=>{
  const options=fixture();options.schedule.rows[0].leg={mode:'walk',min:null,km:'—',status:'unavailable'};
  const projection=today.buildTodayProjection(options);assert.equal(projection.next.start,null);assert.equal(projection.booking.slackMinutes,null);assert.equal(projection.finish,null);assert.ok(projection.unknown>0);
});
await check('skipping does not reuse the old route from a different origin',()=>{
  const options=fixture();options.marks={'activity:a':'skipped'};const projection=today.buildTodayProjection(options);
  assert.equal(projection.next.target.id,'activity:b');assert.equal(projection.next.leg.min,null);assert.equal(projection.next.start,null);
  const verified=today.buildTodayProjection({...options,verifiedRoutes:{[today.todayRouteKey('hotel','b','walk')]:{mode:'walk',min:5,km:'0.5',status:'ready'}}});
  assert.equal(minute(verified.next.arrival),'09:05');assert.equal(minute(verified.next.start),'12:00');
});
await check('done marks advance the known origin while skipped marks do not',()=>{
  const options=fixture();options.marks={'activity:a':'done'};const projection=today.buildTodayProjection(options);
  assert.equal(projection.originPlaceId,'a');assert.equal(projection.next.leg.min,10);assert.equal(projection.next.target.id,'activity:b');
});
await check('future or past dates show the planned day and cannot record live actions',()=>{
  const options={...fixture(),now:at('10:00','2026-10-26')},projection=today.buildTodayProjection(options);
  assert.equal(projection.canAct,false);assert.equal(minute(projection.next.start),'09:10');assert.deepEqual(today.buildTodayFixes(options),[]);
  assert.throws(()=>actions.planTodayAction(options,projection,'leave'),/current trip day/);
});
await check('deleted or reset active targets invalidate local runtime safely',()=>{
  const options=fixture(),runtime=visitRuntime(options);options.marks={'activity:a':'done'};
  const projection=today.buildTodayProjection({...options,runtime});assert.equal(projection.stale,true);assert.equal(projection.phase,'start');assert.equal(projection.next.target.id,'activity:b');
});
await check('known live route changes propagate through unpinned visits and deltas',()=>{
  const options=fixture();options.trip.days[0].items[1].fixed=null;
  const projection=today.buildTodayProjection({...options,verifiedRoutes:{[today.todayRouteKey('hotel','a','walk')]:{mode:'walk',min:30,km:'2',status:'ready'}}});
  assert.equal(projection.next.delayMinutes,20);assert.equal(minute(projection.rows[1].arrival),'10:40');
});
await check('transit estimates for a different departure are not silently reused',()=>{
  const options=fixture();options.trip.days[0].items[0].mode='transit';options.schedule.rows[0].leg.mode='transit';
  assert.equal(today.buildTodayProjection({...options,now:at('11:00')}).next.leg.min,null);
  const projection=today.buildTodayProjection({...options,now:at('11:00'),verifiedRoutes:{[today.todayRouteKey('hotel','a','transit')]:{mode:'transit',min:20,km:'3',status:'ready'}}});
  assert.equal(minute(projection.next.arrival),'11:20');
});
await check('fixed bookings keep their original clock after a delayed visit',()=>{
  const options={...fixture(),now:at('13:00')},projection=today.buildTodayProjection(options);
  assert.equal(projection.booking.time,at('12:00'));assert.equal(projection.booking.lateMinutes,140);
});
await check('opening waits use actual projected weekday and do not pin a flexible activity',()=>{
  const options=fixture();options.hoursByPlace={a:{fetchedAt:at('08:00'),regularHours:{periods:[{open:{day:2,hour:10,minute:0},close:{day:2,hour:17,minute:0}}],weekdayDescriptions:[]}}};
  const projection=today.buildTodayProjection(options);assert.equal(minute(projection.next.start),'10:00');assert.equal(projection.next.waitMinutes,50);assert.equal(options.trip.days[0].items[0].fixed,null);
});
await check('leaving and arrival are explicit distinct transitions without early completion',()=>{
  const options=fixture(),projection=today.buildTodayProjection(options),leaving=actions.planTodayAction(options,projection,'leave');
  assert.equal(leaving.runtime.phase,'travel');assert.equal(leaving.runtime.targetId,'activity:a');assert.equal(leaving.mark,undefined);
  const travelling={...options,runtime:leaving.runtime,now:at('09:03')},arrived=actions.planTodayAction(travelling,today.buildTodayProjection(travelling),'arrive');
  assert.equal(arrived.runtime.phase,'visit');assert.equal(arrived.runtime.since,at('09:03'));assert.equal(arrived.runtime.leaveAt,at('10:03'),'actual early arrival overrides estimated journey time');assert.equal(arrived.mark,undefined);
});
await check('arriving early at a pinned booking waits until booked start',()=>{
  const options={...fixture(),now:at('11:00'),marks:{'activity:a':'done'}};const arrived=actions.planTodayAction(options,today.buildTodayProjection(options),'arrive');
  assert.equal(arrived.runtime.leaveAt,at('13:00'));assert.equal(arrived.runtime.since,at('11:00'));
});
await check('arriving before opening records actual presence and waiting time',()=>{
  const options=fixture();options.hoursByPlace={a:{fetchedAt:at('08:00'),regularHours:{periods:[{open:{day:2,hour:10,minute:0},close:{day:2,hour:17,minute:0}}],weekdayDescriptions:[]}}};
  const arrived=actions.planTodayAction(options,today.buildTodayProjection(options),'arrive');assert.equal(arrived.runtime.leaveAt,at('11:00'));
});
await check('Stay 15 extends from now when overdue and leaves itinerary duration intact',()=>{
  const options={...fixture(),now:at('11:00')};options.runtime=visitRuntime(options);const extended=actions.planTodayAction(options,today.buildTodayProjection(options),'extend');
  assert.equal(extended.runtime.leaveAt,at('11:15'));assert.equal(options.trip.days[0].items[0].duration,60);assert.equal(extended.previous.leaveAt,at('10:15'));
});
await check('leaving a visit produces one reversible progress mark and next journey',()=>{
  const options={...fixture(),now:at('10:00')};options.runtime=visitRuntime(options);const change=actions.planTodayAction(options,today.buildTodayProjection(options),'leave');
  assert.deepEqual(change.mark,{targetId:'activity:a',previous:'planned',expected:'done'});assert.equal(change.runtime.targetId,'activity:b');assert.equal(change.previous.phase,'visit');
  const marks={...options.marks,[change.mark.targetId]:change.mark.expected};assert.equal(today.buildTodayProjection({...options,marks,runtime:change.runtime}).phase,'travel');
  marks[change.mark.targetId]=change.mark.previous;assert.equal(today.buildTodayProjection({...options,marks,runtime:change.previous}).phase,'visit');
});
await check('stale action and structural fix cannot touch a changed day',()=>{
  const options=fixture(),projection=today.buildTodayProjection(options),fix=today.buildTodayFixes(options).find(fix=>fix.action.kind==='shorten');
  options.trip.days[0].items.reverse();assert.throws(()=>actions.planTodayAction(options,projection,'leave'),/itinerary changed/);assert.throws(()=>actions.applyTodayFix(options.trip,0,fix),/itinerary changed/);
});
await check('fix previews preserve pinned bookings and only expose verified driving',()=>{
  const options=fixture(),fixes=today.buildTodayFixes(options);assert.ok(fixes.some(fix=>fix.action.kind==='shorten'));assert.ok(fixes.some(fix=>fix.action.kind==='skip'));
  assert.ok(!fixes.some(fix=>fix.action.activityId==='b'));assert.ok(!fixes.some(fix=>fix.action.kind==='drive'));
  const drive=today.buildTodayFixes({...options,verifiedRoutes:{[today.todayRouteKey('hotel','a','drive')]:{mode:'drive',min:3,km:'1',status:'ready'}}}).find(fix=>fix.action.kind==='drive');assert.ok(drive);assert.match(drive.detail,/3-minute/);
});
await check('skip previews stay unknown until shortcut was actually checked',()=>{
  const options=fixture(),fix=today.buildTodayFixes(options).find(fix=>fix.action.kind==='skip'&&fix.action.activityId==='a');assert.equal(fix.resolves,false);assert.match(fix.outcome,/needs a route estimate/);
  const checked=today.buildTodayFixes({...options,verifiedRoutes:{[today.todayRouteKey('hotel','b','walk')]:{mode:'walk',min:15,km:'1',status:'ready'}}}).find(fix=>fix.action.kind==='skip'&&fix.action.activityId==='a');assert.equal(checked.resolves,true);
});
await check('skip applies only to its exact activity and deduplicates Ideas',()=>{
  const options=fixture();options.trip.ideas=['a'];const fix=today.buildTodayFixes(options).find(fix=>fix.action.kind==='skip'&&fix.action.activityId==='a');actions.applyTodayFix(options.trip,0,fix);
  assert.deepEqual(options.trip.days[0].items.map(item=>item.aid),['b','c']);assert.deepEqual(options.trip.ideas,['a']);
});
await check('active journey cannot be skipped or switched midway without actual location',()=>{
  const options=fixture(),change=actions.planTodayAction(options,today.buildTodayProjection(options),'leave');options.runtime=change.runtime;
  const fixes=today.buildTodayFixes({...options,verifiedRoutes:{[today.todayRouteKey('hotel','a','drive')]:{mode:'drive',min:3,km:'1',status:'ready'}}});
  assert.ok(!fixes.some(fix=>fix.action.kind==='skip'&&fix.action.activityId==='a'));assert.ok(!fixes.some(fix=>fix.action.kind==='drive'));
});
await check('overnight flight preserves absolute booking instants and active day',()=>{
  const options=fixture(),day=options.trip.days[0];day.items=[];day.startPlaceId='airport';day.endPlaceId='arrival';day.endMode='flight';day.endFlightId='f';day.startTime=1260;
  options.trip.flights=[{id:'f',flightNumber:'QA123',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'23:00',timezone:'UTC'},arrival:{date:'2026-10-28',time:'00:30',timezone:'UTC'},arrivalBufferMinutes:60}];
  options.schedule=model.schedule(day,options.places,{}, {trip:options.trip,dayIndex:0});options.now=at('21:00');
  const start=today.buildTodayProjection(options);assert.equal(start.next.arrival,at('00:30','2026-10-28'));
  options.runtime=actions.planTodayAction(options,start,'leave').runtime;options.now=at('00:10','2026-10-28');const overnight=today.buildTodayProjection(options);
  assert.equal(overnight.isToday,false);assert.equal(overnight.canAct,true);assert.equal(overnight.phase,'travel');assert.equal(overnight.finish,at('01:30','2026-10-28'));
});
await check('a missed flight never invents a replacement flight or downstream finish',()=>{
  const options=fixture(),day=options.trip.days[0];day.items=[];day.startPlaceId='airport';day.endPlaceId='arrival';day.endMode='flight';day.endFlightId='f';day.startTime=540;
  options.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'11:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'12:00',timezone:'UTC'}}];
  options.schedule=model.schedule(day,options.places,{}, {trip:options.trip,dayIndex:0});options.now=at('12:00');const projection=today.buildTodayProjection(options);
  assert.equal(projection.finish,null);assert.equal(projection.next.arrival,at('12:00'));assert.ok(projection.unknown);
});
await check('route requests are bounded and keep exact endpoints for skip previews',()=>{
  const options=fixture(),requests=routes.todayRouteRequests(options,today.buildTodayProjection(options),true);assert.ok(requests.length<=5);
  assert.ok(requests.some(request=>request.key===today.todayRouteKey('hotel','a','walk')));assert.ok(requests.some(request=>request.key===today.todayRouteKey('hotel','b','walk')));
});
await check('live transit route request uses actual departure minute and not planned start',async()=>{
  const options={...fixture(),now:at('11:23')};options.trip.days[0].items[0].mode='transit';options.schedule.rows[0].leg.mode='transit';
  const requests=routes.todayRouteRequests(options,today.buildTodayProjection(options));let seen;
  await routes.calculateTodayRoutes(requests,()=>true,async(from,to,mode,departure)=>{if(mode==='transit')seen=departure;return {mode,min:12,km:'1',status:'ready'};});assert.equal(seen.getTime(),at('11:23'));
});
await check('stale async route results are discarded and provider failure stays unknown',async()=>{
  const options=fixture(),requests=routes.todayRouteRequests(options,today.buildTodayProjection(options));let active=true;
  const result=await routes.calculateTodayRoutes(requests,()=>active,async(from,to,mode)=>{active=false;return {mode,min:10,km:'1',status:'ready'};});assert.deepEqual(result,{});
  const failed=await routes.calculateTodayRoutes(requests,()=>true,async()=>{throw new Error('offline');});assert.ok(Object.values(failed).every(route=>route.min===null&&route.status==='unavailable'));
});
await check('opening conflicts reach the live status and never claim a safe fix',()=>{
  const options={...fixture(),now:at('16:30')};options.hoursByPlace={a:{fetchedAt:at('08:00'),lastEntryMinutes:{2:990},regularHours:{periods:[{open:{day:2,hour:9,minute:0},close:{day:2,hour:17,minute:0}}],weekdayDescriptions:[]}}};
  const projection=today.buildTodayProjection(options);assert.equal(projection.problem.targetId,'activity:a');assert.equal(projection.problem.severity,'red');
  assert.ok(today.buildTodayFixes(options).filter(fix=>fix.action.kind==='shorten').every(fix=>!fix.resolves));
});
await check('live route departure respects a later planned start today',()=>{
  const options={...fixture(),now:at('07:00')};options.trip.days[0].items[0].mode='transit';options.schedule.rows[0].leg.mode='transit';
  const request=routes.todayRouteRequests(options,today.buildTodayProjection(options)).find(request=>request.mode==='transit');assert.equal(request.departureMs,at('09:00'));
});
await check('actual landing keeps an arrival buffer before the onward journey',()=>{
  const options=fixture(),day=options.trip.days[0];day.startPlaceId='airport';day.startTime=540;day.items=[{aid:'landing',placeId:'arrival',duration:0,fixed:null,mode:'flight',flightId:'f',note:''}];
  options.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'11:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'12:00',timezone:'UTC'},arrivalBufferMinutes:45}];
  options.schedule=model.schedule(day,options.places,{return:{mode:'walk',min:10,km:'1',status:'ready'}},{trip:options.trip,dayIndex:0});options.now=at('12:15');
  const arrived=actions.planTodayAction(options,today.buildTodayProjection(options),'arrive');assert.equal(arrived.runtime.leaveAt,at('13:00'));
  const projection=today.buildTodayProjection({...options,runtime:arrived.runtime,marks:{'flight:f':'done'}});assert.equal(minute(projection.next.arrival),'13:10');assert.equal(projection.leaveInMinutes,45);
});
await check('a previous overnight flight and hotel transfer do not replace the next day hotel start',()=>{
  const options=fixture(),day=options.trip.days[0];day.startPlaceId='airport';day.startTime=1260;day.items=[{aid:'landing',placeId:'arrival',duration:0,fixed:null,mode:'flight',flightId:'f',note:''}];
  options.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'23:00',timezone:'UTC'},arrival:{date:'2026-10-28',time:'00:30',timezone:'UTC'}}];
  options.dayIndex=1;options.trip.days[1]={...options.trip.days[1],startPlaceId:'hotel',endPlaceId:'hotel',startTime:540,endMode:'walk',items:[{aid:'c',placeId:'c',duration:30,fixed:null,mode:'walk',note:''}]};
  options.schedule=model.schedule(options.trip.days[1],options.places,{c:{mode:'walk',min:10,km:'1',status:'ready'},return:{mode:'walk',min:10,km:'1',status:'ready'}},{trip:options.trip,dayIndex:1});options.now=at('09:00','2026-10-28');
  const projection=today.buildTodayProjection(options);assert.equal(projection.next.target.id,'activity:c');assert.equal(projection.originPlaceId,'hotel');assert.deepEqual(options.marks,{},'omitting an earlier-day journey does not mark it done');
});
await check('stale progress snapshots cannot act after another device completed a stop',()=>{
  const options=fixture(),projection=today.buildTodayProjection(options);options.marks={'activity:a':'done'};
  assert.throws(()=>actions.planTodayAction(options,projection,'arrive'),/progress changed/);
});
await check('known static matching routes are reused immediately, never different endpoints or transit',()=>{
  const options=fixture(),requests=routes.todayRouteRequests(options,today.buildTodayProjection(options));
  assert.equal(routes.readyTodayStaticRoute(requests[0],options).min,10);
  assert.equal(routes.readyTodayStaticRoute({...requests[0],from:options.places.c},options),undefined);
  assert.equal(routes.readyTodayStaticRoute({...requests[0],mode:'transit'},options),undefined);
});
await check('remaining transit routes recalculate sequentially at projected live departures',async()=>{
  const options={...fixture(),now:at('11:00')};for(const item of options.trip.days[0].items)item.mode='transit';options.trip.days[0].endMode='transit';
  for(const row of options.schedule.rows)row.leg.mode='transit';options.schedule.endLeg.mode='transit';
  const departures=[],published=[],cache=new Map();
  const compute=async(from,to,mode,departure)=>{departures.push([from.id,to.id,departure.getTime()]);return {mode,min:20,km:'1',status:'ready'};};
  const verified=await routes.calculateTodayRemainingRoutes(options,()=>true,compute,result=>published.push(result),cache);
  assert.deepEqual(departures.map(value=>minute(value[2])),['11:00','12:20','13:40','14:30']);assert.equal(minute(today.buildTodayProjection({...options,verifiedRoutes:verified}).finish),'14:50');assert.ok(published.length>=4);
  departures.length=0;await routes.calculateTodayRemainingRoutes(options,()=>true,compute,()=>{},cache);assert.equal(departures.length,0,'unchanged departure buckets reuse exact route results');
});
await check('unknown upstream travel prevents fabricated downstream transit requests',async()=>{
  const options={...fixture(),now:at('11:00')};for(const item of options.trip.days[0].items)item.mode='transit';options.trip.days[0].endMode='transit';
  for(const row of options.schedule.rows)row.leg.mode='transit';options.schedule.endLeg.mode='transit';let calls=0;
  const verified=await routes.calculateTodayRemainingRoutes(options,()=>true,async(from,to,mode)=>{calls++;return {mode,min:null,km:'—',status:'unavailable'};});
  assert.equal(calls,1);assert.equal(today.buildTodayProjection({...options,verifiedRoutes:verified}).finish,null);
});
await check('airport check-in buffer is not incorrectly counted as arriving late at the airport',()=>{
  const options=fixture(),day=options.trip.days[0];day.startTime=540;day.endPlaceId='arrival';day.endMode='flight';day.endFlightId='f';day.items=[{aid:'check-in',placeId:'airport',duration:120,fixed:600,mode:'walk',note:'',departureForFlightId:'f'}];
  options.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'12:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'13:00',timezone:'UTC'}}];
  options.schedule=model.schedule(day,options.places,{'check-in':{mode:'walk',min:10,km:'1',status:'ready'}},{trip:options.trip,dayIndex:0});
  const projection=today.buildTodayProjection(options);assert.equal(projection.rows.find(row=>row.target.kind==='flight').lateMinutes,0);assert.equal(projection.unknown,0);
});
await check('fix preview clock labels distinguish the next local calendar day',()=>{assert.equal(today.todayTime(at('01:30','2026-10-28'),'UTC','2026-10-27'),'01:30 +1d');});
await check('a slower driving alternative is not presented as a timing fix',()=>{
  const options=fixture();const fixes=today.buildTodayFixes({...options,verifiedRoutes:{[today.todayRouteKey('hotel','a','drive')]:{mode:'drive',min:12,km:'1',status:'ready'}}});assert.ok(!fixes.some(fix=>fix.action.kind==='drive'));
});
await check('explicit arrival clears unknown earlier travel from the remaining day',()=>{
  const options=fixture();options.schedule.rows[0].leg={mode:'walk',min:null,km:'—',status:'unavailable'};const arrived=actions.planTodayAction(options,today.buildTodayProjection(options),'arrive');
  const projection=today.buildTodayProjection({...options,runtime:arrived.runtime});assert.equal(projection.next.leg.min,10);assert.equal(projection.unknown,0);assert.notEqual(projection.finish,null);
});
await check('resetting or skipping a landed flight clears its persisted origin and arrival buffer',()=>{
  const options=fixture(),day=options.trip.days[0];day.startPlaceId='airport';day.items=[{aid:'landing',placeId:'arrival',duration:0,fixed:null,mode:'flight',flightId:'f',note:''}];
  options.trip.flights=[{id:'f',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-27',time:'11:00',timezone:'UTC'},arrival:{date:'2026-10-27',time:'12:00',timezone:'UTC'},arrivalBufferMinutes:45}];
  options.schedule=model.schedule(day,options.places,{return:{mode:'walk',min:10,km:'1',status:'ready'}},{trip:options.trip,dayIndex:0});options.now=at('12:15');
  const landed=actions.planTodayAction(options,today.buildTodayProjection(options),'arrive').runtime;
  assert.equal(today.runtimeMatches(landed,{...options,marks:{'flight:f':'done'}}),true);
  for(const mark of ['planned','skipped']){const projection=today.buildTodayProjection({...options,runtime:landed,marks:{'flight:f':mark}});assert.equal(projection.stale,true);assert.equal(projection.originPlaceId,'airport');assert.equal(projection.leaveAt,null);}
});
await check('an unconfirmed same-airport origin cannot retain a previous flight buffer',()=>{
  const options=fixture(),runtime={...today.initialTodayRuntime(options),leaveAt:at('10:00')};
  const projection=today.buildTodayProjection({...options,runtime});assert.equal(projection.stale,true);assert.equal(projection.leaveAt,null);
});
console.log(`${count} Today engine checks passed.`);
