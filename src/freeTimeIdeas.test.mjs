import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const cache=new Map(),root=dirname(fileURLToPath(import.meta.url));
function moduleURL(file){
 if(cache.has(file))return cache.get(file);
 let source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replaceAll('import.meta.env','({})');
 source=source.replace(/from (['"])([^'"]+)\1/g,(match,_,name)=>{
  if(!name.startsWith('.'))return `from ${JSON.stringify(import.meta.resolve(name))}`;
  const base=resolve(dirname(file),name),target=[base,base+'.ts'].find(existsSync);return `from ${JSON.stringify(moduleURL(target))}`;
 });
 const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');cache.set(file,url);return url;
}
const model=await import(moduleURL(resolve(root,'model.ts'))),ideas=await import(moduleURL(resolve(root,'freeTimeIdeas.ts')));
const {scheduleWithOpeningHours}=await import(moduleURL(resolve(root,'hoursPlanning.ts')));
const {createWorkspaceController}=await import(moduleURL(resolve(root,'cloud/controller.ts'))),{createMemoryWorkspaceStore}=await import(moduleURL(resolve(root,'cloud/storage.ts')));
const place=(id,lat=51.5)=>({id,name:id,cat:'attr',x:0,y:0,area:'',typical:'',blurb:'',lat,lng:0});
const allDay={fetchedAt:0,regularHours:{periods:[{open:{day:0,hour:0,minute:0}}],weekdayDescriptions:[]}};
const ready=min=>({mode:'walk',min,km:'0.1',status:'ready',distanceMeters:100});
function fixture(){
 const trip=model.createTrip('Free time','London','2026-10-27',1);trip.timezone='UTC';
 trip.customPlaces=Object.fromEntries(['hotel','a','b','idea','far','alias','unlocated'].map((id,index)=>[id,place(id,51.5+index*.001)]));
 trip.customPlaces.a.googlePlaceId='anchor-provider';trip.customPlaces.alias.googlePlaceId='anchor-provider';trip.customPlaces.far.lat=52;delete trip.customPlaces.unlocated.lat;delete trip.customPlaces.unlocated.lng;
 trip.days[0].items=[{aid:'a',placeId:'a',duration:60,fixed:null,mode:'walk',note:'',freeTime:{id:'free-a',kind:'explore',duration:30,untilBooking:false}},
  {aid:'b',placeId:'b',duration:60,fixed:640,mode:'walk',note:''}];
 trip.ideas=['idea','far','alias','unlocated','b','a'];
 const places=model.getPlaces(trip);return {trip,dayIndex:0,anchorId:'a',place:places.idea,places,hours:{a:allDay,b:allDay,idea:allDay}};
}
const routes=async(trip,index)=>Object.fromEntries([...trip.days[index].items.map(item=>[item.aid,ready(item.placeId==='a'?0:item.placeId==='idea'?8:10)]),['return',ready(10)]]);
let count=0;async function check(name,run){await run();count++;console.log(`✓ ${name}`);}
await check('nearby Ideas omit planned, unmapped, distant and anchor-alias places',()=>{
 const x=fixture();assert.deepEqual(ideas.nearbyFreeIdeas(x.trip,x.places.a,x.places).map(p=>p.id),['idea']);assert.deepEqual(ideas.nearbyFreeIdeas(x.trip,x.places.unlocated,x.places),[]);
});
await check('nearby shortlist is bounded and sorted by distance before walking checks',()=>{
 const x=fixture();for(let i=1;i<=5;i++){const p=place('near'+i,51.501+i*.0001);x.places[p.id]=p;x.trip.ideas.push(p.id);}
 assert.deepEqual(ideas.nearbyFreeIdeas(x.trip,x.places.a,x.places).map(p=>p.id),['near1','near2','near3']);
});
await check('an alias of a place already planned on any day is not a nearby suggestion',()=>{
 const x=fixture();x.places.b.googlePlaceId='planned-provider';x.places.alias.googlePlaceId='planned-provider';assert.deepEqual(ideas.nearbyFreeIdeas(x.trip,x.places.a,x.places).map(p=>p.id),['idea']);
});
await check('nearby labels use a verified short walking route and respect cancellation',async()=>{
 const x=fixture(),calls=[];
 const result=await ideas.loadNearbyFreeIdeas(x.trip,x.places.a,x.places,()=>true,async(a,b,mode)=>{calls.push([a.id,b.id,mode]);return ready(8);});
 assert.deepEqual(result.map(v=>[v.place.id,v.minutes]),[['idea',8]]);assert.deepEqual(calls,[['a','idea','walk']]);
 assert.deepEqual(await ideas.loadNearbyFreeIdeas(x.trip,x.places.a,x.places,()=>true,async()=>ready(21)),[]);
 assert.deepEqual(await ideas.loadNearbyFreeIdeas(x.trip,x.places.a,x.places,()=>true,async()=>ready(-1)),[]);
 assert.deepEqual(await ideas.loadNearbyFreeIdeas(x.trip,x.places.a,x.places,()=>true,async()=>({...ready(null),status:'unavailable'})),[]);
 assert.deepEqual(await ideas.loadNearbyFreeIdeas(x.trip,x.places.a,x.places,()=>false,async()=>{throw Error('Should not request routes');}),[]);
});
await check('preview shortens the visit to include walking while preserving the next booking',async()=>{
 const x=fixture(),before=structuredClone(x.trip),preview=await ideas.previewFreeVisit(x,{routes});assert.deepEqual(x.trip,before);assert.equal(preview.activity.duration,15);
 ideas.replaceFreeWithVisit(x.trip,preview);assert.deepEqual(x.trip.days[0].items.map(i=>i.placeId),['a','idea','b']);assert.equal(x.trip.days[0].items[0].freeTime,undefined);assert.equal(x.trip.days[0].items[2].fixed,640);assert.equal(x.trip.ideas.includes('idea'),false);
 const sc=scheduleWithOpeningHours(x.trip.days[0],x.places,preview.legs,{date:x.trip.startDate,hours:preview.hours,context:{trip:x.trip,dayIndex:0}});assert.equal(sc.rows[2].late,0);assert.equal(sc.finish,710);assert.equal(model.isTrip(x.trip),true);
});
await check('a visit that cannot fit stays in Ideas without changing the free block',async()=>{
 const x=fixture(),before=structuredClone(x.trip);
 await assert.rejects(()=>ideas.previewFreeVisit(x,{routes:async(trip,index)=>{const legs=await routes(trip,index);for(const item of trip.days[index].items)if(item.placeId==='idea')legs[item.aid]=ready(45);return legs;}}),/cannot fit/);
 assert.deepEqual(x.trip,before);
});
await check('unconfirmed venue hours or incomplete journeys cannot produce a checked visit',async()=>{
 const x=fixture();delete x.hours.idea;await assert.rejects(()=>ideas.previewFreeVisit(x,{routes}),/cannot fit/);
 x.hours.idea=allDay;await assert.rejects(()=>ideas.previewFreeVisit(x,{routes:async()=>({})}),/Confirm journey times/);
});
await check('fresh provider hours are checked and a closed Idea is never offered as fitting',async()=>{
 const x=fixture();x.places.idea.googlePlaceId='idea-provider';let calls=0;
 await assert.rejects(()=>ideas.previewFreeVisit(x,{routes,fetchHours:async id=>{calls++;assert.equal(id,'idea-provider');return {fetchedAt:Date.now(),businessStatus:'CLOSED_TEMPORARILY'};}}),/cannot fit/);assert.equal(calls,1);
});
await check('expired and changed previews are rejected before any plan mutation',async()=>{
 const x=fixture(),preview=await ideas.previewFreeVisit(x,{routes}),before=structuredClone(x.trip);
 assert.throws(()=>ideas.replaceFreeWithVisit(x.trip,preview,preview.verifiedAt+300001),/plan changed/);assert.deepEqual(x.trip,before);
 x.trip.days[0].items[0].freeTime.duration=45;const changed=structuredClone(x.trip);assert.throws(()=>ideas.replaceFreeWithVisit(x.trip,preview),/plan changed/);assert.deepEqual(x.trip,changed);
});
await check('applying a preview preserves concurrently edited notes',async()=>{
 const x=fixture(),preview=await ideas.previewFreeVisit(x,{routes});x.trip.days[0].items[0].note='Keep this note';ideas.replaceFreeWithVisit(x.trip,preview);assert.equal(x.trip.days[0].items[0].note,'Keep this note');
});
await check('removing the suggested Idea while checking invalidates Apply without deleting free time',async()=>{
 const x=fixture(),preview=await ideas.previewFreeVisit(x,{routes});x.trip.ideas=x.trip.ideas.filter(id=>id!=='idea');const before=structuredClone(x.trip);
 assert.throws(()=>ideas.replaceFreeWithVisit(x.trip,preview),/changed|Idea/);assert.deepEqual(x.trip,before);
});
await check('workspace Undo restores the replaced free block and saved Idea together',async()=>{
 const x=fixture(),workspace=createWorkspaceController({store:createMemoryWorkspaceStore(),initialGuestTrips:[x.trip],autoSync:false});
 try{
  await workspace.setIdentity(null,null);const original=structuredClone(workspace.getSnapshot().trips[0]);
  const input={...x,trip:original,places:model.getPlaces(original)},preview=await ideas.previewFreeVisit(input,{routes});
  await workspace.changeTrips(trips=>trips.map(trip=>{if(trip.id!==original.id)return trip;const next=structuredClone(trip);ideas.replaceFreeWithVisit(next,preview);return next;}));
  assert.equal(workspace.getSnapshot().trips[0].days[0].items.length,3);assert.equal(workspace.getSnapshot().canUndo,true);
  await workspace.undo();assert.deepEqual(workspace.getSnapshot().trips[0],original);
 }finally{workspace.dispose();}
});
console.log(`${count} nearby free-time visit checks passed.`);
