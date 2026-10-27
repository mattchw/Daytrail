import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
const compiled=new Map();
function moduleURL(path){
  if(compiled.has(path))return compiled.get(path);
  let source=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  source=source.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm,'').replaceAll('import.meta.env','({})');
  source=source.replace(/^((?:import|export)\s[^\n]*?\sfrom\s)(['"])([^'"]+)\2/gm,(_,prefix,quote,specifier)=>{
    if(!specifier.startsWith('.'))return `${prefix}${JSON.stringify(import.meta.resolve(specifier))}`;
    const base=resolve(dirname(path),specifier),dependency=[base,`${base}.ts`,`${base}.tsx`].find(value=>existsSync(value));
    return `${prefix}${JSON.stringify(moduleURL(dependency))}`;
  });
  const result=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;compiled.set(path,result);return result;
}
const {default:TodayNowCard,todayClock}=await import(moduleURL(resolve(dirname(fileURLToPath(import.meta.url)),'TodayNowCard.tsx')));
const {default:TodayBookingSheet}=await import(moduleURL(resolve(dirname(fileURLToPath(import.meta.url)),'TodayBookingSheet.tsx')));
const time=value=>Date.parse(`2026-10-27T${value}:00Z`);
const place=(id,name)=>({id,name,cat:'custom',x:0,y:0,area:'',typical:'',blurb:'',googlePlaceId:`test_${id}`});
const start=place('hotel','My hotel'),museum=place('museum','City museum'),tea=place('tea','Tea ceremony');
const current={target:{id:'activity:a',kind:'activity',placeId:'museum',mode:'walk',activity:{aid:'a',duration:60,fixed:null}},place:museum,name:'City museum',mode:'walk',leg:{min:10,mode:'walk',km:'1'},start:time('11:00'),arrival:time('11:00'),end:time('12:00'),plannedStart:time('11:00'),approx:false};
const next={target:{id:'activity:b',kind:'activity',placeId:'tea',mode:'transit',activity:{aid:'b',duration:60,fixed:780}},place:tea,name:'Tea ceremony',mode:'transit',leg:{min:20,mode:'transit',km:'4'},start:time('13:00'),arrival:time('12:20'),end:time('14:00'),plannedStart:time('13:00'),approx:false};
const projection={date:'2026-10-27',timezone:'UTC',now:time('11:33'),nowMinute:693,isToday:true,canAct:true,phase:'visit',current,next,rows:[current,next],leaveAt:time('12:00'),leaveInMinutes:27,finish:time('14:20'),booking:null,unknown:0,stale:false};
const noop=()=>{};
const render=(overrides={})=>renderToStaticMarkup(React.createElement(TodayNowCard,{projection,startPlace:start,onLeave:noop,onArrive:noop,onStay:noop,...overrides}));
let checks=0;const check=(name,run)=>{run();checks++;console.log(`✓ ${name}`);};
check('the live card pairs a confirmed location and countdown with next-stop arrival',()=>{
  const html=render();assert.match(html,/Now<\/span>/);assert.match(html,/City museum/);assert.match(html,/Leave in 27 min/);
  assert.match(html,/Tea ceremony/);assert.match(html,/Transit · 20 min/);assert.match(html,/arrive ≈ 12:20/);assert.match(html,/booked 13:00/);
  assert.match(html,/Leaving now/);assert.match(html,/Stay 15 min longer/);
});
check('early arrivals distinguish opening wait from actual visit time',()=>{
  const html=render({projection:{...projection,current:{...current,arrival:time('11:00'),start:time('12:00')},leaveAt:time('13:00'),leaveInMinutes:87}});
  assert.match(html,/Opens in 27 min/);assert.match(html,/Arrived 11:00 · waiting until 12:00 · 1 h planned visit/);
  assert.match(html,/Your visit starts at 12:00/);assert.match(html,/Leave at 13:00 after your planned visit/);assert.match(html,/aria-valuenow="0"/);
});
check('projected after-midnight times display their trip-day offset',()=>{
  const tomorrow=value=>Date.parse(`2026-10-28T${value}:00Z`);
  const html=render({projection:{...projection,next:{...next,arrival:tomorrow('00:19'),plannedStart:tomorrow('08:30')},booking:{targetId:next.target.id,time:tomorrow('08:30')}}});
  assert.match(html,/arrive ≈ 00:19 \+1d/);assert.match(html,/booked 08:30 \+1d/);
  const waiting=render({projection:{...projection,current:{...current,arrival:time('23:03'),start:tomorrow('08:30')},leaveAt:tomorrow('09:30')}});
  assert.match(waiting,/waiting until 08:30 \+1d/);assert.match(waiting,/Leave at 09:30 \+1d/);
});
check('a delayed projected visit never rewrites the displayed booking time',()=>{
  const html=render({projection:{...projection,next:{...next,plannedStart:time('14:20'),arrival:time('14:20')}}});
  assert.match(html,/booked 13:00/);assert.doesNotMatch(html,/booked 14:20/);
});
check('day offsets follow destination calendar dates across time zones and DST',()=>{
  assert.equal(todayClock(Date.parse('2026-10-27T15:19:00Z'),'Asia/Tokyo','2026-10-27'),'00:19 +1d');
  assert.equal(todayClock(Date.parse('2026-10-25T00:30:00Z'),'Europe/London','2026-10-24'),'01:30 +1d');
  assert.equal(todayClock(Date.parse('2026-10-26T23:00:00Z'),'UTC','2026-10-27'),'23:00 −1d');
  assert.equal(todayClock(null,'UTC','2026-10-27'),'Time to confirm');
});
check('an overdue visit shows elapsed overrun instead of a negative countdown',()=>{
  const html=render({projection:{...projection,now:time('12:08'),leaveInMinutes:-8}});assert.match(html,/Leave now · 8 min over/);assert.match(html,/aria-valuenow="100"/);assert.doesNotMatch(html,/Leave in -/);
});
check('an en-route card confirms arrival and opens only the destination in Maps',()=>{
  const html=render({projection:{...projection,phase:'travel',current:null,next}});assert.match(html,/On the way/);assert.match(html,/I’ve arrived/);assert.doesNotMatch(html,/Stay 15 min longer/);
  const href=html.match(/href="([^"]*google.com\/maps\/dir\/[^\"]*)"/)?.[1];assert.ok(href);
  const url=new URL(href.replaceAll('&amp;','&'));assert.equal(url.searchParams.get('destination_place_id'),'test_tea');assert.equal(url.searchParams.get('travelmode'),'transit');assert.equal(url.searchParams.has('origin'),false);
});
check('preview actions are disabled and explicitly separated from live travel',()=>{
  const html=render({projection:{...projection,isToday:false,canAct:false}});assert.match(html,/This is a preview/);
  const buttons=[...html.matchAll(/<button\b([^>]*)>/g)];assert.ok(buttons.length>0);for(const button of buttons)assert.match(button[1],/disabled/);
});
check('read-only snapshots never expose progress controls',()=>{
  const html=render({readOnly:true});assert.doesNotMatch(html,/<button|Leaving now|Stay 15 min longer/);assert.match(html,/Read-only snapshot/);
});
check('unknown routes do not turn into invented travel or arrival times',()=>{
  const unknown={...next,leg:{min:null,mode:'transit',km:'—'},arrival:null};const html=render({projection:{...projection,next:unknown}});
  assert.match(html,/travel time to confirm/);assert.match(html,/arrival to confirm/);assert.doesNotMatch(html,/arrive ≈ 12:20/);
});
check('flight destinations never become ground directions links',()=>{
  const html=render({projection:{...projection,next:{...next,mode:'flight',leg:{min:65,mode:'flight',km:'—'}}}});assert.doesNotMatch(html,/google.com\/maps\/dir\//);
});
check('a missing exact location offers an honest planning hint',()=>{
  const html=render({projection:{...projection,next:{...next,place:{...tea,googlePlaceId:undefined}}}});assert.match(html,/Add an exact location/);assert.doesNotMatch(html,/google.com\/maps\/dir\//);
});
check('the current place exposes its known opening-hours status',()=>{
  const html=render({projection:{...projection,current:{...current,hours:{label:'09:00–17:00 · last entry 16:30'}}}});assert.match(html,/09:00–17:00 · last entry 16:30/);
});
check('a finished day offers no more leave or arrival controls',()=>{
  const html=render({projection:{...projection,phase:'complete',current:null,next:null}});assert.match(html,/Your day is complete/);assert.doesNotMatch(html,/<button|Directions/);
});
check('the product has no mock clock or fabricated booking addresses',()=>{
  const html=render();assert.doesNotMatch(html,/Prototype clock|\[ADDRESS|Japanese|10 minutes later/);
});
const bookingActivity={aid:'booking-stop',placeId:'tea',duration:90,fixed:900,mode:'walk',note:'Confirmation: TEA-4821\nShow this note at reception.'};
const bookingPlace={...tea,area:'12 Tea Street, Kyoto'};
const renderBooking=(overrides={})=>renderToStaticMarkup(React.createElement(TodayBookingSheet,{activity:bookingActivity,place:bookingPlace,date:'2026-10-27',timezone:'Asia/Tokyo',onClose:noop,...overrides}));
check('Show booking presents the selected activity with its own date and saved reference',()=>{
  const html=renderBooking();assert.match(html,/Your booking/);assert.match(html,/Tea ceremony/);assert.match(html,/Tue 27 Oct · 15:00/);assert.match(html,/Asia\/Tokyo time/);assert.match(html,/Booking details &amp; reference/);assert.match(html,/Confirmation: TEA-4821/);assert.match(html,/Show this note at reception/);
  assert.doesNotMatch(html,/Flights &amp; stays|Start &amp; end points|My hotel/);
});
check('the selected booking has a legible saved address, copy control and venue directions',()=>{
  const html=renderBooking();assert.match(html,/Address for your driver/);assert.match(html,/12 Tea Street, Kyoto/);assert.match(html,/Copy address/);assert.match(html,/destination_place_id=test_tea/);assert.match(html,/travelmode=walking/);
});
check('missing booking details do not become mock references or translated addresses',()=>{
  const html=renderBooking({activity:{...bookingActivity,note:''},place:{...tea,area:'',googlePlaceId:undefined}});
  assert.match(html,/Add your confirmation details in the planner/);assert.match(html,/No address saved yet/);assert.doesNotMatch(html,/TEA-4821|CONFIRMATION NO|ADDRESS IN|Japanese|Copy address|google.com\/maps\/dir/);
});
check('the booking sheet preserves supplied local-language addresses without inventing translations',()=>{
  const html=renderBooking({place:{...bookingPlace,area:'京都市東山区 12 Tea Street'}});assert.match(html,/京都市東山区 12 Tea Street/);assert.doesNotMatch(html,/Japanese address|English address/);
});
check('booking details remain text and planner editing requires a supplied callback',()=>{
  const html=renderBooking({activity:{...bookingActivity,note:'<script>privateReference()</script>'}});assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|Open day planner/);
  assert.match(renderBooking({onEditPlan:noop}),/Open day planner/);
});
check('no selected booking means no dialog content',()=>{assert.equal(renderBooking({activity:null}),'');});

check('saved booking addresses remain usable with only a supplied local-language address',()=>{
 const html=renderBooking({place:{...bookingPlace,area:'',offlineDetails:{name:'Tea ceremony',localAddress:'京都市東山区 12'}}});assert.match(html,/京都市東山区 12/);assert.match(html,/Copy address/);assert.doesNotMatch(html,/No address saved yet/);
 const both=renderBooking({place:{...bookingPlace,offlineDetails:{name:'Tea ceremony',address:'12 Saved Street',localAddress:'京都市東山区 12'}}});assert.match(both,/12 Saved Street/);assert.match(both,/京都市東山区 12/);assert.doesNotMatch(both,/12 Tea Street, Kyoto/);
});
console.log(`${checks} Today presentation checks passed.`);
