import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const urls={};
const add=name=>{const source=ts.transpileModule(readFileSync(new URL(`./${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  urls[`./${name}`]=`data:text/javascript;base64,${Buffer.from(source.replace(/from (['"])([^'"]+)\1/g,(match,_,path)=>urls[path]?`from ${JSON.stringify(urls[path])}`:match)).toString('base64')}`;};
add('model');add('openingHours');add('visitHours');add('hoursPlanning');
const {scheduleWithOpeningHours,findOpeningHoursFix,applyOpeningHoursFix,visitDateForHours}=await import(urls['./hoursPlanning']);
const {getWeekdayHoursLabel}=await import(urls['./openingHours']);
const {checkVisitHours,openingWaitMinutes}=await import(urls['./visitHours']);
let passed=0;const check=async(name,run)=>{await run();passed++;console.log(`✓ ${name}`);};
const activity=(aid,extra={})=>({aid,placeId:aid,duration:60,fixed:null,mode:'walk',note:'',...extra});
const place=id=>({id,name:id,cat:'attr',x:0,y:0,area:'',typical:'',blurb:'',lat:51,lng:0});
const places=Object.fromEntries(['hotel','museum','tea','park','airport','arrival'].map(id=>[id,place(id)]));
const period=(day,start,end)=>({open:{day,hour:Math.floor(start/60),minute:start%60},close:{day,hour:Math.floor(end/60),minute:end%60}});
const hours=(periods,extra={})=>({regularHours:{periods,weekdayDescriptions:[]},fetchedAt:Date.parse('2026-10-26T00:00:00Z'),utcOffsetMinutes:0,...extra});
const allDay=hours([{open:{day:0,hour:0,minute:0}}]);
const ready=(min=0,mode='walk')=>({min,km:'1',mode,status:min===null?'unavailable':'ready'});
const day=(items,extra={})=>({id:'day1',label:'Day 1',date:'Mon 26',title:'',startTime:540,endMode:'walk',items,...extra});
const trip=(days)=>({id:'trip',name:'Test',destination:'Test',startDate:'2026-10-26',timezone:'UTC',days,ideas:[],customPlaces:places});
const legs=(day,min=0)=>Object.fromEntries([...day.items.map(item=>[item.aid,ready(min,item.mode)]),['return',ready(min,day.endMode)]]);
const resolve=async(trip,index)=>legs(trip.days[index]);
const info={museum:hours([period(1,600,1020),period(2,600,1020)]),tea:allDay,park:allDay};

await check('visit hours date keeps a normal same-day visit on its own weekday',()=>{
 const plan=day([activity('museum')]);
 const row=scheduleWithOpeningHours(plan,places,legs(plan),{date:'2026-10-26',hours:{}}).rows[0];
 assert.equal(visitDateForHours(row,'2026-10-26'),'2026-10-26');
 assert.equal(visitDateForHours({...row,arrive:1445,start:1380},'2026-10-26'),'2026-10-27','late fixed booking uses physical arrival');
});
await check('overnight visit labels and cutoff edits use the next calendar weekday',()=>{
 const plan=day([activity('museum')],{startTime:1430});
 const row=scheduleWithOpeningHours(plan,places,legs(plan,30),{date:'2026-10-26',hours:{}}).rows[0];
 const date=visitDateForHours(row,'2026-10-26');assert.equal(row.start,1460);assert.equal(date,'2026-10-27');
 const cutoffHours={...allDay,lastEntryMinutes:{1:1380,2:60}};
 assert.equal(new Date(date+'T12:00:00Z').getUTCDay(),2);
 assert.equal(getWeekdayHoursLabel(cutoffHours,date),'Open 24 h · last entry 01:00');
});
await check('post-flight hours use destination-local visit date without double-counting travel days',()=>{
 const source=trip([day([activity('arrival',{aid:'landing',mode:'flight',flightId:'long-flight',duration:0}),activity('museum')],{startTime:1200,startPlaceId:'airport'})]);
 source.timezone='Pacific/Honolulu';
 source.flights=[{id:'long-flight',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-26',time:'22:00',timezone:'Pacific/Honolulu'},arrival:{date:'2026-10-28',time:'06:00',timezone:'Asia/Tokyo'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 const result=scheduleWithOpeningHours(source.days[0],places,legs(source.days[0],30),{date:source.startDate,hours:{},context:{trip:source,dayIndex:0}}),row=result.rows[1];
 assert.ok(row.start>=1440);assert.equal(row.visitWindow.date,'2026-10-28');assert.equal(visitDateForHours(row,source.startDate),'2026-10-28');
 assert.equal(visitDateForHours({...row,visitWindow:{...row.visitWindow,start:1450}},source.startDate),'2026-10-29');
});
await check('weekday labels distinguish unknown, 24-hour, closed and confirmed last-entry data',()=>{
 assert.equal(getWeekdayHoursLabel(undefined,'2026-10-26'),'Hours unknown');
 assert.equal(getWeekdayHoursLabel(allDay,'2026-10-26'),'Open 24 h');
 assert.equal(getWeekdayHoursLabel(info.museum,'2026-10-28'),'Closed');
 assert.equal(getWeekdayHoursLabel({...info.museum,lastEntryMinutes:{1:990}},'2026-10-26'),'10:00–17:00 · last entry 16:30');
 assert.equal(getWeekdayHoursLabel(info.museum,'2026-10-26'),'10:00–17:00');
 assert.equal(getWeekdayHoursLabel({fetchedAt:0,lastEntryMinutes:{1:990}},'2026-10-26'),'Hours unknown · last entry 16:30');
});
await check('before opening adds waiting and shifts subsequent arrivals without creating a booking',()=>{
 const plan=day([activity('museum'),activity('park')]),original=JSON.stringify(plan);
 const result=scheduleWithOpeningHours(plan,places,legs(plan),{date:'2026-10-26',hours:info});
 assert.equal(result.rows[0].arrive,540);assert.equal(result.rows[0].start,600);
 assert.equal(result.rows[0].openingWaitMinutes,60);assert.equal(result.rows[0].wait,60);
 assert.equal(result.rows[0].it.fixed,null);assert.equal(result.rows[0].it,plan.items[0]);
 assert.equal(result.rows[1].start,660);assert.equal(result.finish,720);assert.equal(result.wait,60);
 assert.equal(JSON.stringify(plan),original);
});
await check('fixed bookings and unknown routes never gain invented opening waits',()=>{
 const fixed=day([activity('museum',{fixed:540})]);
 assert.equal(scheduleWithOpeningHours(fixed,places,legs(fixed),{date:'2026-10-26',hours:info}).rows[0].start,540);
 const flex=day([activity('museum')]);
 const unknown=scheduleWithOpeningHours(flex,places,{}, {date:'2026-10-26',hours:info});
 assert.equal(unknown.rows[0].start,540);assert.equal(unknown.rows[0].openingWaitMinutes,undefined);
 assert.equal(openingWaitMinutes(info.museum,{date:'2026-10-26',start:540,end:600,approx:true}),0);
 assert.equal(checkVisitHours(info.museum,{date:'2026-10-26',start:540,end:600,allowWait:false}).status,'closed');
});
await check('last-entry is a red conflict; a shortened visit stays amber; waiting is informational',()=>{
 const constrained={...info.museum,lastEntryMinutes:{1:990}};
 const visit=(start,end)=>({date:'2026-10-26',start,end});
 assert.equal(checkVisitHours(constrained,visit(991,1021)).reason,'last-entry');
 assert.equal(checkVisitHours(constrained,visit(991,1021)).status,'closed');
 assert.equal(checkVisitHours(constrained,visit(990,1050)).status,'short');
 const waiting=checkVisitHours(constrained,visit(540,600));
 assert.equal(waiting.status,'fits');assert.equal(waiting.waitMinutes,60);assert.equal(waiting.reason,'before-open');
 assert.equal(checkVisitHours(constrained,visit(540,1080)).status,'short');
 assert.equal(checkVisitHours({fetchedAt:0,lastEntryMinutes:{1:990}},visit(991,1051)).reason,'last-entry');
 assert.equal(checkVisitHours({fetchedAt:0,lastEntryMinutes:{1:990}},visit(980,1040)).status,'unknown');
});
await check('split hours wait for the next same-day opening but never wait through a closed day',()=>{
 const split=hours([period(1,540,720),period(1,840,1020)]);
 assert.equal(openingWaitMinutes(split,{date:'2026-10-26',start:780,end:840}),60);
 assert.equal(openingWaitMinutes(split,{date:'2026-10-26',start:1080,end:1140}),0);
 assert.equal(openingWaitMinutes(split,{date:'2026-10-27',start:540,end:600}),0);
});
await check('nearest reorder can precede a fixed tea booking while preserving its time',async()=>{
 const source=trip([day([activity('park'),activity('tea',{fixed:900,duration:90}),activity('museum')],{startTime:780})]);
 const h={...info,museum:{...info.museum,lastEntryMinutes:{1:980}}};
 const input={trip:source,dayIndex:0,activityId:'museum',places,hours:h};
 const result=await findOpeningHoursFix(input,resolve);
 assert.equal(result?.kind,'reorder');assert.equal(result?.label,'Visit before tea');assert.equal(result?.insertIndex,1);
 assert.equal(result.evaluationsByDayId.day1.schedule.rows.find(row=>row.it.aid==='tea').start,900);
 assert.deepEqual(source.days[0].items.map(item=>item.aid),['park','tea','museum']);
 source.days[0].items[2].note='Keep this new note';
 applyOpeningHoursFix(source,result);
 assert.deepEqual(source.days[0].items.map(item=>item.aid),['park','museum','tea']);
 assert.equal(source.days[0].items[1].note,'Keep this new note');assert.equal(source.days[0].items[2].fixed,900);
});
await check('a closed weekday offers another day only after verifying both affected routes',async()=>{
 const source=trip([day([activity('museum')]),day([activity('park')],{id:'day2',label:'Day 2'})]);
 const h={...info,museum:hours([period(2,540,1020)])};
 const calls=[];const result=await findOpeningHoursFix({trip:source,dayIndex:0,activityId:'museum',places,hours:h},async(t,i)=>{calls.push([i,t.days[i].items.map(a=>a.aid)]);return resolve(t,i);});
 assert.equal(result?.kind,'move-day');assert.equal(result?.label,'Move to Day 2');
 assert.ok(calls.some(([i,items])=>i===0&&items.length===0));assert.ok(calls.some(([i,items])=>i===1&&items.includes('museum')));
 applyOpeningHoursFix(source,result);assert.equal(source.days[0].items.length,0);assert.equal(source.days[1].items[0].aid,'museum');
});
await check('a fix never fabricates journeys, worsens another opening issue or delays a booking',async()=>{
 const source=trip([day([activity('tea',{fixed:900,duration:90}),activity('museum')],{startTime:890})]);
 const h={...info,museum:{...info.museum,lastEntryMinutes:{1:980}}};
 assert.equal(await findOpeningHoursFix({trip:source,dayIndex:0,activityId:'museum',places,hours:h},resolve),null);
 source.days[0].startTime=780;
 assert.equal(await findOpeningHoursFix({trip:source,dayIndex:0,activityId:'museum',places,hours:h},async()=>({})),null);
 source.days[0].items[0].fixed=null;source.days[0].items[0].duration=240;
 const closes=hours([period(1,540,850)]);
 assert.equal(await findOpeningHoursFix({trip:source,dayIndex:0,activityId:'museum',places,hours:{...h,tea:closes}},resolve),null);
});
await check('an airport departure goal stays protected even after the finish goal is cleared',async()=>{
 const source=trip([day([activity('tea',{duration:120}),activity('museum',{duration:30})],{startTime:720,endPlaceId:'airport',finishBy:null})]);
 const h={...info,museum:{...info.museum,lastEntryMinutes:{1:780}}};
 const resolver=async(t,i)=>({...legs(t.days[i]),return:ready(t.days[i].items[0]?.aid==='museum'?45:0)});
 const input={trip:source,dayIndex:0,activityId:'museum',places,hours:h};
 assert.ok(await findOpeningHoursFix(input,resolver));
 source.flights=[{id:'return-flight',fromPlaceId:'airport',toPlaceId:'arrival',departure:{date:'2026-10-26',time:'17:00',timezone:'UTC'},arrival:{date:'2026-10-26',time:'18:00',timezone:'UTC'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 assert.equal(await findOpeningHoursFix(input,resolver),null);
});
await check('fixed visits, locked visits and airport anchors are not moved as hours fixes',async()=>{
 for(const extra of [{fixed:1000},{departureForFlightId:'flight'},{mode:'flight',flightId:'flight'}]) {
  const source=trip([day([activity('museum',extra)])]);let called=false;
  assert.equal(await findOpeningHoursFix({trip:source,dayIndex:0,activityId:'museum',places,hours:info},async()=>{called=true;return{};}),null);assert.equal(called,false);
 }
 const source=trip([day([activity('museum')])]);
 assert.equal(await findOpeningHoursFix({trip:source,dayIndex:0,activityId:'museum',places,hours:info,locks:['museum']},resolve),null);
});
await check('changed plans, old checks and cancelled searches cannot apply stale fixes',async()=>{
 const source=trip([day([activity('tea',{fixed:900,duration:90}),activity('museum')],{startTime:780})]);
 const h={...info,museum:{...info.museum,lastEntryMinutes:{1:980}}};
 const input={trip:source,dayIndex:0,activityId:'museum',places,hours:h};
 const result=await findOpeningHoursFix(input,resolve);assert.ok(result);
 assert.throws(()=>applyOpeningHoursFix(source,result,result.verifiedAt+300001),/changed/);
 source.days[0].startTime++;assert.throws(()=>applyOpeningHoursFix(source,result),/changed/);
 await assert.rejects(()=>findOpeningHoursFix(input,resolve,()=>false),error=>error.name==='AbortError');
});
console.log(`\n${passed} opening-hours planning checks passed.`);
