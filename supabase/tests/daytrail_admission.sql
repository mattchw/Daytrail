begin;
create temporary table daytrail_admission_checks(label text primary key);
grant select,insert on daytrail_admission_checks to anon,authenticated;
create or replace function pg_temp.check_admission(label text,actual boolean) returns void language plpgsql as $$
begin if actual is distinct from true then raise exception 'Failed: %',label; end if; insert into daytrail_admission_checks values(label); end; $$;
create or replace function pg_temp.admission_error(label text,statement text,expected_state text) returns void language plpgsql as $$
begin begin execute statement; exception when others then if sqlstate<>expected_state then raise exception 'Failed: % (expected %, got %)',label,expected_state,sqlstate; end if; insert into daytrail_admission_checks values(label); return; end; raise exception 'Failed: % (unexpected success)',label; end; $$;
create or replace function pg_temp.admission_actor(n integer) returns uuid language sql as $$select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create or replace function pg_temp.admission_mid(n integer) returns uuid language sql as $$select ('61000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create or replace function pg_temp.admission_doc() returns jsonb language sql as $$
select '{"id":"admission","name":"Hours test","destination":"London","startDate":"2026-10-27","timezone":"Europe/London","ideas":[],"customPlaces":{"museum":{"id":"museum","name":"Museum","cat":"attr","x":50,"y":50,"area":"","typical":"","blurb":"","lastEntryMinutes":{"0":0,"1":990,"6":1439}}},"days":[{"id":"day1","label":"Day 1","date":"Tue 27","title":"Visit","endMode":"walk","items":[{"aid":"visit","placeId":"museum","duration":60,"fixed":null,"mode":"walk","note":""}]}]}'::jsonb;
$$;
select pg_temp.check_admission('schema 2 accepts confirmed admission cutoffs',daytrail_private.valid_document(pg_temp.admission_doc(),'admission'));
select pg_temp.check_admission('version dispatcher accepts confirmed admission cutoffs',daytrail_private.valid_document_version(pg_temp.admission_doc(),'admission',2));
select pg_temp.check_admission('legacy schema 1 remains strict',not daytrail_private.valid_document_version(pg_temp.admission_doc(),'admission',1));
select pg_temp.check_admission('legacy schema 1 still accepts unchanged documents',daytrail_private.valid_document_version(pg_temp.admission_doc()#-'{customPlaces,museum,lastEntryMinutes}','admission',1));
select pg_temp.check_admission('old schema 2 still accepts unchanged documents',daytrail_private.valid_document_version(pg_temp.admission_doc()#-'{customPlaces,museum,lastEntryMinutes}','admission',2));
select pg_temp.check_admission('empty optional cutoff object is allowed',daytrail_private.valid_document(jsonb_set(pg_temp.admission_doc(),'{customPlaces,museum,lastEntryMinutes}','{}'),'admission'));
do $$declare invalid jsonb; i integer:=0; begin
  for invalid in select value from jsonb_array_elements('[null,[],3,true,"16:30",{"7":900},{"-1":900},{"01":900},{"Monday":900},{"1":-1},{"1":1440},{"1":900.5},{"1":"990"},{"1":null},{"1":true},{"1":{}},{"__proto__":900}]'::jsonb) loop
    i:=i+1;
    perform pg_temp.check_admission('malformed cutoff rejected '||i,not daytrail_private.valid_document(jsonb_set(pg_temp.admission_doc(),'{customPlaces,museum,lastEntryMinutes}',invalid),'admission'));
  end loop;
end $$;
select pg_temp.check_admission('unknown place fields remain invalid',not daytrail_private.valid_document(jsonb_set(pg_temp.admission_doc(),'{customPlaces,museum,unrecognized}','true'),'admission'));
select pg_temp.check_admission('invalid place shape remains invalid',not daytrail_private.valid_document(jsonb_set(pg_temp.admission_doc(),'{customPlaces,museum}','[]'),'admission'));
select pg_temp.check_admission('new validator is not executable by clients',not has_function_privilege('authenticated','daytrail_private.valid_document(jsonb,text)','execute'));
select pg_temp.check_admission('renamed validator is not executable by clients',not has_function_privilege('authenticated','daytrail_private.valid_document_v2(jsonb,text)','execute'));
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
(pg_temp.admission_actor(1),'hours-owner@example.com',now(),'{}'),
(pg_temp.admission_actor(2),'hours-editor@example.com',now(),'{}'),
(pg_temp.admission_actor(3),'hours-viewer@example.com',now(),'{}');
create temporary table admission_fixture(key text primary key,value jsonb);
grant select,insert,update on admission_fixture to authenticated;
create or replace function pg_temp.admission_cloud() returns uuid language sql as $$select (value->>'cloud_trip_id')::uuid from admission_fixture where key='enabled';$$;
create or replace function pg_temp.admission_current() returns jsonb language sql as $$select public.daytrail_collab_get(auth.uid(),pg_temp.admission_cloud())->'document';$$;
select set_config('request.jwt.claim.sub',pg_temp.admission_actor(1)::text,true);
set local role authenticated;
select pg_temp.check_admission('private cloud create accepts cutoff metadata',public.daytrail_mutate_trip(pg_temp.admission_actor(1),'admission',0,pg_temp.admission_mid(1),'create',pg_temp.admission_doc(),2)->>'status'='ok');
select pg_temp.check_admission('table check preserves cutoff metadata',(select document#>'{customPlaces,museum,lastEntryMinutes}'='{"0":0,"1":990,"6":1439}'::jsonb from public.daytrail_trips where trip_id='admission'));
select pg_temp.admission_error('private cloud rejects malformed cutoff',$$select public.daytrail_mutate_trip(pg_temp.admission_actor(1),'admission',1,pg_temp.admission_mid(2),'save',jsonb_set(pg_temp.admission_doc(),'{customPlaces,museum,lastEntryMinutes,1}','1440'),2)$$,'22023');
insert into admission_fixture values('enabled',public.daytrail_collab_enable(pg_temp.admission_actor(1),'admission',1)->'trip');
select pg_temp.check_admission('sharing retains confirmed cutoff',pg_temp.admission_current()#>'{customPlaces,museum,lastEntryMinutes,1}'='990'::jsonb);
insert into admission_fixture values('editor_invite',public.daytrail_collab_invite(pg_temp.admission_actor(1),pg_temp.admission_cloud(),'hours-editor@example.com','editor'));
insert into admission_fixture values('viewer_invite',public.daytrail_collab_invite(pg_temp.admission_actor(1),pg_temp.admission_cloud(),'hours-viewer@example.com','viewer'));
select set_config('request.jwt.claim.sub',pg_temp.admission_actor(2)::text,true);
select public.daytrail_collab_accept(pg_temp.admission_actor(2),(select value->>'token' from admission_fixture where key='editor_invite'));
select pg_temp.check_admission('editor reads confirmed cutoff',pg_temp.admission_current()#>'{customPlaces,museum,lastEntryMinutes,1}'='990'::jsonb);
select pg_temp.check_admission('editor can update confirmed cutoff',public.daytrail_collab_mutate(pg_temp.admission_actor(2),pg_temp.admission_cloud(),2,pg_temp.admission_mid(3),'save',jsonb_set(pg_temp.admission_current(),'{customPlaces,museum,lastEntryMinutes,1}','975'))->'trip'->'document'#>'{customPlaces,museum,lastEntryMinutes,1}'='975'::jsonb);
select pg_temp.admission_error('shared save rejects malformed weekday',$$select public.daytrail_collab_mutate(pg_temp.admission_actor(2),pg_temp.admission_cloud(),3,pg_temp.admission_mid(4),'save',jsonb_set(pg_temp.admission_current(),'{customPlaces,museum,lastEntryMinutes,9}','975'))$$,'22023');
select set_config('request.jwt.claim.sub',pg_temp.admission_actor(3)::text,true);
select public.daytrail_collab_accept(pg_temp.admission_actor(3),(select value->>'token' from admission_fixture where key='viewer_invite'));
select pg_temp.check_admission('viewer sees latest cutoff',pg_temp.admission_current()#>'{customPlaces,museum,lastEntryMinutes,1}'='975'::jsonb);
select pg_temp.admission_error('viewer cannot change cutoff',$$select public.daytrail_collab_mutate(pg_temp.admission_actor(3),pg_temp.admission_cloud(),3,pg_temp.admission_mid(5),'save',jsonb_set(pg_temp.admission_current(),'{customPlaces,museum,lastEntryMinutes,1}','900'))$$,'42501');
reset role;
select count(*) as passed_admission_checks from daytrail_admission_checks;
rollback;
