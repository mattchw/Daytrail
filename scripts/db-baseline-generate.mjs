// Maintainer-only: rebuild metadata fixtures in an isolated PostgreSQL instance.
// Never loads the app environment or contacts a remote project.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const moduleName=process.env.DAYTRAIL_PGLITE_MODULE;
const {PGlite}=await import(moduleName?pathToFileURL(moduleName).href:'@electric-sql/pglite');
const db=new PGlite();
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 const files=(await readdir(path.join(root,'supabase/migrations'))).filter(name=>/^202610(?:260001|270001|270002)_.*\.sql$/.test(name)).sort();
 const query=await readFile(path.join(root,'scripts/db-catalog.sql'),'utf8'), migrations=[];
 for(const file of files){
  const sql=await readFile(path.join(root,'supabase/migrations',file),'utf8');await db.exec(sql);
  migrations.push({version:file.split('_')[0],file,sha256:createHash('sha256').update(sql).digest('hex')});
  const result=await db.query(query);
  await writeFile(path.join(root,'supabase/baselines',file.split('_')[0]+'.json'),JSON.stringify({migrations:[...migrations],catalog:result.rows[0].daytrail_catalog},null,2)+'\n');
 }
 console.log(`Generated ${files.length} isolated schema verification fixtures.`);
}finally{await db.close();}
