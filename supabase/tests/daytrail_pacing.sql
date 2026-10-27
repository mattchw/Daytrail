begin;
create temporary table daytrail_pacing_checks(label text primary key);
grant select,insert on daytrail_pacing_checks to anon,authenticated;
create or replace function pg_temp.check_pacing(label text,actual boolean) returns void language plpgsql as $$
begin if actual is distinct from true then raise exception 'Failed: %',label; end if; insert into daytrail_pacing_checks values(label); end; $$;
create or replace function pg_temp.pacing_error(label text,statement text,expected_state text) returns void language plpgsql as $$
begin begin execute statement; exception when others then if sqlstate<>expected_state then raise exception 'Failed: % (expected %, got %)',label,expected_state,sqlstate; end if; insert into daytrail_pacing_checks values(label); return; end; raise exception 'Failed: % (unexpected success)',label; end; $$;
create or replace function pg_temp.pacing_actor(n integer) returns uuid language sql as $$select ('70000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create or replace function pg_temp.pacing_mid(n integer) returns uuid language sql as $$select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create or replace function pg_temp.pacing_doc() returns jsonb language sql as $$
select '{"id":"pacing","name":"Hours test","destination":"London","startDate":"2026-10-27","timezone":"Europe/London","pace":"moderate","ideas":[],"customPlaces":{"museum":{"id":"museum","name":"Museum","cat":"attr","x":50,"y":50,"area":"","typical":"","blurb":"","offlineDetails":{"name":"My museum","address":"123 Example Road","localAddress":"日本語の住所","hours":"Check ticket"},"lastEntryMinutes":{"0":0,"1":990,"6":1439}}},"days":[{"id":"day1","label":"Day 1","date":"Tue 27","title":"Visit","pace":"active","endMode":"walk","items":[{"aid":"visit","placeId":"museum","duration":60,"fixed":null,"mode":"walk","note":"","meal":"snack","walkingMeters":1500,"exposure":"mixed"}]}]}'::jsonb;
$$;
select pg_temp.check_pacing('schema 2 accepts confirmed pacing cutoffs',daytrail_private.valid_document(pg_temp.pacing_doc(),'pacing'));
select pg_temp.check_pacing('version dispatcher accepts confirmed pacing cutoffs',daytrail_private.valid_document_version(pg_temp.pacing_doc(),'pacing',2));
select pg_temp.check_pacing('legacy schema 1 remains strict',not daytrail_private.valid_document_version(pg_temp.pacing_doc(),'pacing',1));

select pg_temp.check_pacing('old schema 2 still accepts unchanged documents',daytrail_private.valid_document_version(pg_temp.pacing_doc()#-'{customPlaces,museum,lastEntryMinutes}','pacing',2));
select pg_temp.check_pacing('empty optional cutoff object is allowed',daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),'{customPlaces,museum,lastEntryMinutes}','{}'),'pacing'));
do $$declare invalid jsonb; i integer:=0; begin
  for invalid in select value from jsonb_array_elements('[null,[],3,true,"16:30",{"7":900},{"-1":900},{"01":900},{"Monday":900},{"1":-1},{"1":1440},{"1":900.5},{"1":"990"},{"1":null},{"1":true},{"1":{}},{"__proto__":900}]'::jsonb) loop
    i:=i+1;
    perform pg_temp.check_pacing('malformed cutoff rejected '||i,not daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),'{customPlaces,museum,lastEntryMinutes}',invalid),'pacing'));
  end loop;
end $$;
select pg_temp.check_pacing('unknown place fields remain invalid',not daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),'{customPlaces,museum,unrecognized}','true'),'pacing'));
select pg_temp.check_pacing('invalid place shape remains invalid',not daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),'{customPlaces,museum}','[]'),'pacing'));
select pg_temp.check_pacing('new validator is not executable by clients',not has_function_privilege('authenticated','daytrail_private.valid_document(jsonb,text)','execute'));
select pg_temp.check_pacing('renamed validator is not executable by clients',not has_function_privilege('authenticated','daytrail_private.valid_document_v2(jsonb,text)','execute'));
do $$declare entry jsonb; i integer:=0; begin
 for entry in select value from jsonb_array_elements('[
 {"path":["pace"],"value":"fast"},{"path":["pace"],"value":null},{"path":["pace"],"value":8},
 {"path":["days","0","pace"],"value":"fast"},{"path":["days","0","pace"],"value":null},
 {"path":["days","0","items","0","meal"],"value":"breakfast"},{"path":["days","0","items","0","meal"],"value":false},
 {"path":["days","0","items","0","walkingMeters"],"value":-1},{"path":["days","0","items","0","walkingMeters"],"value":100001},{"path":["days","0","items","0","walkingMeters"],"value":0.5},{"path":["days","0","items","0","walkingMeters"],"value":"100"},
 {"path":["days","0","items","0","exposure"],"value":"rainproof"},{"path":["days","0","items","0","exposure"],"value":null},
 {"path":["customPlaces","museum","offlineDetails"],"value":{}},{"path":["customPlaces","museum","offlineDetails"],"value":null},{"path":["customPlaces","museum","offlineDetails"],"value":{"name":"x","secret":"bad"}},
 {"path":["customPlaces","museum","offlineDetails","name"],"value":""},{"path":["customPlaces","museum","offlineDetails","address"],"value":false},{"path":["customPlaces","museum","offlineDetails","hours"],"value":[]}
 ]'::jsonb) loop
  i:=i+1;perform pg_temp.check_pacing('malformed comfort metadata '||i,not daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),array(select jsonb_array_elements_text(entry->'path')),entry->'value'),'pacing'));
 end loop;
end $$;
select pg_temp.check_pacing('oversized authored name rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),'{customPlaces,museum,offlineDetails,name}',to_jsonb(repeat('x',201))),'pacing'));
select pg_temp.check_pacing('zero walking is an explicit valid estimate',daytrail_private.valid_document(jsonb_set(pg_temp.pacing_doc(),'{days,0,items,0,walkingMeters}','0'),'pacing'));
select pg_temp.check_pacing('renamed pacing predecessor is not client executable',not has_function_privilege('authenticated','daytrail_private.valid_document_v3(jsonb,text)','execute'));
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
(pg_temp.pacing_actor(1),'hours-owner@example.com',now(),'{}'),
(pg_temp.pacing_actor(2),'hours-editor@example.com',now(),'{}'),
(pg_temp.pacing_actor(3),'hours-viewer@example.com',now(),'{}');
create temporary table pacing_fixture(key text primary key,value jsonb);
grant select,insert,update on pacing_fixture to authenticated;
create or replace function pg_temp.pacing_cloud() returns uuid language sql as $$select (value->>'cloud_trip_id')::uuid from pacing_fixture where key='enabled';$$;
create or replace function pg_temp.pacing_current() returns jsonb language sql as $$select public.daytrail_collab_get(auth.uid(),pg_temp.pacing_cloud())->'document';$$;
select set_config('request.jwt.claim.sub',pg_temp.pacing_actor(1)::text,true);
set local role authenticated;
select pg_temp.check_pacing('private cloud create accepts cutoff metadata',public.daytrail_mutate_trip(pg_temp.pacing_actor(1),'pacing',0,pg_temp.pacing_mid(1),'create',pg_temp.pacing_doc(),2)->>'status'='ok');
select pg_temp.check_pacing('table check preserves authored offline details',(select document#>'{customPlaces,museum,offlineDetails,name}'='"My museum"'::jsonb from public.daytrail_trips where trip_id='pacing'));
select pg_temp.check_pacing('table check preserves cutoff metadata',(select document#>'{customPlaces,museum,lastEntryMinutes}'='{"0":0,"1":990,"6":1439}'::jsonb from public.daytrail_trips where trip_id='pacing'));
select pg_temp.pacing_error('private cloud rejects malformed cutoff',$$select public.daytrail_mutate_trip(pg_temp.pacing_actor(1),'pacing',1,pg_temp.pacing_mid(2),'save',jsonb_set(pg_temp.pacing_doc(),'{customPlaces,museum,lastEntryMinutes,1}','1440'),2)$$,'22023');
insert into pacing_fixture values('enabled',public.daytrail_collab_enable(pg_temp.pacing_actor(1),'pacing',1)->'trip');
select pg_temp.check_pacing('sharing retains confirmed cutoff',pg_temp.pacing_current()#>'{customPlaces,museum,lastEntryMinutes,1}'='990'::jsonb);
insert into pacing_fixture values('editor_invite',public.daytrail_collab_invite(pg_temp.pacing_actor(1),pg_temp.pacing_cloud(),'hours-editor@example.com','editor'));
insert into pacing_fixture values('viewer_invite',public.daytrail_collab_invite(pg_temp.pacing_actor(1),pg_temp.pacing_cloud(),'hours-viewer@example.com','viewer'));
select set_config('request.jwt.claim.sub',pg_temp.pacing_actor(2)::text,true);
select public.daytrail_collab_accept(pg_temp.pacing_actor(2),(select value->>'token' from pacing_fixture where key='editor_invite'));
select pg_temp.check_pacing('editor reads confirmed cutoff',pg_temp.pacing_current()#>'{customPlaces,museum,lastEntryMinutes,1}'='990'::jsonb);
select pg_temp.check_pacing('editor can update confirmed cutoff',public.daytrail_collab_mutate(pg_temp.pacing_actor(2),pg_temp.pacing_cloud(),2,pg_temp.pacing_mid(3),'save',jsonb_set(pg_temp.pacing_current(),'{customPlaces,museum,lastEntryMinutes,1}','975'))->'trip'->'document'#>'{customPlaces,museum,lastEntryMinutes,1}'='975'::jsonb);
select pg_temp.pacing_error('shared save rejects malformed weekday',$$select public.daytrail_collab_mutate(pg_temp.pacing_actor(2),pg_temp.pacing_cloud(),3,pg_temp.pacing_mid(4),'save',jsonb_set(pg_temp.pacing_current(),'{customPlaces,museum,lastEntryMinutes,9}','975'))$$,'22023');
select set_config('request.jwt.claim.sub',pg_temp.pacing_actor(3)::text,true);
select public.daytrail_collab_accept(pg_temp.pacing_actor(3),(select value->>'token' from pacing_fixture where key='viewer_invite'));
select pg_temp.check_pacing('viewer sees latest cutoff',pg_temp.pacing_current()#>'{customPlaces,museum,lastEntryMinutes,1}'='975'::jsonb);
select pg_temp.pacing_error('viewer cannot change cutoff',$$select public.daytrail_collab_mutate(pg_temp.pacing_actor(3),pg_temp.pacing_cloud(),3,pg_temp.pacing_mid(5),'save',jsonb_set(pg_temp.pacing_current(),'{customPlaces,museum,lastEntryMinutes,1}','900'))$$,'42501');
reset role;
select count(*) as passed_pacing_checks from daytrail_pacing_checks;
rollback;
