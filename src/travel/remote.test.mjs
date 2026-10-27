import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile = (file, modules = {}) => dataURL(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},
}).outputText.replace(/from (['"])([^'"]+)\1/g,(match,_,name)=>modules[name]?`from ${JSON.stringify(modules[name])}`:match));
const model=compile('../model.ts'),backup=compile('../tripBackup.ts',{'./model':model}),cloudTypes=compile('../cloud/types.ts');
const codec=compile('../cloud/codec.ts',{'../model':model,'../tripBackup':backup,'./types':cloudTypes});
const types=compile('./types.ts');
const {TravelError}=await import(types);
const {createTravelRemote,validTravelTarget,MAX_TRAVEL_MARKS}=await import(compile('./remote.ts',{'../cloud/codec':codec,'./types':types}));
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const mutationId='10000000-0000-4000-8000-000000000001';
const stamp='2026-10-27T20:00:00.123456+00:00';
const row=(patch={})=>({owner_id:owner,trip_id:'legacy-trip',target_id:'activity:a1',place_id:'nijo',state:'done',revision:1,updated_at:stamp,...patch});
const mutation=(patch={})=>({tripId:'legacy-trip',targetId:'activity:a1',placeId:'nijo',state:'done',expectedRevision:0,mutationId,...patch});
function fixture({rows=[],response={status:'ok',mark:row()},error=null,sessionError=null,during}={}) {
  let account=owner;
  const calls=[];
  const client={auth:{async getSession(){return {data:{session:account?{user:{id:account}}:null},error:sessionError};}},
    async rpc(name,args){calls.push([name,args]);during?.(()=>{account=other;});return {data:['daytrail_list_travel_marks','daytrail_collab_list_travel_marks'].includes(name)?rows:response,error};}};
  return {remote:createTravelRemote(client,owner),calls,setAccount(value){account=value;}};
}
const rejects=(action,code)=>assert.rejects(action,error=>error instanceof TravelError&&error.code===code);
let checks=0;
async function check(label,action){await action();checks++;console.log(`✓ ${label}`);}

await check('target validation admits activity, end and stable flight identities',()=>{
  for(const target of ['activity:a1','end:day-30','activity:legacy_id','flight:flight-one'])assert.equal(validTravelTarget(target),true,target);
  for(const target of ['activity','end:','start:d1','activity:a:1','activity:constructor','activity:__proto__','end:'+ 'x'.repeat(101),null])assert.equal(validTravelTarget(target),false,String(target));
});
await check('list uses owner-guarded RPC and retains planned and old-location marks',async()=>{
  const f=fixture({rows:[row({state:'planned',place_id:'previous-place'})]});
  const marks=await f.remote.list('legacy-trip');
  assert.deepEqual(f.calls,[['daytrail_list_travel_marks',{p_expected_owner_id:owner,p_trip_id:'legacy-trip'}]]);
  assert.deepEqual(marks,[{targetId:'activity:a1',placeId:'previous-place',state:'planned',revision:1,updatedAt:stamp}]);
});
await check('mutation sends immutable expected revision and account guard',async()=>{
  const f=fixture();assert.equal((await f.remote.mutate(mutation())).revision,1);
  assert.deepEqual(f.calls,[['daytrail_mutate_travel_mark',{p_expected_owner_id:owner,p_trip_id:'legacy-trip',p_target_id:'activity:a1',p_place_id:'nijo',p_state:'done',p_expected_revision:0,p_mutation_id:mutationId}]]);
});
await check('invalid inputs and skipped endpoints never issue requests',async()=>{
  for(const patch of [{tripId:'../other'},{targetId:'start:d1'},{placeId:'constructor'},{state:'complete'},{expectedRevision:-1},{expectedRevision:1.5},{expectedRevision:Number.MAX_SAFE_INTEGER},{mutationId:'bad'},{targetId:'end:d1',state:'skipped'}]){
    const f=fixture();await rejects(()=>f.remote.mutate(mutation(patch)),'invalid');assert.equal(f.calls.length,0);
  }
  const f=fixture();await rejects(()=>f.remote.list('__proto__'),'invalid');assert.equal(f.calls.length,0);
});
await check('wrong account or signed-out session blocks list and mutation before transport',async()=>{
  for(const account of [other,null]){
    const f=fixture();f.setAccount(account);
    await rejects(()=>f.remote.mutate(mutation()),'auth');await rejects(()=>f.remote.list('legacy-trip'),'auth');assert.equal(f.calls.length,0);
  }
});
await check('late results are rejected after an account switch',async()=>{
  const during=switchAccount=>switchAccount();
  await rejects(()=>fixture({during}).remote.mutate(mutation()),'auth');
  await rejects(()=>fixture({during,rows:[row()]}).remote.list('legacy-trip'),'auth');
});
await check('offline auth refresh stays retryable without forcing a different account state',async()=>{
  const f=fixture({sessionError:{name:'AuthRetryableFetchError',status:0,message:'PRIVATE'}});
  await rejects(()=>f.remote.mutate(mutation()),'unavailable');assert.equal(f.calls.length,0);
});
await check('acknowledgements validate revision, target, place and chosen state',async()=>{
  for(const patch of [{revision:0},{revision:2},{target_id:'activity:a2'},{place_id:'gion'},{state:'skipped'},{trip_id:'other-trip'},{updated_at:'invalid'}]){
    await rejects(()=>fixture({response:{status:'ok',mark:row(patch)}}).remote.mutate(mutation()),'invalid');
  }
  await rejects(()=>fixture({response:{status:'ok',mark:row({owner_id:other})}}).remote.mutate(mutation()),'auth');
  await rejects(()=>fixture({response:{status:'unknown',mark:row()}}).remote.mutate(mutation()),'invalid');
});
await check('planned resets and end completion have verified acknowledgements',async()=>{
  const reset=await fixture({response:{status:'ok',mark:row({state:'planned',revision:2})}}).remote.mutate(mutation({state:'planned',expectedRevision:1}));
  assert.equal(reset.state,'planned');assert.equal(reset.revision,2);
  const end=await fixture({response:{status:'ok',mark:row({target_id:'end:d1',place_id:'hotel'})}}).remote.mutate(mutation({targetId:'end:d1',placeId:'hotel'}));
  assert.equal(end.targetId,'end:d1');
});
await check('conflicts retain current revision and may describe an old location',async()=>{
  await assert.rejects(()=>fixture({response:{status:'conflict',mark:row({revision:3,place_id:'old-place'})}}).remote.mutate(mutation()),error=>error.code==='conflict'&&error.current.revision===3&&error.current.placeId==='old-place');
  await assert.rejects(()=>fixture({response:{status:'conflict',mark:null}}).remote.mutate(mutation({expectedRevision:1})),error=>error.code==='conflict'&&error.current===null);
  await rejects(()=>fixture({response:{status:'conflict',mark:row({target_id:'activity:other'})}}).remote.mutate(mutation()),'invalid');
});
await check('list rejects malformed, duplicate, cross-trip and oversized results atomically',async()=>{
  for(const rows of [null,[row(),row()],[row({trip_id:'other-trip'})],[row({revision:Number.MAX_SAFE_INTEGER+1})],[row({target_id:'end:d1',state:'skipped'})],Array.from({length:MAX_TRAVEL_MARKS+1},()=>row())]){
    await rejects(()=>fixture({rows}).remote.list('legacy-trip'),'invalid');
  }
  await rejects(()=>fixture({rows:[row({owner_id:other})]}).remote.list('legacy-trip'),'auth');
});
await check('database and provider failures use fixed safe actionable categories',async()=>{
  for(const [code,expected]of [['42501','auth'],['PGRST301','auth'],['PGRST202','setup'],['42P01','setup'],['22023','invalid'],['23514','invalid'],['unknown','unavailable']]){
    await assert.rejects(()=>fixture({error:{code,message:'SECRET token and raw SQL',details:'SECRET'}}).remote.mutate(mutation()),error=>error.code===expected&&!error.message.includes('SECRET'));
  }
});
await check('flight progress is keyed by flight ID and permits planned done and skipped states',async()=>{
  for(const state of ['planned','done','skipped']) {
    const f=fixture({response:{status:'ok',mark:row({target_id:'flight:flight-one',place_id:'arrival-airport',state})}});
    const result=await f.remote.mutate(mutation({targetId:'flight:flight-one',placeId:'arrival-airport',state}));
    assert.equal(result.targetId,'flight:flight-one'); assert.equal(result.state,state);
  }
});
await check('flight list retains an independently revisioned arrival completion',async()=>{
  const f=fixture({rows:[row(),row({target_id:'flight:flight-one',place_id:'arrival-airport',revision:7})]});
  const result=await f.remote.list('legacy-trip'); assert.equal(result[1].revision,7); assert.equal(result[0].targetId,'activity:a1');
});
await check('collaborative travel progress uses the actor and global trip ID, independently of ownership',async()=>{
  const cloud='33333333-3333-4333-8333-333333333333',tripId='collab-'+cloud;
  const f=fixture({rows:[row({trip_id:tripId})],response:{status:'ok',mark:row({trip_id:tripId})}});
  assert.equal((await f.remote.list(tripId))[0].state,'done');
  assert.equal((await f.remote.mutate(mutation({tripId}))).state,'done');
  assert.deepEqual(f.calls[0],['daytrail_collab_list_travel_marks',{p_expected_actor_id:owner,p_cloud_trip_id:cloud}]);
  assert.equal(f.calls[1][0],'daytrail_collab_mutate_travel_mark');
  assert.equal(f.calls[1][1].p_expected_actor_id,owner);assert.equal(f.calls[1][1].p_cloud_trip_id,cloud);
  assert.equal('p_expected_owner_id' in f.calls[1][1],false);
});
await check('shared progress rejects another traveller and malformed shared identities',async()=>{
  const tripId='collab-33333333-3333-4333-8333-333333333333';
  await rejects(()=>fixture({rows:[row({trip_id:tripId,owner_id:other})]}).remote.list(tripId),'auth');
  const f=fixture();await rejects(()=>f.remote.list('collab-bad'),'invalid');assert.equal(f.calls.length,0);
});
console.log(`\n${checks} travel progress transport checks passed.`);
