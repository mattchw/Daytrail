import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PROJECT_REF,BASELINE_VERSIONS,sha256,queryRows,verifyLinkedProject,migrationFiles,migrationPlan,ensurePushReady} from './db-core.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baselines=await Promise.all(BASELINE_VERSIONS.map(async version=>JSON.parse(await readFile(path.join(root,'supabase/baselines',version+'.json'),'utf8'))));
const local=await Promise.all(migrationFiles(await readdir(path.join(root,'supabase/migrations'))).map(async file=>({...file,sha256:sha256(await readFile(path.join(root,'supabase/migrations',file.file)))})));
const historical=local.filter(item=>BASELINE_VERSIONS.includes(item.version));
const plan=(catalog,history=[],extras={})=>migrationPlan({catalog,history,local:historical,baselines,...extras});
const clone=value=>structuredClone(value);
let checks=0;function check(name,run){run();checks++;console.log(`✓ ${name}`);}
check('all manual migrations are recognized without marking them pending SQL',()=>{
 const result=plan(baselines[2].catalog);assert.deepEqual(result.repair,BASELINE_VERSIONS);assert.deepEqual(result.pending,[]);assert.throws(()=>ensurePushReady(result),/db:baseline/);
});
check('only the verified applied prefix can be baselined',()=>{
 const result=plan(baselines[1].catalog);assert.deepEqual(result.repair,BASELINE_VERSIONS.slice(0,2));assert.deepEqual(result.pending.map(file=>file.version),[BASELINE_VERSIONS[2]]);
});
check('properly recorded first two migrations allow only the new booking migration',()=>{
 const result=plan(baselines[1].catalog,BASELINE_VERSIONS.slice(0,2));assert.deepEqual(result.repair,[]);assert.equal(result.pending.length,1);assert.doesNotThrow(()=>ensurePushReady(result));
});
check('a fully recorded schema results in a no-op migration',()=>{
 const result=plan(baselines[2].catalog,BASELINE_VERSIONS);assert.deepEqual(result.pending,[]);assert.deepEqual(result.repair,[]);assert.doesNotThrow(()=>ensurePushReady(result));
});
check('an empty Daytrail schema permits a fresh migration without history repair',()=>{
 const result=plan({tables:[],functions:[]});assert.deepEqual(result.repair,[]);assert.deepEqual(result.pending.map(file=>file.version),BASELINE_VERSIONS);
});
check('tampered security function source blocks blind baseline repair',()=>{
 const catalog=clone(baselines[2].catalog);catalog.functions[0].sourceHash='unexpected';assert.throws(()=>plan(catalog),/does not match/);
});
check('missing RLS or a changed client grant blocks baseline repair',()=>{
 for(const mutate of [catalog=>catalog.tables[0].rowSecurity=false,catalog=>catalog.tables[0].grants.push({role:'anon',privilege:'SELECT',grantable:false})]){const catalog=clone(baselines[2].catalog);mutate(catalog);assert.throws(()=>plan(catalog),/does not match/);}
});
check('a nullable required column still blocks baseline repair across PostgreSQL versions',()=>{
 const catalog=clone(baselines[2].catalog);catalog.tables[0].columns[0].notNull=false;assert.throws(()=>plan(catalog),/does not match/);
});
check('unknown schema objects fail closed during manual migration adoption',()=>{
 const catalog=clone(baselines[2].catalog);catalog.functions.push({name:'daytrail_unknown'});assert.throws(()=>plan(catalog),/does not match/);
});
check('history cannot claim unapplied schema versions',()=>{
 assert.throws(()=>plan(baselines[0].catalog,BASELINE_VERSIONS),/newer schema/);
 assert.throws(()=>plan({tables:[],functions:[]},[BASELINE_VERSIONS[0]]),/newer schema/);
});
check('remote history unknown to the checkout blocks push and repair',()=>{
 assert.throws(()=>plan(baselines[2].catalog,[...BASELINE_VERSIONS,'202610280001']),/absent from this checkout/);
});
check('changing any already-established migration file blocks baseline and push',()=>{
 const changed=clone(local);changed[0].sha256='different';assert.throws(()=>plan(baselines[2].catalog,[],{local:changed}),/add a new migration/);
});
check('a new version after the established baseline remains pending normally',()=>{
 const newer={version:'20261028120000',file:'20261028120000_new_feature.sql',sha256:'new'};
 const result=plan(baselines[2].catalog,BASELINE_VERSIONS,{local:[...historical,newer]});assert.deepEqual(result.pending,[newer]);assert.doesNotThrow(()=>ensurePushReady(result));
});
check('new checked-in migrations remain pending after the historical baseline',()=>{
 const result=plan(baselines[2].catalog,BASELINE_VERSIONS,{local});
 assert.deepEqual(result.pending,local.filter(item=>!BASELINE_VERSIONS.includes(item.version)));assert.doesNotThrow(()=>ensurePushReady(result));
});
check('invalid and duplicate migration names are rejected before connecting',()=>{
 assert.throws(()=>migrationFiles(['bad.sql']),/filename/);assert.throws(()=>migrationFiles(['202610270001_one.sql','202610270001_two.sql']),/unique/);
});
check('a different linked project cannot be migrated through Daytrail commands',()=>{
 assert.doesNotThrow(()=>verifyLinkedProject(PROJECT_REF+'\n'));assert.throws(()=>verifyLinkedProject('another-project'),/not linked/);assert.throws(()=>verifyLinkedProject(''),/db:link/);
});
check('query JSON parser handles CLI row envelopes and rejects unstructured output',()=>{
 for(const value of [[{x:1}],{rows:[{x:1}]},{data:{rows:[{x:1}]}},{result:{rows:[{x:1}]}}])assert.deepEqual(queryRows(JSON.stringify(value)),[{x:1}]);
 assert.throws(()=>queryRows('Login required'),/unreadable/);assert.throws(()=>queryRows('{"success":true}'),/unexpected/);
});
console.log(`${checks} migration runner checks passed.`);
