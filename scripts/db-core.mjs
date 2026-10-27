import {createHash} from 'node:crypto';
export const PROJECT_REF='ebplrpfthmessyafjjec';
export const BASELINE_VERSIONS=['202610260001','202610270001','202610270002'];
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value);

export function queryRows(text){
 let value;try{value=JSON.parse(text);}catch{throw Error('Supabase returned an unreadable query result. No migration was run.');}
 const rows=Array.isArray(value)?value:value?.rows??value?.data?.rows??value?.result?.rows;
 if(!Array.isArray(rows))throw Error('Supabase returned an unexpected query result. No migration was run.');
 return rows;
}
export function verifyLinkedProject(linked){
 if(linked.trim()!==PROJECT_REF)throw Error(`This checkout is not linked to Daytrail (${PROJECT_REF}). Run npm run db:link before migrating.`);
}
export function migrationFiles(files){
 const items=files.filter(name=>name.endsWith('.sql')).map(file=>{
  const match=/^(\d{12,14})_([a-zA-Z0-9_-]+)\.sql$/.exec(file);
  if(!match)throw Error(`Invalid migration filename: ${file}`);
  return {version:match[1],file};
 }).sort((a,b)=>a.version.localeCompare(b.version));
 if(new Set(items.map(item=>item.version)).size!==items.length)throw Error('Migration versions must be unique.');
 return items;
}
export function validateBaselines(baselines,local){
 const localByVersion=new Map(local.map(item=>[item.version,item]));
 for(const baseline of baselines){
  if(!Array.isArray(baseline.migrations)||!baseline.catalog)throw Error('Schema verification fixture is invalid.');
  for(const file of baseline.migrations){
   const current=localByVersion.get(file.version);
   if(!current||current.file!==file.file||current.sha256!==file.sha256)throw Error(`Previously applied migration ${file.version} changed. Restore it and add a new migration instead.`);
  }
 }
}
/** Recognize only complete catalog states created by the three known manual migrations. */
export function migrationPlan({catalog,history,local,baselines}){
 validateBaselines(baselines,local);
 if(!catalog||!Array.isArray(catalog.tables)||!Array.isArray(catalog.functions))throw Error('Schema metadata could not be verified.');
 if(!Array.isArray(history)||history.some(version=>typeof version!=='string'||!/^\d{12,14}$/.test(version))||new Set(history).size!==history.length)throw Error('Migration history could not be verified.');
 const localIds=local.map(item=>item.version),remote=new Set(history);
 if(history.some(version=>!localIds.includes(version)))throw Error('The remote database contains migrations absent from this checkout. Pull the complete migration history before continuing.');
 const matched=baselines.find(baseline=>stable(baseline.catalog)===stable(catalog));
 const empty=!catalog.tables.length&&!catalog.functions.length;
 const confirmed=matched?.migrations.map(item=>item.version)??(empty?[]:null);
 if(confirmed&&history.some(version=>BASELINE_VERSIONS.includes(version)&&!confirmed.includes(version)))throw Error('Migration history claims a newer schema than the verified database. No changes were made.');
 const missingBaseline=BASELINE_VERSIONS.filter(version=>localIds.includes(version)&&!remote.has(version));
 if(!confirmed&&missingBaseline.length)throw Error('Existing Daytrail schema does not match a verified migration state. Baseline repair and migration are blocked for review.');
 const repair=(confirmed??[]).filter(version=>!remote.has(version));
 return {confirmed,repair,pending:local.filter(item=>!remote.has(item.version)&&!repair.includes(item.version)),history:[...history]};
}
export function ensurePushReady(plan){
 if(plan.repair.length)throw Error(`These migrations already exist in the database but are missing from its history: ${plan.repair.join(', ')}. Run npm run db:baseline once, then retry.`);
}
