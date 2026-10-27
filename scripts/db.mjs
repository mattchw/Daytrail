#!/usr/bin/env node
// Remote schema commands use the official CLI. No app key, stored trip, .env file,
// database password or service-role key is read by this runner.
import {readFile,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PROJECT_REF,sha256,queryRows,verifyLinkedProject,migrationFiles,migrationPlan,ensurePushReady} from './db-core.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.join(root,'node_modules','.bin',process.platform==='win32'?'supabase.cmd':'supabase');
const command=process.argv[2];
const allowed=['login','link','status','baseline','dry-run','migrate'];
if(!allowed.includes(command)||process.argv.length!==3){console.error('Usage: npm run db:login | db:link | db:status | db:baseline | db:dry-run | db:migrate');process.exit(1);}
function run(args,{interactive=false,json=false}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,[...args,'--workdir',root,...(json?['--output-format','json','--agent','yes']:[])],{cwd:root,stdio:interactive?'inherit':['ignore','pipe','pipe'],shell:false});
  let stdout='',stderr='',oversized=false;
  child.stdout?.on('data',chunk=>{stdout+=chunk;if(stdout.length>4*1024*1024){oversized=true;child.kill('SIGTERM');}});
  child.stderr?.on('data',chunk=>{stderr+=chunk;if(stderr.length>1024*1024){oversized=true;child.kill('SIGTERM');}});
  child.on('error',()=>reject(Error('Supabase CLI could not start. Run pnpm install, then retry.')));
  child.on('close',code=>{
   if(oversized)return reject(Error('Supabase output exceeded its expected size. No further action was taken.'));
   if(code!==0){
    const auth=/access token|not logged|unauthorized|login.*required|authentication.*required/i.test(stderr+stdout);
    return reject(Error(auth?'Supabase CLI needs an account login. Run npm run db:login, then npm run db:link.':`Supabase ${args.slice(0,2).join(' ')} did not complete (exit ${code??'signal'}). Check your CLI login and network, then retry. Raw connection details are not printed.`));
   }
   resolve(stdout);
  });
 });
}
const remote=['--linked','--project-ref',PROJECT_REF];
async function query(sqlArgs){return queryRows(await run(['db','query',...remote,...sqlArgs],{json:true}));}
async function inspect(){
 const linked=await readFile(path.join(root,'supabase/.temp/project-ref'),'utf8').catch(()=> '');verifyLinkedProject(linked);
 const local=await Promise.all(migrationFiles(await readdir(path.join(root,'supabase/migrations'))).map(async item=>({...item,sha256:sha256(await readFile(path.join(root,'supabase/migrations',item.file)))})));
 const baselineFiles=(await readdir(path.join(root,'supabase/baselines'))).filter(name=>/^\d+\.json$/.test(name)).sort();
 const baselines=await Promise.all(baselineFiles.map(async file=>JSON.parse(await readFile(path.join(root,'supabase/baselines',file),'utf8'))));
 const rows=await query(['--file',path.join(root,'scripts/db-catalog.sql')]);
 if(rows.length!==1||typeof rows[0].has_migration_history!=='boolean')throw Error('Supabase schema metadata could not be verified.');
 const history=rows[0].has_migration_history?(await query(['select version from supabase_migrations.schema_migrations order by version;'])).map(row=>row.version):[];
 return migrationPlan({catalog:rows[0].daytrail_catalog,history,local,baselines});
}
function show(plan){
 console.log(`Daytrail project: ${PROJECT_REF}`);
 console.log(`Recorded migrations: ${plan.history.length}. Pending SQL migrations: ${plan.pending.length}.`);
 if(plan.repair.length)console.log(`Verified manually applied migrations to record once: ${plan.repair.join(', ')}`);
 for(const item of plan.pending)console.log(`  Pending: ${item.file}`);
}
try{
 if(command==='login'){await run(['login'],{interactive:true});}
 else if(command==='link'){await run(['link','--project-ref',PROJECT_REF],{interactive:true});}
 else{
  let plan=await inspect();show(plan);
  if(command==='baseline'){
   if(!plan.repair.length)console.log('No baseline repair is needed.');
   else{
    // Only exact catalog matches reach this mutation; repair changes history only.
    await run(['migration','repair',...plan.repair,'--status','applied',...remote,'--yes']);
    plan=await inspect();ensurePushReady(plan);show(plan);console.log('Verified migration history recorded. Trip data was not changed.');
   }
  }else if(command==='dry-run'||command==='migrate'){
   ensurePushReady(plan);
   await run(['db','push',...remote,'--dry-run','--skip-vault','--yes']);
   console.log('Supabase migration dry run passed.');
   if(command==='migrate'){
    await run(['db','push',...remote,'--skip-vault','--yes']);
    const after=await inspect();ensurePushReady(after);
    if(after.pending.length)throw Error('Some migrations remain pending. Run npm run db:status before retrying.');
    console.log('Database migrations are up to date.');
   }
  }
 }
}catch(error){console.error(error instanceof Error?error.message:'Database command failed.');process.exitCode=1;}
