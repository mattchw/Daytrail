// An isolated PostgreSQL test runner. PGlite is a test-only dependency; it never
// reads Supabase configuration, database passwords, browser sessions or .env files.
// DAYTRAIL_PGLITE_MODULE may point to a temporary installation's dist/index.js.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import assert from 'node:assert/strict';
const catalogQuery=readFileSync(new URL('../../scripts/db-catalog.sql',import.meta.url),'utf8');
async function verifyCatalog(db,version) {
  const baseline=JSON.parse(readFileSync(new URL(`../baselines/${version}.json`,import.meta.url),'utf8'));
  const result=await db.query(catalogQuery);
  assert.deepEqual(result.rows[0].daytrail_catalog,baseline.catalog,`Schema verification fixture ${version} is stale`);
}

const moduleName = process.env.DAYTRAIL_PGLITE_MODULE;
const { PGlite } = await import(moduleName ? pathToFileURL(moduleName).href : '@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`);
  await db.exec(readFileSync(new URL('../migrations/202610260001_daytrail_cloud.sql',import.meta.url),'utf8'));
  await verifyCatalog(db,'202610260001');
  await db.exec(readFileSync(new URL('../migrations/202610270001_daytrail_travel.sql',import.meta.url),'utf8'));
  await verifyCatalog(db,'202610270001');
  const results = await db.exec(readFileSync(new URL('./daytrail_cloud.sql',import.meta.url),'utf8'));
  for (const result of results) if (result.rows?.[0]?.passed_checks !== undefined) console.log(`${result.rows[0].passed_checks} isolated PostgreSQL security and mutation checks passed.`);
  const travelResults = await db.exec(readFileSync(new URL('./daytrail_travel.sql',import.meta.url),'utf8'));
  for (const result of travelResults) if (result.rows?.[0]?.passed_travel_checks !== undefined) console.log(`${result.rows[0].passed_travel_checks} isolated PostgreSQL travel progress checks passed.`);

  await db.exec(readFileSync(new URL('../migrations/202610270002_daytrail_bookings.sql',import.meta.url),'utf8'));
  await verifyCatalog(db,'202610270002');
  const bookingResults = await db.exec(readFileSync(new URL('./daytrail_bookings.sql',import.meta.url),'utf8'));
  for (const result of bookingResults) if (result.rows?.[0]?.passed_booking_checks !== undefined) console.log(`${result.rows[0].passed_booking_checks} isolated PostgreSQL flight and stay checks passed.`);

  // Supabase-managed auth and Realtime surfaces used by the collaboration migration.
  await db.exec(`alter table auth.users add column email text;
    alter table auth.users add column email_confirmed_at timestamptz;
    alter table auth.users add column raw_user_meta_data jsonb not null default '{}'::jsonb;
    create schema realtime;
    create table realtime.messages(extension text,topic text,payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
    create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language plpgsql as $$begin insert into realtime.messages values('broadcast',topic,payload); end;$$;`);
  await db.exec(readFileSync(new URL('../migrations/202610270003_daytrail_collaboration.sql',import.meta.url),'utf8'));
  const collaborationResults = await db.exec(readFileSync(new URL('./daytrail_collaboration.sql',import.meta.url),'utf8'));
  for (const result of collaborationResults) if (result.rows?.[0]?.passed_collaboration_checks !== undefined) console.log(`${result.rows[0].passed_collaboration_checks} isolated PostgreSQL collaboration checks passed.`);

  await db.exec(readFileSync(new URL('../migrations/202610270004_daytrail_invitation_preview.sql',import.meta.url),'utf8'));
  const previewResults = await db.exec(readFileSync(new URL('./daytrail_invitation_preview.sql',import.meta.url),'utf8'));
  for (const result of previewResults) if (result.rows?.[0]?.passed_invitation_preview_checks !== undefined) console.log(`${result.rows[0].passed_invitation_preview_checks} isolated PostgreSQL invitation preview checks passed.`);

  await db.exec(readFileSync(new URL('../migrations/202610270005_daytrail_admission.sql',import.meta.url),'utf8'));
  const admissionResults = await db.exec(readFileSync(new URL('./daytrail_admission.sql',import.meta.url),'utf8'));
  for (const result of admissionResults) if (result.rows?.[0]?.passed_admission_checks !== undefined) console.log(`${result.rows[0].passed_admission_checks} isolated PostgreSQL admission cutoff checks passed.`);

  await db.exec(readFileSync(new URL('../migrations/202610270006_daytrail_pacing.sql',import.meta.url),'utf8'));
  const pacingResults=await db.exec(readFileSync(new URL('./daytrail_pacing.sql',import.meta.url),'utf8'));
  for(const result of pacingResults)if(result.rows?.[0]?.passed_pacing_checks!==undefined)console.log(`${result.rows[0].passed_pacing_checks} isolated PostgreSQL pacing and offline reference checks passed.`);

  const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const compile = file => ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'), {
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},
  }).outputText;
  const modelURL = dataURL(compile('../../src/model.ts'));
  const { seedTrip,createTrip } = await import(modelURL);
  const { canonicalTrip } = await import(dataURL(compile('../../src/tripBackup.ts').replace("from './model'",`from '${modelURL}'`)));
  const linked = seedTrip();
  linked.customPlaces.airport = {id:'airport',name:'Provider name',cat:'custom',x:5,y:7,area:'Provider address',typical:'',blurb:'',googlePlaceId:'g'.repeat(512),lat:35,lng:135,userLabel:'My airport',userNotes:'Meet at terminal 2'};
  linked.days[2].endPlaceId='airport';
  linked.days[0].items[0].note='日本語のメモ · Keep the ticket 🎟️';
  const booked=seedTrip();
  booked.flights=[{id:'flight1',fromPlaceId:'nijo',toPlaceId:'gion',departure:{date:'2027-05-14',time:'23:45',timezone:'Europe/London'},arrival:{date:'2027-05-15',time:'19:30',timezone:'Asia/Tokyo'},bookingReference:'Private reference',privateNotes:'Private flight notes',airportBufferMinutes:120,arrivalBufferMinutes:60}];
  booked.stays=[{id:'stay1',placeId:'hotel',checkInDate:'2027-05-14',checkOutDate:'2027-05-17',timezone:'Asia/Tokyo',checkInTime:'15:00',bookingUrl:'https://example.com/booking?id=private',contact:'Private contact'}];
  booked.days[0]={...booked.days[0],timezone:'Europe/London',endStayId:'stay1',items:[{aid:'departure1',placeId:'nijo',duration:5,fixed:null,mode:'transit',note:'',departureForFlightId:'flight1'},{aid:'flightarrival1',placeId:'gion',duration:0,fixed:null,mode:'flight',flightId:'flight1',note:''}]};
  const documents=[seedTrip(),createTrip('New trip','Paris','2028-02-28',3),linked,booked];
  const admission=structuredClone(linked); admission.customPlaces.airport.lastEntryMinutes={0:0,1:990,6:1439};documents.push(admission);
  const paced=structuredClone(admission);paced.pace='moderate';paced.days[0].pace='active';Object.assign(paced.days[0].items[0],{meal:'snack',walkingMeters:1500,exposure:'mixed'});paced.customPlaces.airport.offlineDetails={name:'My airport',address:'Traveller-entered address',localAddress:'日本語',hours:'See ticket'};documents.push(paced);
  for (const source of documents) {
    const document=canonicalTrip(source);
    const result=await db.query('select daytrail_private.valid_document($1::jsonb,$2::text) as valid',[JSON.stringify(document),document.id]);
    if(result.rows[0]?.valid!==true)throw Error('Database rejected an app-generated canonical trip.');
  }
  console.log(`${documents.length} app-to-database canonical document checks passed.`);
  console.log('3 migration baseline catalog parity checks passed.');
} catch(error) {
  // Tests contain only synthetic values. Keep diagnostics bounded and omit SQL payloads.
  console.error({message:error.message,code:error.code,position:error.position,where:error.where});
  process.exitCode=1;
} finally {await db.close();}
