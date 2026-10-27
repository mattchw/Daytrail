import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const url=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile=(path,modules={})=>url(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(match,_,name)=>modules[name]?`from ${JSON.stringify(modules[name])}`:match));
const modelURL=compile('../model.ts'),travelURL=compile('../travel/model.ts'),openingURL=compile('../openingHours.ts');
const visitURL=compile('../visitHours.ts',{'./openingHours':openingURL});
const dependencies={'../model':modelURL,'../travel/model':travelURL,'../visitHours':visitURL};
const todayURL=compile('./model.ts',dependencies),actionsURL=compile('./actions.ts',{...dependencies,'./model':todayURL}),storageURL=compile('./storage.ts');
const reactURL=url(`export const useState=initial=>globalThis.__todayHook.useState(initial);export const useRef=initial=>globalThis.__todayHook.useRef(initial);export const useEffect=(fn,deps)=>globalThis.__todayHook.useEffect(fn,deps);`);
const hookURL=compile('./useTodayRuntime.ts',{'react':reactURL,'../travel/model':travelURL,'./model':todayURL,'./actions':actionsURL,'./storage':storageURL});
const model=await import(modelURL),today=await import(todayURL),{useTodayRuntime}=await import(hookURL),{todayStorageKey,serializeTodayRuntime}=await import(storageURL);
let checks=0;const check=async(name,run)=>{await run();checks++;console.log(`✓ ${name}`);};
let clock=Date.parse('2026-10-27T09:00:00Z');const originalNow=Date.now;Date.now=()=>clock;
const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const equalDeps=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
function dispatcher(){
  let cursor=0;const slots=[],effects=[];
  const api={
    useRef(initial){const index=cursor++;if(!slots[index])slots[index]={value:{current:initial}};return slots[index].value;},
    useState(initial){const index=cursor++;if(!slots[index])slots[index]={value:typeof initial==='function'?initial():initial};return [slots[index].value,next=>{slots[index].value=typeof next==='function'?next(slots[index].value):next;}];},
    useEffect(fn,deps){const index=cursor++;if(!slots[index]||!equalDeps(slots[index].deps,deps)){effects.push(()=>{slots[index]?.cleanup?.();slots[index]={deps,cleanup:fn()};});}},
    render(options){cursor=0;globalThis.__todayHook=api;try{return useTodayRuntime(options);}finally{delete globalThis.__todayHook;}},
    flush(){for(const effect of effects.splice(0))effect();},dispose(){for(const slot of slots)slot?.cleanup?.();},
  };return api;
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function session(){
  storage.clear();clock=Date.parse('2026-10-27T09:00:00Z');
  const trip=model.createTrip('Runtime test','Test city','2026-10-27',2);trip.timezone='UTC';
  for(const id of ['hotel','a','b'])trip.customPlaces[id]={id,name:id,cat:'custom',x:0,y:0,area:'',typical:'',blurb:'',lat:51.5,lng:-0.1};
  trip.days[0]={...trip.days[0],startTime:540,startPlaceId:'hotel',endPlaceId:'hotel',endMode:'walk',items:['a','b'].map(aid=>({aid,placeId:aid,duration:60,fixed:null,mode:'walk',note:''}))};
  const places=model.getPlaces(trip),legs=Object.fromEntries(['a','b','return'].map(id=>[id,{mode:'walk',min:10,km:'1',status:'ready'}]));
  const schedule=model.schedule(trip.days[0],places,legs,{trip,dayIndex:0});
  const hook=dispatcher();let options={ownerId:'owner-a',scope:'account',trip,dayIndex:0,places,schedule,marks:{},enabled:true},view;
  const api={
    render(patch={}){options={...options,...patch};view=hook.render(options);return view;},
    get options(){return options;},get view(){return api.render();},
    project(){return today.buildTodayProjection({...options,now:clock,runtime:view.runtime});},
    flush(){hook.flush();return api.render();},dispose:()=>hook.dispose(),
    key:()=>todayStorageKey({ownerId:options.ownerId,scope:options.scope,tripId:trip.id,dayId:trip.days[options.dayIndex].id}),
  };
  options.onSetState=async(targetId,state)=>{api.render({marks:{...options.marks,[targetId]:state}});};
  api.render();api.flush();return api;
}
async function arrive(s){await s.view.arrived(s.project());s.render();assert.equal(s.view.runtime.phase,'visit');}

try{
await check('arrive and extend undo exactly without changing the planned duration',async()=>{
  const s=session();await arrive(s);const prior=s.view.runtime;
  await s.view.stayLonger(s.project());assert.equal(s.view.runtime.leaveAt,prior.leaveAt+15*60000);assert.equal(s.view.canUndo,true);
  await s.view.undo();assert.deepEqual(s.view.runtime,prior);assert.equal(s.options.trip.days[0].items[0].duration,60);assert.equal(s.view.canUndo,false);s.dispose();
});
await check('leaving commits explicit progress and Undo restores both timing and mark',async()=>{
  const s=session();await arrive(s);const prior=s.view.runtime;
  await s.view.leaveNow(s.project());assert.equal(s.view.runtime.phase,'travel');assert.equal(s.options.marks['activity:a'],'done');assert.equal(s.view.canUndo,true);
  await s.view.undo();assert.deepEqual(s.view.runtime,prior);assert.equal(s.options.marks['activity:a'],'planned');s.dispose();
});
await check('free-time entry and completion undo the paired progress and runtime together',async()=>{
  const s=session(),trip=structuredClone(s.options.trip);trip.days[0].items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:true};trip.days[0].items[1].fixed=660;
  s.render({trip});await arrive(s);const before=s.view.runtime;
  await s.view.leaveNow(s.project());assert.equal(s.view.runtime.targetId,'free:free-a');assert.equal(s.view.runtime.phase,'visit');assert.equal(s.options.marks['activity:a'],'done');
  await s.view.undo();assert.deepEqual(s.view.runtime,before);assert.equal(s.options.marks['activity:a'],'planned');
  await s.view.leaveNow(s.project());const free=s.view.runtime;await s.view.leaveNow(s.project());assert.equal(s.options.marks['free:free-a'],'done');assert.equal(s.view.runtime.phase,'travel');
  await s.view.undo();assert.deepEqual(s.view.runtime,free);assert.equal(s.options.marks['free:free-a'],'planned');s.dispose();
});
await check('zero-minute bypass is persisted and undone with leaving the preceding stop',async()=>{
  const s=session(),trip=structuredClone(s.options.trip);trip.days[0].items[0].freeTime={id:'free-a',kind:'explore',duration:60,untilBooking:true};trip.days[0].items[1].fixed=550;
  s.render({trip});await arrive(s);const before=s.view.runtime;
  await s.view.leaveNow(s.project());assert.deepEqual(s.view.runtime.bypassedFreeIds,['free:free-a']);assert.equal(s.view.runtime.targetId,'activity:b');assert.equal(s.project().stale,false);
  await s.view.undo();assert.deepEqual(s.view.runtime,before);assert.equal(s.options.marks['activity:a'],'planned');s.dispose();
});
await check('arrival-only Undo is invalidated by a different manual progress change',async()=>{
  const s=session();await arrive(s);const before=s.view.runtime;
  s.render({marks:{'activity:b':'skipped'}});assert.equal(s.view.canUndo,false);await s.view.undo();assert.deepEqual(s.view.runtime,before);s.dispose();
});
await check('an unrelated mark invalidates Undo even when its own marked target is unchanged',async()=>{
  const s=session();await arrive(s);await s.view.leaveNow(s.project());const before=s.view.runtime;
  s.render({marks:{...s.options.marks,'activity:b':'done'}});assert.equal(s.view.canUndo,false);await s.view.undo();assert.deepEqual(s.view.runtime,before);assert.equal(s.options.marks['activity:a'],'done');s.dispose();
});
await check('pending leave cannot overwrite timing after access is disabled',async()=>{
  const s=session();await arrive(s);const before=s.view.runtime,gate=deferred();s.render({onSetState:()=>gate.promise});
  const pending=s.view.leaveNow(s.project());assert.equal(s.view.busy,true);s.render({enabled:false});gate.resolve();await pending;
  assert.deepEqual(s.view.runtime,before);assert.equal(s.view.canUndo,false);assert.equal(s.view.busy,false);s.dispose();
});
await check('switching identity away and back rejects an old pending operation',async()=>{
  const s=session();await arrive(s);const before=s.view.runtime,gate=deferred();s.render({onSetState:()=>gate.promise});
  const pending=s.view.leaveNow(s.project());s.render({ownerId:'owner-b'});s.flush();assert.equal(s.view.runtime,null);
  s.render({ownerId:'owner-a'});s.flush();assert.deepEqual(s.view.runtime,before);gate.resolve();await pending;
  assert.deepEqual(s.view.runtime,before);assert.equal(s.view.busy,false);assert.equal(s.view.canUndo,false);s.dispose();
});
await check('pending progress cannot persist over another progress change',async()=>{
  const s=session();await arrive(s);const before=s.view.runtime,gate=deferred();s.render({onSetState:()=>gate.promise});
  const pending=s.view.leaveNow(s.project());s.render({marks:{'activity:a':'done','activity:b':'skipped'}});gate.resolve();await pending;
  assert.deepEqual(s.view.runtime,before);assert.equal(s.view.canUndo,false);s.dispose();
});
await check('pending progress cannot persist after a collaborative itinerary edit',async()=>{
  const s=session();await arrive(s);const before=s.view.runtime,gate=deferred();s.render({onSetState:()=>gate.promise});
  const pending=s.view.leaveNow(s.project()),trip=structuredClone(s.options.trip);trip.days[0].items[1].duration=90;s.render({trip});gate.resolve();await pending;
  assert.deepEqual(s.view.runtime,before);assert.equal(s.view.canUndo,false);s.dispose();
});
await check('pending Undo cannot restore timing after itinerary changes',async()=>{
  const s=session();await arrive(s);await s.view.leaveNow(s.project());const before=s.view.runtime,gate=deferred();s.render({onSetState:()=>gate.promise});
  const pending=s.view.undo(),trip=structuredClone(s.options.trip);trip.days[0].items[1].duration=90;s.render({trip});gate.resolve();await pending;
  assert.deepEqual(s.view.runtime,before);assert.equal(s.view.canUndo,false);s.dispose();
});
await check('failed mark writes preserve timing and release busy state',async()=>{
  const s=session();await arrive(s);const before=s.view.runtime;s.render({onSetState:async()=>{throw new Error('Offline progress failed');}});
  await assert.rejects(s.view.leaveNow(s.project()),/Offline progress failed/);assert.deepEqual(s.view.runtime,before);assert.equal(s.view.busy,false);assert.match(s.view.error,/Offline/);s.dispose();
});
await check('unmounting prevents an awaited action from writing stored runtime',async()=>{
  const s=session();await arrive(s);const raw=storage.get(s.key()),gate=deferred();s.render({onSetState:()=>gate.promise});
  const pending=s.view.leaveNow(s.project());s.dispose();gate.resolve();await pending;assert.equal(storage.get(s.key()),raw);
});
await check('callbacks retained from an old account cannot operate on the new account',async()=>{
  const s=session(),oldView=s.view,oldProjection=s.project();s.render({ownerId:'owner-b'});s.flush();
  await oldView.arrived(oldProjection);assert.equal(s.view.runtime,null);assert.equal(storage.has(s.key()),false);s.dispose();
});
await check('account and guest runtime remain isolated for the same trip and day',()=>{
  const s=session(),runtime=today.initialTodayRuntime({...s.options,now:clock});storage.set(s.key(),serializeTodayRuntime(runtime,{ownerId:'owner-a',scope:'account',tripId:s.options.trip.id,dayId:s.options.trip.days[0].id}));
  s.render({ownerId:null,scope:'guest'});s.flush();assert.equal(s.view.runtime,null);assert.equal(s.view.canUndo,false);s.dispose();
});
async function atomicSession(){
  const s=session();let raw=null,fail=false;const calls=[];
  const persistence={read:async()=>raw,commit:async change=>{calls.push(change);if(fail)throw new Error('Storage quota exceeded');assert.equal(change.previous,raw);raw=change.next;if(change.mark)s.render({marks:{...s.options.marks,[change.mark.targetId]:change.mark.expected}});}};
  s.render({persistence,onSetState:async()=>{throw new Error('Non-atomic path used');}});s.flush();await new Promise(resolve=>setImmediate(resolve));s.render();
  return {s,calls,get raw(){return raw;},fail:()=>{fail=true;}};
}
await check('atomic persistence commits one timestamp and progress operation and undoes both',async()=>{
  const a=await atomicSession(),s=a.s;await arrive(s);const prior=s.view.runtime;await s.view.leaveNow(s.project());assert.equal(a.calls.length,2);assert.equal(a.calls[1].mark.expected,'done');assert.equal(s.options.marks['activity:a'],'done');assert.equal(JSON.parse(a.raw).runtime.phase,'travel');
  await s.view.undo();assert.deepEqual(s.view.runtime,prior);assert.equal(s.options.marks['activity:a'],'planned');assert.equal(JSON.parse(a.raw).runtime.phase,'visit');s.dispose();
});
await check('atomic quota failure leaves both runtime and progress untouched',async()=>{
  const a=await atomicSession(),s=a.s;await arrive(s);const before=s.view.runtime,raw=a.raw;a.fail();await assert.rejects(s.view.leaveNow(s.project()),/quota/);assert.deepEqual(s.view.runtime,before);assert.equal(a.raw,raw);assert.equal(s.options.marks['activity:a'],undefined);assert.equal(s.view.busy,false);s.dispose();
});
await check('durable Today storage reloads timestamps after a cold hook restart',async()=>{
  const s=session(),runtime=today.initialTodayRuntime({...s.options,now:clock});const raw=serializeTodayRuntime(runtime,{ownerId:'owner-a',scope:'account',tripId:s.options.trip.id,dayId:s.options.trip.days[0].id});let writes=0;
  s.render({persistence:{read:async()=>raw,commit:async()=>{writes++;}}});s.flush();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(s.view.runtime,runtime);assert.equal(writes,0);s.dispose();
});
console.log(`${checks} Today runtime checks passed.`);
}finally{Date.now=originalNow;delete globalThis.localStorage;}
