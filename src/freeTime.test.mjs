import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const urls = {};
const load = name => {
  const source = ts.transpileModule(readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  const compiled = source.replaceAll('import.meta.env','({})').replace(/from (['"])([^'"]+)\1/g, (match,_,path) => {
    const key = name.includes('/') && path.startsWith('../') ? path.slice(3) : path.startsWith('./') ? path.slice(2) : path;
    return urls[key] ? `from ${JSON.stringify(urls[key])}` : path === 'react' ? `from ${JSON.stringify(import.meta.resolve('react'))}` : match;
  });
  return urls[name] = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
};
for (const name of ['model','openingHours','visitHours','hoursPlanning','tripBackup','collaboration/merge','googleMaps','useLiveRoutes']) load(name);
const {schedule,isTrip,createTrip,persistableTrip,scheduleVisitWindow,PLACES} = await import(urls.model);
const {scheduleWithOpeningHours} = await import(urls.hoursPlanning);
const {canonicalTrip} = await import(urls.tripBackup);
const {mergeTrips} = await import(urls['collaboration/merge']);
const {calculateDayRoutes,routeInputSignature} = await import(urls.useLiveRoutes);
let count=0; const check=async(name,run)=>{await run();count++;console.log(`✓ ${name}`);};
const free=(extra={})=>({id:'free1',kind:'explore',duration:60,untilBooking:false,...extra});
const item=(aid,extra={})=>({aid,placeId:aid,duration:60,fixed:null,mode:'walk',note:'',...extra});
const place=id=>({id,name:id,cat:'attr',x:0,y:0,area:'',typical:'',blurb:'',lat:51,lng:0});
const places=Object.fromEntries(['hotel','museum','tea','park','airport','arrival'].map(id=>[id,place(id)]));
const day=(items,extra={})=>({id:'day1',label:'Day 1',date:'Mon 26',title:'',startTime:540,endMode:'walk',items,...extra});
const trip=plan=>({...createTrip('Test','London','2026-10-26',1),days:[plan],customPlaces:Object.fromEntries(Object.entries(places).filter(([id])=>id==='hotel'||!PLACES[id]))});
const ready=(min=0,mode='walk')=>({min,km:'1',mode,status:min===null?'unavailable':'ready'});
const legs=plan=>Object.fromEntries([...plan.items.map(it=>[it.aid,ready(10,it.mode)]),['return',ready(10,plan.endMode)]]);
const period=(start,end)=>({open:{day:1,hour:Math.floor(start/60),minute:start%60},close:{day:1,hour:Math.floor(end/60),minute:end%60}});
const hours=(start,end)=>({regularHours:{periods:[period(start,end)],weekdayDescriptions:[]},fetchedAt:Date.parse('2026-10-26T00:00:00Z'),utcOffsetMinutes:0});
await check('fixed free block reserves time without route, pin, stop, or longer opening-hours visit',()=>{
 const plan=day([item('museum',{freeTime:free()}),item('tea')]), result=schedule(plan,places,legs(plan));
 assert.equal(result.rows.length,2);assert.equal(result.travel,30);assert.equal(result.rows[0].physicalEnd,610);
 assert.deepEqual([result.rows[0].freeTime.start,result.rows[0].freeTime.end,result.rows[1].arrive],[610,670,680]);
 assert.equal(scheduleVisitWindow(result.rows[0],'2026-10-26').end,610);
});
await check('until booking consumes only spare time after reserving next journey',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('tea',{fixed:720})]);
 const result=schedule(plan,places,legs(plan));assert.equal(result.rows[0].freeTime.duration,100);
 assert.equal(result.rows[0].freeTime.bookingId,'tea');assert.equal(result.rows[1].arrive,720);assert.equal(result.late,0);
});
await check('until booking grows or shrinks and warns below ten minutes',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('tea',{fixed:625})]);
 assert.equal(schedule(plan,places,legs(plan)).rows[0].freeTime.duration,5);
 assert.match(schedule(plan,places,legs(plan)).rows[0].freeTime.warning,/10 minutes/);
 plan.startTime=560;const result=schedule(plan,places,legs(plan));assert.equal(result.rows[0].freeTime.duration,0);assert.equal(result.late,15);
});
await check('past lateness at the anchor does not erase spare time before a later booking',()=>{
 const plan=day([item('museum',{fixed:540,freeTime:free({untilBooking:true})}),item('tea',{fixed:720})]);
 const routes={museum:ready(15),tea:ready(15),return:ready(15)};const result=schedule(plan,places,routes);
 assert.equal(result.rows[0].late,15);assert.equal(result.rows[0].freeTime.duration,90);assert.equal(result.rows[1].late,0);
});
await check('future flexible visits and their journeys are reserved before a booking',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('park'),item('tea',{fixed:800})]);
 const result=schedule(plan,places,legs(plan));assert.equal(result.rows[0].freeTime.duration,110);assert.equal(result.rows[2].arrive,800);
});
await check('multiple until blocks do not double-count the same booking slack',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('park',{freeTime:free({id:'free2',untilBooking:true})}),item('tea',{fixed:800})]);
 const result=schedule(plan,places,legs(plan));assert.equal(result.rows[0].freeTime.duration,110);assert.equal(result.rows[1].freeTime.duration,0);assert.equal(result.late,0);
});
await check('unknown upstream and future routes never promise spare time',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('tea',{fixed:720})]);
 for(const key of ['museum','tea']){const routes=legs(plan);routes[key]=ready(null);const result=schedule(plan,places,routes);
 assert.equal(result.rows[0].freeTime.approx,true);assert.equal(result.rows[0].freeTime.duration,60);assert.match(result.rows[0].freeTime.warning,/Confirm travel/);}
});
await check('missing booking falls back to chosen duration with explicit explanation',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('tea')]);const result=schedule(plan,places,legs(plan));
 assert.equal(result.rows[0].freeTime.duration,60);assert.match(result.rows[0].freeTime.warning,/No upcoming booking/);
});
await check('opening waits are not bookings and free time respects intermediate closing',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('park'),item('tea',{fixed:900})]);
 const result=scheduleWithOpeningHours(plan,places,legs(plan),{date:'2026-10-26',hours:{park:hours(700,790)}});
 assert.equal(result.rows[0].freeTime.bookingId,'tea');assert.equal(result.rows[0].freeTime.duration,110);
 assert.equal(result.rows[1].physicalEnd,790);assert.equal(result.rows[2].late,0);
});
await check('last-entry cutoff also limits free time before intermediate visits',()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('park'),item('tea',{fixed:900})]);
 const result=scheduleWithOpeningHours(plan,places,legs(plan),{date:'2026-10-26',hours:{park:{...hours(600,1000),lastEntryMinutes:{1:705}}}});
 assert.ok(result.rows[1].arrive<=705);assert.equal(result.rows[0].freeTime.duration,85);
});
await check('DST free time advances elapsed time without distorting visit window',()=>{
 const plan=day([item('museum',{duration:30,freeTime:free()})],{startTime:30});const source=trip(plan);source.startDate='2026-03-29';source.timezone='Europe/London';
 const result=schedule(plan,places,{museum:ready(0),return:ready(0)},{trip:source,dayIndex:0});
 assert.equal(result.rows[0].freeTime.duration,60);assert.equal(result.rows[0].physicalEnd,120);
 assert.equal(result.rows[0].freeTime.start,120);assert.equal(result.rows[0].freeTime.end,180);assert.equal(result.rows[0].approx,false);
});
await check('serialization preserves authored free fields and strict validation rejects malformed data',()=>{
 const source=trip(day([item('museum',{freeTime:free()})]));assert.equal(isTrip(source),true);
 assert.deepEqual(canonicalTrip(source).days[0].items[0].freeTime,free());assert.deepEqual(persistableTrip(source).days[0].items[0].freeTime,free());
 for(const bad of [null,{},free({id:3}),free({kind:'dinner'}),free({duration:0}),free({duration:16}),free({duration:735}),free({untilBooking:1}),{...free(),secret:'no'}]){
 const next=structuredClone(source);next.days[0].items[0].freeTime=bad;assert.equal(isTrip(next),false,JSON.stringify(bad));}
 const duplicate=structuredClone(source);duplicate.days[0].items.push(item('park',{freeTime:free()}));assert.equal(isTrip(duplicate),false);
});
await check('collaboration merges separate free settings and explicitly disputes concurrent duration edits',()=>{
 const base=trip(day([item('museum',{freeTime:free()})]));const left=structuredClone(base),right=structuredClone(base);
 left.days[0].items[0].freeTime.duration=90;right.days[0].items[0].freeTime.kind='rest';
 const independent=mergeTrips(base,left,right);assert.equal(independent.conflicts.length,0);assert.equal(independent.trip.days[0].items[0].freeTime.duration,90);assert.equal(independent.trip.days[0].items[0].freeTime.kind,'rest');
 right.days[0].items[0].freeTime.duration=30;assert.ok(mergeTrips(base,left,right).conflicts.some(c=>c.path.endsWith('/freeTime/duration')));
});
await check('route signature includes free time and fixed blocks delay transit departures',async()=>{
 const plan=day([item('museum',{freeTime:free()}),item('tea',{mode:'transit'})]);const source=trip(plan);const before=routeInputSignature(source,0,places);plan.items[0].freeTime.duration=90;assert.notEqual(routeInputSignature(source,0,places),before);
 const departures=[];await calculateDayRoutes({day:plan,places,date:'2026-10-26',timezone:'UTC'},()=>{},()=>true,async(a,b,mode,departure)=>{if(departure)departures.push(departure.toISOString());return ready(10,mode);},Date.parse('2026-10-26'));
 assert.deepEqual(departures,['2026-10-26T11:40:00.000Z']);
});
await check('until booking recomputes transit at resolved departure and stabilizes without extra static calls',async()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('tea',{mode:'transit',fixed:720})]);const departures=[],statics=[];
 const result=await calculateDayRoutes({day:plan,places,date:'2026-10-26',timezone:'UTC'},()=>{},()=>true,async(a,b,mode,departure)=>{if(departure)departures.push(departure.toISOString());else statics.push(b.id);return ready(10,mode);},Date.parse('2026-10-26'));
 assert.deepEqual(departures,['2026-10-26T10:10:00.000Z','2026-10-26T11:50:00.000Z']);assert.deepEqual(statics,['museum','hotel']);assert.equal(result.tea.min,10);
});
await check('nonconverging transit departures fail conservatively rather than claim booking is reachable',async()=>{
 const plan=day([item('museum',{freeTime:free({untilBooking:true})}),item('tea',{mode:'transit',fixed:720})]);
 const result=await calculateDayRoutes({day:plan,places,date:'2026-10-26',timezone:'UTC'},()=>{},()=>true,async(a,b,mode,departure)=>ready(departure&&departure.getUTCMinutes()===50?20:10,mode),Date.parse('2026-10-26'));
 assert.equal(result.tea.min,null);assert.match(result.tea.reason,/fixed free-time/);
});
console.log(`\n${count} free-time core checks passed.`);
