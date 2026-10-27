import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=(path,modules={})=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/from (['"])([^'"]+)\1/g,(match,_,name)=>modules[name]?`from ${JSON.stringify(modules[name])}`:match)).toString('base64');
const modelUrl=compile('../model.ts'),backupUrl=compile('../tripBackup.ts',{'./model':modelUrl}),cloudTypes=compile('../cloud/types.ts');
const codecUrl=compile('../cloud/codec.ts',{'../model':modelUrl,'../tripBackup':backupUrl,'./types':cloudTypes});
const typesUrl=compile('./types.ts'),mergeUrl=compile('./merge.ts',{'../model':modelUrl}),storageUrl=compile('./storage.ts',{'../cloud/codec':codecUrl});
const controllerUrl=compile('./controller.ts',{'../cloud/codec':codecUrl,'./merge':mergeUrl,'./storage':storageUrl,'./types':typesUrl});
const remoteUrl=compile('./remote.ts',{'../cloud/codec':codecUrl,'./types':typesUrl});
const {seedTrip}=await import(modelUrl),{mergeTrips}=await import(mergeUrl),{CollaborationError}=await import(typesUrl);
const {createMemoryCollaborationStore}=await import(storageUrl),{createCollaborationController}=await import(controllerUrl);
const {decodeSharedTrip,createCollaborationRemote}=await import(remoteUrl);
const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',cloud='33333333-3333-4333-8333-333333333333',epoch='44444444-4444-4444-8444-444444444444';
const clone=value=>structuredClone(value),trip=()=>({...seedTrip(),id:'collab-'+cloud});
const row=(value=trip(),revision=1,role='editor')=>({trip:clone(value),cloudId:cloud,sourceTripId:'kyoto-spring',ownerId:other,role,revision,channelEpoch:epoch,updatedAt:'2026-10-27T12:00:00Z',deletedAt:null});
const wire=(saved=row())=>({cloud_trip_id:saved.cloudId,trip_id:saved.sourceTripId,owner_id:saved.ownerId,document:{...saved.trip,id:saved.sourceTripId},role:saved.role,revision:saved.revision,channel_epoch:saved.channelEpoch,updated_at:saved.updatedAt,deleted_at:saved.deletedAt,schema_version:2});
function fakeRemote(initial=row()){
  let current=clone(initial);const receipts=new Map();
  const api={calls:[],before:null,after:null,get current(){return current;},set current(value){current=clone(value);},
    async list(){return [clone(current)];},async get(){return clone(current);},
    async mutate(input){api.calls.push(clone(input));if(api.before)await api.before(input);
      if(receipts.has(input.mutationId)){const receipt=receipts.get(input.mutationId);assert.deepEqual(receipt.input,input);return {trip:clone(current),committedRevision:receipt.revision,replayed:true};}
      if(input.expectedRevision!==current.revision)throw new CollaborationError('conflict','Changed',clone(current));
      current={...current,trip:clone(input.trip||current.trip),revision:current.revision+1,deletedAt:input.operation==='delete'?'2026-10-27T12:01:00Z':input.operation==='restore'?null:current.deletedAt};
      receipts.set(input.mutationId,{input:clone(input),revision:current.revision});if(api.after)await api.after(input);
      return {trip:clone(current),committedRevision:current.revision,replayed:false};
    }};return api;
}
const active=[];let passed=0,failed=0;
async function controller(remote=fakeRemote(),store=createMemoryCollaborationStore()){
  const value=createCollaborationController({store,autoSync:false,requestTimeoutMs:100});active.push(value);await value.setIdentity(actor,remote);await value.refresh();return {value,remote,store};
}
async function check(name,fn){try{await fn();passed++;console.log('✓ '+name);}catch(error){failed++;console.error('✗ '+name+': '+String(error.stack||error).replace(/data:text\/javascript;base64,[^ )]+/g,'[compiled]'));}finally{for(const value of active.splice(0))value.dispose();}}

await check('different days merge without replacing another editor’s work',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].title='My day';r.days[1].title='Their day';const result=mergeTrips(b,l,r);assert.equal(result.conflicts.length,0);assert.equal(result.trip.days[0].title,'My day');assert.equal(result.trip.days[1].title,'Their day');
});
await check('different fields on a stable activity merge',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items[0].note='Mine';r.days[0].items[0].duration=75;const result=mergeTrips(b,l,r);assert.equal(result.conflicts.length,0);assert.equal(result.trip.days[0].items[0].note,'Mine');assert.equal(result.trip.days[0].items[0].duration,75);
});
await check('same field conflicts and choosing mine preserves unrelated remote edits',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items[0].note='Mine';r.days[0].items[0].note='Theirs';r.days[1].title='Other day';
  const result=mergeTrips(b,l,r);assert.equal(result.conflicts.length,1);const resolved=mergeTrips(b,l,r,{[result.conflicts[0].path]:'local'});assert.equal(resolved.conflicts.length,0);assert.equal(resolved.trip.days[0].items[0].note,'Mine');assert.equal(resolved.trip.days[1].title,'Other day');
});
await check('two additions in the same gap both survive with server addition first',()=>{
  const b=trip(),l=clone(b),r=clone(b);const extra={...l.days[0].items[0],aid:'local'};l.days[0].items.splice(1,0,extra);r.days[0].items.splice(1,0,{...extra,aid:'remote'});
  const result=mergeTrips(b,l,r);assert.equal(result.conflicts.length,0);assert.deepEqual(result.trip.days[0].items.slice(0,4).map(i=>i.aid),['a1','remote','local','a2']);
});
await check('concurrent same-day reorder asks for an order choice',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items.reverse();r.days[0].items.push(r.days[0].items.shift());assert(mergeTrips(b,l,r).conflicts.some(c=>c.kind==='order'));
});
await check('reorder against changed travel inputs conflicts, notes remain independent',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items.reverse();r.days[0].items[0].duration=40;assert(mergeTrips(b,l,r).conflicts.some(c=>c.kind==='order'));
  r.days[0].items[0].duration=b.days[0].items[0].duration;r.days[0].items[0].note='Note';assert.equal(mergeTrips(b,l,r).conflicts.length,0);
});
await check('delete against an edited activity conflicts instead of resurrecting silently',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items.shift();r.days[0].items[0].note='Changed';assert.equal(mergeTrips(b,l,r).conflicts[0].kind,'delete');
});
await check('competing cross-day moves cannot duplicate a stable activity',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[1].items.push(l.days[0].items.shift());r.days[2].items.push(r.days[0].items.shift());const result=mergeTrips(b,l,r);assert(result.conflicts.some(c=>c.path==='/days/$structure'));const aids=result.trip.days.flatMap(d=>d.items.map(i=>i.aid));assert.equal(new Set(aids).size,aids.length);
});
await check('independent idea additions are retained',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.ideas.push('left');r.ideas.push('right');assert(mergeTrips(b,l,r).trip.ideas.includes('left'));assert(mergeTrips(b,l,r).trip.ideas.includes('right'));
});
await check('cloud identity is globally scoped and owner private responses are gated',()=>{
  assert.equal(decodeSharedTrip(wire(),actor).trip.id,'collab-'+cloud);assert.throws(()=>decodeSharedTrip({...wire(),role:'owner'},actor),/verified/);
  assert.throws(()=>decodeSharedTrip({...wire(),cloud_trip_id:'bad'},actor),/verified/);
});
await check('local edits persist before any network request',async()=>{
  const {value,remote,store}=await controller();const edited=clone(value.getSnapshot().trips[0]);edited.name='Local';assert(await value.changeTrip(edited));assert.equal(remote.calls.length,0);const persisted=await store.read('collaboration:'+actor);assert.equal(persisted.records[cloud].draft.name,'Local');assert.equal(value.getSnapshot().pendingCount,1);
});
await check('save succeeds and acknowledged draft becomes synced',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.name='Saved';await value.changeTrip(edited);await value.sync();assert.equal(remote.current.trip.name,'Saved');assert.equal(value.getSnapshot().pendingCount,0);
});
await check('stale independent edit merges, retries with a fresh ID, and preserves both changes',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.days[0].title='Mine';await value.changeTrip(edited);remote.current={...remote.current,revision:2,trip:{...remote.current.trip,name:'Friend'}};await value.sync();assert.equal(remote.calls.length,2);assert.notEqual(remote.calls[0].mutationId,remote.calls[1].mutationId);assert.equal(remote.current.trip.name,'Friend');assert.equal(remote.current.trip.days[0].title,'Mine');
});
await check('same field conflict stops retrying and resolves only disputed values',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.name='Mine';await value.changeTrip(edited);const otherTrip=trip();otherTrip.name='Theirs';otherTrip.days[1].title='Keep';remote.current=row(otherTrip,2);await value.sync();assert.equal(remote.calls.length,1);const conflict=value.getSnapshot().conflicts[0];assert(conflict);await value.resolveConflict(edited.id,Object.fromEntries(conflict.fields.map(field=>[field.path,'local'])));await value.sync();assert.equal(remote.current.trip.name,'Mine');assert.equal(remote.current.trip.days[1].title,'Keep');
});
await check('lost acknowledgement reuses the immutable operation ID after others save',async()=>{
  const {value,remote}=await controller();let first=true;remote.after=async()=>{if(first){first=false;throw new CollaborationError('unavailable','Lost acknowledgement');}};
  const edited=trip();edited.name='Accepted';await value.changeTrip(edited);await value.sync();assert.equal(value.getSnapshot().pendingCount,1);const newer=clone(remote.current);newer.trip.days[1].title='Friend later';newer.revision++;remote.current=newer;
  await value.sync();assert.equal(remote.calls.length,2);assert.deepEqual(remote.calls[0],remote.calls[1]);assert.equal(value.getSnapshot().trips[0].days[1].title,'Friend later');assert.equal(value.getSnapshot().pendingCount,0);
});
await check('edits made during an in-flight request survive its acknowledgement',async()=>{
  const {value,remote}=await controller();let entered;const started=new Promise(resolve=>entered=resolve);let release;const gate=new Promise(resolve=>release=resolve);remote.before=async()=>{entered();await gate;};
  const edited=trip();edited.name='First';await value.changeTrip(edited);const syncing=value.sync();await started;const next=clone(value.getSnapshot().trips[0]);next.days[1].title='Later';await value.changeTrip(next);remote.before=null;release();await syncing;assert.equal(remote.current.trip.name,'First');assert.equal(remote.current.trip.days[1].title,'Later');assert.equal(value.getSnapshot().pendingCount,0);
});
await check('undo reverts only my change and preserves a friend’s later edit',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.name='My name';await value.changeTrip(edited);await value.sync();const next=clone(remote.current);next.trip.days[1].title='Their title';next.revision++;remote.current=next;await value.refresh();assert(await value.undo(edited.id));await value.sync();assert.equal(remote.current.trip.name,trip().name);assert.equal(remote.current.trip.days[1].title,'Their title');
});
await check('undo refuses to overwrite a later edit of the same field',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.name='Mine';await value.changeTrip(edited);await value.sync();remote.current=row({...remote.current.trip,name:'Theirs'},3);await value.refresh();assert.equal(await value.undo(edited.id),false);assert.equal(remote.current.trip.name,'Theirs');
});
await check('viewers cannot submit edits or delete trips',async()=>{
  const {value,remote}=await controller(fakeRemote(row(trip(),1,'viewer')));const edited=trip();edited.name='No';assert.equal(await value.changeTrip(edited),false);assert.equal(await value.deleteTrip(edited.id),false);await value.sync();assert.equal(remote.calls.length,0);
});
await check('downgrading an offline editor keeps a recovery draft but stops writes',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.name='Offline';await value.changeTrip(edited);remote.current=row(trip(),1,'viewer');await value.refresh();await value.sync();assert.equal(remote.calls.length,0);assert.equal(value.getSnapshot().recoveryDrafts[0].name,'Offline');assert.equal(value.getSnapshot().trips[0].name,trip().name);
});
await check('revoked membership hides the trip and preserves only unsynced recovery data',async()=>{
  const {value,remote}=await controller();const edited=trip();edited.name='Offline';await value.changeTrip(edited);remote.list=async()=>[];await value.refresh();await value.sync();assert.equal(value.getSnapshot().trips.length,0);assert.equal(value.getSnapshot().recoveryDrafts[0].name,'Offline');assert.equal(remote.calls.length,0);
});
await check('account switch never exposes the previous account’s cached drafts',async()=>{
  const {value}=await controller();await value.setIdentity(other,{list:async()=>[]});assert.equal(value.getSnapshot().trips.length,0);assert.equal(value.getSnapshot().actorId,other);await value.refresh();assert.equal(value.getSnapshot().trips.length,0);
});
await check('refresh defers an active form update until editing finishes',async()=>{
  const {value,remote}=await controller();value.setScope(trip().id);value.setEditing(true);remote.current=row({...trip(),name:'Friend'},2);await value.refresh();assert.equal(value.getSnapshot().trips[0].name,trip().name);assert.equal(value.getSnapshot().remoteUpdatesPending,true);value.setEditing(false);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(value.getSnapshot().trips[0].name,'Friend');
});
await check('pending requests survive controller restart and keep their mutation ID',async()=>{
  const {value,remote,store}=await controller();remote.before=async()=>{throw new CollaborationError('unavailable','Offline');};const edited=trip();edited.name='Draft';await value.changeTrip(edited);await value.sync();const id=remote.calls[0].mutationId;value.dispose();remote.before=null;const reopened=await controller(remote,store);await reopened.value.sync();assert.equal(remote.calls[1].mutationId,id);assert.equal(reopened.value.getSnapshot().pendingCount,0);
});
await check('private rows from another actor cannot pass owner decoding',()=>{
  const saved=row(trip(),1,'owner');assert.throws(()=>decodeSharedTrip(wire(saved),actor));assert.equal(decodeSharedTrip(wire(saved),other).role,'owner');
});
await check('remote verifies account both before and after an RPC',async()=>{
  let user=actor;const client={auth:{getSession:async()=>({data:{session:{user:{id:user}}}})},rpc:async()=>{user=other;return {data:[wire()]};}};
  await assert.rejects(createCollaborationRemote(client,actor).list(),error=>error.code==='auth');
});
await check('moving a stop conflicts with a simultaneous deletion in either direction',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[1].items.push(l.days[0].items.shift());r.days[0].items.shift();
  const first=mergeTrips(b,l,r);assert(first.conflicts.some(field=>field.path==='/days/$structure'));assert(!first.trip.days.flatMap(day=>day.items).some(item=>item.aid==='a1'));
  assert(mergeTrips(b,r,l).conflicts.some(field=>field.path==='/days/$structure'));
});
await check('changing day endpoints invalidates a stale reorder proposal',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items.reverse();r.days[0].startPlaceId='gion';assert(mergeTrips(b,l,r).conflicts.some(field=>field.kind==='order'));
});
await check('two local tabs preserve independent unsaved edits',async()=>{
  const store=createMemoryCollaborationStore(),remote=fakeRemote();const a=await controller(remote,store),b=await controller(remote,store);
  const first=trip();first.name='First tab';await a.value.changeTrip(first);const second=trip();second.days[1].title='Second tab';await b.value.changeTrip(second);await a.value.sync();
  assert.equal(remote.current.trip.name,'First tab');assert.equal(remote.current.trip.days[1].title,'Second tab');
});
await check('choosing another local tab’s conflicting draft still sends it to the server',async()=>{
  const store=createMemoryCollaborationStore(),remote=fakeRemote();const a=await controller(remote,store),b=await controller(remote,store);
  const first=trip();first.name='First tab';await a.value.changeTrip(first);const second=trip();second.name='Second tab';assert.equal(await b.value.changeTrip(second),false);
  const conflict=b.value.getSnapshot().conflicts[0];assert(conflict);await b.value.refresh();assert(b.value.getSnapshot().conflicts.length);assert(await b.value.resolveConflict(second.id,Object.fromEntries(conflict.fields.map(field=>[field.path,'remote']))));
  await b.value.sync();assert.equal(remote.current.trip.name,'First tab');assert.equal(b.value.getSnapshot().pendingCount,0);
});
await check('a local-tab conflict waits for an immutable pending acknowledgement',async()=>{
  const store=createMemoryCollaborationStore(),remote=fakeRemote();const a=await controller(remote,store),b=await controller(remote,store);
  remote.before=async()=>{throw new CollaborationError('unavailable','offline');};const first=trip();first.name='First tab';await a.value.changeTrip(first);await a.value.sync();
  const second=trip();second.name='Second tab';await b.value.changeTrip(second);let conflict=b.value.getSnapshot().conflicts[0];assert(conflict);assert.equal(await b.value.resolveConflict(second.id,{[conflict.fields[0].path]:'local'}),false);
  remote.before=null;await b.value.sync();conflict=b.value.getSnapshot().conflicts[0];assert(conflict);assert(await b.value.resolveConflict(second.id,{[conflict.fields[0].path]:'remote'}));await b.value.sync();assert.equal(remote.current.trip.name,'First tab');
});
await check('permission downgrade clears stale deferred form refreshes',async()=>{
  const {value,remote}=await controller();value.setScope(trip().id);value.setEditing(true);remote.current=row({...trip(),name:'Changed'},2);await value.refresh();assert(value.getSnapshot().remoteUpdatesPending);
  remote.current={...remote.current,role:'viewer',channelEpoch:'55555555-5555-4555-8555-555555555555'};await value.refresh();value.setEditing(false);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(value.getSnapshot().metadataById[trip().id].role,'viewer');assert.equal(await value.changeTrip({...trip(),name:'Denied'}),false);
});
await check('revocation clears deferred form refreshes and clean caches',async()=>{
  const {value,remote,store}=await controller();value.setScope(trip().id);value.setEditing(true);remote.current=row({...trip(),name:'Changed'},2);await value.refresh();remote.list=async()=>[];await value.refresh();value.setEditing(false);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(value.getSnapshot().trips.length,0);assert.equal(Object.keys((await store.read('collaboration:'+actor)).records).length,0);
});
await check('storage failures block network writes and retain the previous snapshot',async()=>{
  const memory=createMemoryCollaborationStore();let fail=false;const store={read:memory.read,update:async(...args)=>{if(fail)throw new Error('Disk full');return memory.update(...args);}};
  const {value,remote}=await controller(fakeRemote(),store);fail=true;assert.equal(await value.changeTrip({...trip(),name:'Cannot save'}),false);await value.sync();assert.equal(remote.calls.length,0);assert.equal(value.getSnapshot().trips[0].name,trip().name);assert.match(value.getSnapshot().error,/Disk full/);
});
await check('an old account’s delayed device write never appears in a new account',async()=>{
  const memory=createMemoryCollaborationStore();let wait=false,release;const gate=new Promise(resolve=>release=resolve);const store={read:memory.read,update:async(...args)=>{if(wait)await gate;return memory.update(...args);}};
  const {value}=await controller(fakeRemote(),store);wait=true;const saving=value.changeTrip({...trip(),name:'Old actor'});await value.setIdentity(other,{list:async()=>[]});release();await saving;assert.equal(value.getSnapshot().actorId,other);assert.equal(value.getSnapshot().trips.length,0);
});
await check('lost acknowledgement plus a later overlapping edit preserves the unsaved choice',async()=>{
  const {value,remote}=await controller();let first=true;remote.after=async()=>{if(first){first=false;throw new CollaborationError('unavailable','Lost acknowledgement');}};
  await value.changeTrip({...trip(),name:'Accepted first'});await value.sync();await value.changeTrip({...value.getSnapshot().trips[0],name:'My next name'});
  remote.current={...remote.current,revision:3,trip:{...remote.current.trip,name:'Friend name'}};await value.sync();assert.equal(value.getSnapshot().trips[0].name,'My next name');const conflict=value.getSnapshot().conflicts[0];assert(conflict);assert.equal(conflict.fields[0].local,'My next name');
  assert(await value.resolveConflict(trip().id,{[conflict.fields[0].path]:'local'}));await value.sync();assert.equal(remote.current.trip.name,'My next name');
});
await check('deleting a dirty trip saves its latest draft before moving it to Trash',async()=>{
  const ownerRow={...row(),role:'owner',ownerId:actor};const {value,remote}=await controller(fakeRemote(ownerRow));await value.changeTrip({...trip(),name:'Latest before Trash'});assert(await value.deleteTrip(trip().id));await value.sync();assert.deepEqual(remote.calls.map(call=>call.operation),['save','delete']);assert.equal(remote.current.trip.name,'Latest before Trash');assert(remote.current.deletedAt);assert.equal(value.getSnapshot().pendingCount,0);
});
await check('restore requested during a delete is not lost when delete is acknowledged',async()=>{
  const ownerRow={...row(),role:'owner',ownerId:actor};const {value,remote}=await controller(fakeRemote(ownerRow));let entered;const started=new Promise(resolve=>entered=resolve);let release;const gate=new Promise(resolve=>release=resolve);remote.before=async()=>{entered();await gate;};
  await value.deleteTrip(trip().id);const syncing=value.sync();await started;assert(await value.restore(trip().id));remote.before=null;release();await syncing;assert.deepEqual(remote.calls.map(call=>call.operation),['delete','restore']);assert.equal(remote.current.deletedAt,null);
});
await check('reorder reviews a newly added or removed stop instead of applying a stale proposal',()=>{
  const b=trip(),l=clone(b),r=clone(b);l.days[0].items.reverse();r.days[0].items.push({...r.days[0].items[0],aid:'new-stop'});assert(mergeTrips(b,l,r).conflicts.some(field=>field.kind==='order'));
  r.days[0].items.pop();r.days[0].items.shift();assert(mergeTrips(b,l,r).conflicts.some(field=>field.kind==='order'));
});
await check('reviewing a deleted stay link retains independent local titles and notes',async()=>{
  const base=trip();base.stays=[{id:'stay-one',placeId:'hotel',checkInDate:'2027-05-14',checkOutDate:'2027-05-17',timezone:'Asia/Tokyo'}];
  const {value,remote}=await controller(fakeRemote(row(base)));const local=clone(base);local.name='Keep my title';local.days[0].startStayId='stay-one';local.days[0].startPlaceId='hotel';local.days[1].items[0].note='Keep this note';assert(await value.changeTrip(local));
  const updated=clone(base);updated.stays=[];updated.days[2].title='Their day';remote.current=row(updated,2);await value.sync();const conflict=value.getSnapshot().conflicts[0];assert(conflict.fields.some(field=>field.path==='/$structure'));
  assert(await value.resolveConflict(local.id,Object.fromEntries(conflict.fields.map(field=>[field.path,'remote']))));await value.sync();assert.equal(remote.current.trip.name,'Keep my title');assert.equal(remote.current.trip.days[1].items[0].note,'Keep this note');assert.equal(remote.current.trip.days[2].title,'Their day');assert.equal(remote.current.trip.days[0].startStayId,undefined);
});
await check('cross-day structural review preserves independent edits on other days',()=>{
  const base=trip(),local=clone(base),remote=clone(base);local.days[1].items.push(local.days[0].items.shift());local.days[2].title='Independent title';local.days[2].items[0].note='Independent note';remote.days[0].items.shift();
  const result=mergeTrips(base,local,remote,{'/days/$structure':'remote'});assert.equal(result.conflicts.length,0);assert.equal(result.trip.days[2].title,'Independent title');assert.equal(result.trip.days[2].items[0].note,'Independent note');assert(!result.trip.days.flatMap(day=>day.items).some(item=>item.aid==='a1'));
});
await check('same-account browser tabs do not broadcast an endless no-op sync loop',async()=>{
  const originalWindow=globalThis.window,originalChannel=globalThis.BroadcastChannel;let posts=0;const channels=new Set();
  class Channel{constructor(name){this.name=name;this.closed=false;channels.add(this);}postMessage(data){posts++;if(posts>50)return;for(const peer of channels)if(peer!==this&&!peer.closed&&peer.name===this.name)queueMicrotask(()=>peer.onmessage?.({data}));}close(){this.closed=true;channels.delete(this);}}
  try{globalThis.window=new EventTarget();globalThis.BroadcastChannel=Channel;const store=createMemoryCollaborationStore(),remote=fakeRemote();
    const a=createCollaborationController({store,requestTimeoutMs:100}),b=createCollaborationController({store,requestTimeoutMs:100});active.push(a,b);await a.setIdentity(actor,remote);await b.setIdentity(actor,remote);await new Promise(resolve=>setTimeout(resolve,20));
    await a.changeTrip({...trip(),name:'Across tabs'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(remote.current.trip.name,'Across tabs');const settled=posts;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(posts,settled);assert(posts<20);assert.equal(b.getSnapshot().trips[0].name,'Across tabs');
  }finally{for(const value of active)value.dispose();if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;globalThis.BroadcastChannel=originalChannel;}
});
await check('invitation preview validates the recipient details and calls only preview',async()=>{
  const calls=[];const payload={trip_name:'Dublin',owner_name:'Friend',role:'editor',email:'friend@example.test',expires_at:'2026-11-03T12:00:00Z'};
  const client={auth:{getSession:async()=>({data:{session:{user:{id:actor}}}})},rpc:async(name,args)=>{calls.push({name,args});return {data:payload};}};
  assert.deepEqual(await createCollaborationRemote(client,actor).previewInvite('test-token'),payload);assert.equal(calls[0].name,'daytrail_collab_preview_invite');assert.equal(calls.length,1);
  payload.role='owner';await assert.rejects(createCollaborationRemote(client,actor).previewInvite('test-token'),error=>error.code==='invalid');
});
await check('wrong invitation account has a useful error without exposing server details',async()=>{
  const client={auth:{getSession:async()=>({data:{session:{user:{id:actor}}}})},rpc:async()=>({error:{code:'42501',message:'Sign in with the invited Google account'}})};
  await assert.rejects(createCollaborationRemote(client,actor).previewInvite('token'),error=>error.code==='auth'&&/matching the invited email/.test(error.message));
});
await check('independent comfort edits merge while same-field pace conflicts stay explicit',()=>{
 const base=trip(),local=clone(base),remote=clone(base);local.days[0].items[0].meal='meal';remote.days[0].items[0].walkingMeters=1800;
 const merged=mergeTrips(base,local,remote);assert.deepEqual(merged.conflicts,[]);assert.equal(merged.trip.days[0].items[0].meal,'meal');assert.equal(merged.trip.days[0].items[0].walkingMeters,1800);
 local.pace='relaxed';remote.pace='active';const conflict=mergeTrips(base,local,remote);assert.ok(conflict.conflicts.some(item=>item.path==='/pace'&&item.label==='Walking pace'));
});
await check('rapid duration taps accumulate against the latest durable draft before rendering',async()=>{
 const {value,store}=await controller(),before=clone(value.getSnapshot().trips[0]),item=before.days[0].items[0];
 assert.deepEqual(await Promise.all([15,15,15,-15].map(delta=>value.adjustActivityDuration(before.id,item.aid,delta))),[true,true,true,true]);
 const expected=clone(before);expected.days[0].items[0].duration+=30;
 assert.deepEqual(value.getSnapshot().trips[0],expected);
 assert.deepEqual((await store.read('collaboration:'+actor)).records[cloud].draft,expected);
 assert.equal(value.getSnapshot().conflicts.length,0);
});
await check('arrival visit duration remains editable without changing its linked flight booking',async()=>{
 const saved=trip(),place=id=>({id,name:id,cat:'custom',x:50,y:50,area:'',typical:'',blurb:''});
 saved.customPlaces={...saved.customPlaces,airportA:place('airportA'),airportB:place('airportB')};
 saved.flights=[{id:'arrival-flight',fromPlaceId:'airportA',toPlaceId:'airportB',departure:{date:saved.startDate,time:'10:00',timezone:'Europe/London'},arrival:{date:saved.startDate,time:'11:00',timezone:'Europe/Dublin'},airportBufferMinutes:120,arrivalBufferMinutes:60}];
 saved.days[0].startPlaceId='airportA';saved.days[0].endPlaceId='airportB';saved.days[0].endMode='drive';
 saved.days[0].items=[{aid:'departure-buffer',placeId:'airportA',mode:'walk',departureForFlightId:'arrival-flight',duration:120,fixed:null,note:''},{aid:'arrival-visit',placeId:'airportB',mode:'flight',flightId:'arrival-flight',duration:45,fixed:null,note:'Meet family after landing'}];
 const {value}=await controller(fakeRemote(row(saved))),before=clone(value.getSnapshot().trips[0]);
 assert(await value.adjustActivityDuration(saved.id,'arrival-visit',15));
 const expected=clone(before);expected.days[0].items[1].duration=60;
 assert.deepEqual(value.getSnapshot().trips[0],expected);
 assert.deepEqual(value.getSnapshot().trips[0].flights,before.flights);
 assert.equal(await value.adjustActivityDuration(saved.id,'departure-buffer',15),false);
 assert.deepEqual(value.getSnapshot().trips[0],expected);
});
await check('duration taps preserve another tab’s latest fields and follow a moved activity',async()=>{
 const store=createMemoryCollaborationStore(),remote=fakeRemote(),a=await controller(remote,store),b=await controller(remote,store);
 const before=clone(b.value.getSnapshot().trips[0]),item=before.days[0].items.shift();
 item.note='Keep this latest note';item.freeTime={id:'free-shared',kind:'explore',duration:60,untilBooking:false};before.days[1].items.push(item);before.name='Latest title';
 assert(await b.value.changeTrip(before));
 assert(await a.value.adjustActivityDuration(before.id,item.aid,15));
 const expected=clone(before);expected.days[1].items.at(-1).duration+=15;
 assert.deepEqual(a.value.getSnapshot().trips[0],expected);
});
await check('duration bounds are successful no-ops and preserve the prior undo record',async()=>{
 const {value,store}=await controller(),saved=value.getSnapshot().trips[0],item=saved.days[0].items[0];
 assert(await value.adjustActivityDuration(saved.id,item.aid,-5000));
 const lowUndo=clone((await store.read('collaboration:'+actor)).records[cloud].undo);
 assert(await value.adjustActivityDuration(saved.id,item.aid,-15));
 assert.equal(value.getSnapshot().trips[0].days[0].items[0].duration,15);
 assert.deepEqual((await store.read('collaboration:'+actor)).records[cloud].undo,lowUndo);
 assert(await value.adjustActivityDuration(saved.id,item.aid,5000));
 const highUndo=clone((await store.read('collaboration:'+actor)).records[cloud].undo);
 assert(await value.adjustActivityDuration(saved.id,item.aid,15));
 assert.equal(value.getSnapshot().trips[0].days[0].items[0].duration,1440);
 assert.deepEqual((await store.read('collaboration:'+actor)).records[cloud].undo,highUndo);
 for(const delta of [0,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(await value.adjustActivityDuration(saved.id,item.aid,delta),false);
 assert.equal(await value.adjustActivityDuration(saved.id,'missing-activity',15),false);
 assert(await value.undo(saved.id));assert.equal(value.getSnapshot().trips[0].days[0].items[0].duration,15);
});
await check('a queued duration tap rechecks permissions, deletion and conflicts in storage',async()=>{
 const changes=[record=>{record.base.role='viewer';},record=>{record.revoked=true;},record=>{record.desiredDeleted=true;},record=>{record.conflicts=[{path:'/name',label:'Trip name',kind:'field',base:'A',local:'B',remote:'C'}];},record=>{record.draft.days[0].items.shift();}];
 for(const change of changes){
  const memory=createMemoryCollaborationStore();let wait=false,release;const gate=new Promise(resolve=>release=resolve);
  const store={read:memory.read,update:async(...args)=>{if(wait)await gate;return memory.update(...args);}};
  const {value}=await controller(fakeRemote(),store),before=value.getSnapshot().trips[0];wait=true;
  const adjusting=value.adjustActivityDuration(before.id,before.days[0].items[0].aid,15);
  await memory.update('collaboration:'+actor,current=>{change(current.records[cloud]);return current;});
  const latest=await memory.read('collaboration:'+actor);release();
  assert.equal(await adjusting,false);assert.deepEqual(await memory.read('collaboration:'+actor),latest);
 }
});
await check('account switches cancel queued duration taps before they change the old account draft',async()=>{
 const memory=createMemoryCollaborationStore();let wait=false,release;const gate=new Promise(resolve=>release=resolve);
 const store={read:memory.read,update:async(...args)=>{if(wait)await gate;return memory.update(...args);}};
 const {value,remote}=await controller(fakeRemote(),store),before=await memory.read('collaboration:'+actor),saved=value.getSnapshot().trips[0];wait=true;
 const adjusting=value.adjustActivityDuration(saved.id,saved.days[0].items[0].aid,15);
 await value.setIdentity(other,{list:async()=>[]});release();
 assert.equal(await adjusting,false);assert.deepEqual(await memory.read('collaboration:'+actor),before);
 assert.equal(value.getSnapshot().actorId,other);assert.equal(value.getSnapshot().trips.length,0);assert.equal(remote.calls.length,0);
});
await check('duration edits queued during save preserve immutable requests and all later taps',async()=>{
 const {value,remote}=await controller(),saved=value.getSnapshot().trips[0],item=saved.days[0].items[0];
 assert(await value.adjustActivityDuration(saved.id,item.aid,15));
 let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 remote.before=async()=>{entered();await gate;};const syncing=value.sync();await started;
 const sent=clone(remote.calls[0]);
 assert.deepEqual(await Promise.all([15,15].map(delta=>value.adjustActivityDuration(saved.id,item.aid,delta))),[true,true]);
 assert.deepEqual(remote.calls[0],sent);remote.before=null;release();await syncing;
 assert.equal(remote.current.trip.days[0].items[0].duration,item.duration+45);assert.equal(value.getSnapshot().pendingCount,0);
 assert(await value.undo(saved.id));assert.equal(value.getSnapshot().trips[0].days[0].items[0].duration,item.duration+30);
});
await check('duration storage failures keep the draft unchanged and never reach the server',async()=>{
 const memory=createMemoryCollaborationStore();let fail=false;
 const store={read:memory.read,update:async(...args)=>{if(fail)throw new Error('Disk full');return memory.update(...args);}};
 const {value,remote}=await controller(fakeRemote(),store),before=clone(value.getSnapshot().trips[0]);fail=true;
 assert.equal(await value.adjustActivityDuration(before.id,before.days[0].items[0].aid,15),false);
 assert.deepEqual(value.getSnapshot().trips[0],before);assert.equal(remote.calls.length,0);assert.match(value.getSnapshot().error,/Disk full/);
});
console.log(`\n${passed} collaboration checks passed; ${failed} failed.`);if(failed)process.exitCode=1;
