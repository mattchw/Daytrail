begin;
create temporary table daytrail_free_checks(label text primary key);
grant select,insert on daytrail_free_checks to anon,authenticated;
create function pg_temp.check_free(label text,actual boolean) returns void language plpgsql as $$
begin if actual is distinct from true then raise exception 'Failed: %',label; end if; insert into daytrail_free_checks values(label); end; $$;
create function pg_temp.free_error(label text,statement text,expected_state text) returns void language plpgsql as $$
begin begin execute statement; exception when others then if sqlstate<>expected_state then raise exception 'Failed: % (expected %, got %)',label,expected_state,sqlstate; end if; insert into daytrail_free_checks values(label); return; end; raise exception 'Failed: % (unexpected success)',label; end; $$;
create function pg_temp.free_actor(n integer) returns uuid language sql as $$select ('80000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.free_mid(n integer) returns uuid language sql as $$select ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.free_doc() returns jsonb language sql as $$
 select '{"id":"free-test","name":"Free time test","destination":"London","startDate":"2026-10-27","timezone":"Europe/London","ideas":[],"customPlaces":{},"days":[{"id":"day1","label":"Day 1","date":"Tue 27","title":"Visit","endMode":"walk","items":[{"aid":"visit","placeId":"nijo","duration":60,"fixed":null,"mode":"walk","note":"","freeTime":{"id":"free1","kind":"explore","duration":60,"untilBooking":true}}]}]}'::jsonb;
$$;
select pg_temp.check_free('free time is accepted in schema 2',daytrail_private.valid_document_version(pg_temp.free_doc(),'free-test',2));
select pg_temp.check_free('schema 1 cannot hide free time',not daytrail_private.valid_document_version(pg_temp.free_doc(),'free-test',1));
select pg_temp.check_free('legacy documents remain valid',daytrail_private.valid_document(pg_temp.free_doc()#-'{days,0,items,0,freeTime}','free-test'));
select pg_temp.check_free('new validator is private',not has_function_privilege('authenticated','daytrail_private.valid_document(jsonb,text)','execute'));
select pg_temp.check_free('old validator is private',not has_function_privilege('authenticated','daytrail_private.valid_document_v4(jsonb,text)','execute'));
do $$ declare f jsonb; i integer:=0; begin
 for f in select value from jsonb_array_elements('[null,{},[],true,5,"free",{"id":"free1","kind":"explore","duration":60},{"id":1,"kind":"explore","duration":60,"untilBooking":false},{"id":"free:1","kind":"explore","duration":60,"untilBooking":false},{"id":"__proto__","kind":"explore","duration":60,"untilBooking":false},{"id":"free1","kind":"unknown","duration":60,"untilBooking":false},{"id":"free1","kind":"explore","duration":0,"untilBooking":false},{"id":"free1","kind":"explore","duration":16,"untilBooking":false},{"id":"free1","kind":"explore","duration":735,"untilBooking":false},{"id":"free1","kind":"explore","duration":"60","untilBooking":false},{"id":"free1","kind":"explore","duration":60,"untilBooking":1},{"id":"free1","kind":"explore","duration":60,"untilBooking":null},{"id":"free1","kind":"explore","duration":60,"untilBooking":false,"private":"extra"}]'::jsonb) loop
  i:=i+1;perform pg_temp.check_free('malformed free time rejected '||i,not daytrail_private.valid_document(jsonb_set(pg_temp.free_doc(),'{days,0,items,0,freeTime}',f),'free-test'));
 end loop;
 for f in select value from jsonb_array_elements('[{"id":"a","kind":"rest","duration":30,"untilBooking":true},{"id":"b","kind":"shopping","duration":15,"untilBooking":false},{"id":"c","kind":"nothing","duration":720,"untilBooking":false}]'::jsonb) loop
  perform pg_temp.check_free('valid kind '||(f->>'kind'),daytrail_private.valid_document(jsonb_set(pg_temp.free_doc(),'{days,0,items,0,freeTime}',f),'free-test'));
 end loop;
end $$;
select pg_temp.check_free('duplicate block identities rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.free_doc(),'{days,0,items}',(pg_temp.free_doc()#>'{days,0,items}')||jsonb_build_array(jsonb_set(pg_temp.free_doc()#>'{days,0,items,0}','{aid}','"visit2"'))),'free-test'));
select pg_temp.check_free('free progress target valid',daytrail_private.valid_travel_target('free:free1'));
select pg_temp.check_free('malformed progress target rejected',not daytrail_private.valid_travel_target('free:free:1'));
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
(pg_temp.free_actor(1),'free-owner@example.com',now(),'{}'),(pg_temp.free_actor(2),'free-editor@example.com',now(),'{}'),(pg_temp.free_actor(3),'free-viewer@example.com',now(),'{}');
create temporary table free_fixture(key text primary key,value jsonb);
grant select,insert,update on free_fixture to authenticated;
create function pg_temp.free_cloud() returns uuid language sql as $$select (value->>'cloud_trip_id')::uuid from free_fixture where key='enabled';$$;
create function pg_temp.free_current() returns jsonb language sql as $$select public.daytrail_collab_get(auth.uid(),pg_temp.free_cloud())->'document';$$;
select set_config('request.jwt.claim.sub',pg_temp.free_actor(1)::text,true);
set local role authenticated;
select pg_temp.check_free('private save retains free time',public.daytrail_mutate_trip(pg_temp.free_actor(1),'free-test',0,pg_temp.free_mid(1),'create',pg_temp.free_doc(),2)->'trip'->'document'#>'{days,0,items,0,freeTime}'=pg_temp.free_doc()#>'{days,0,items,0,freeTime}');
select pg_temp.check_free('private progress maps free block to its preceding place',public.daytrail_mutate_travel_mark(pg_temp.free_actor(1),'free-test','free:free1','nijo','done',0,pg_temp.free_mid(2))->>'status'='ok');
select pg_temp.check_free('progress mutation retry remains idempotent',public.daytrail_mutate_travel_mark(pg_temp.free_actor(1),'free-test','free:free1','nijo','done',0,pg_temp.free_mid(2))->'mark'->>'revision'='1');
select pg_temp.free_error('free block cannot be marked at a different place',$$select public.daytrail_mutate_travel_mark(pg_temp.free_actor(1),'free-test','free:free1','tea','done',1,pg_temp.free_mid(3))$$,'22023');
select pg_temp.free_error('missing free block cannot be marked',$$select public.daytrail_mutate_travel_mark(pg_temp.free_actor(1),'free-test','free:missing','nijo','done',0,pg_temp.free_mid(4))$$,'22023');
insert into free_fixture values('enabled',public.daytrail_collab_enable(pg_temp.free_actor(1),'free-test',1)->'trip');
select pg_temp.check_free('sharing retains free time',pg_temp.free_current()#>'{days,0,items,0,freeTime}'=pg_temp.free_doc()#>'{days,0,items,0,freeTime}');
select pg_temp.check_free('owner progress is carried into shared planning',jsonb_array_length(public.daytrail_collab_list_travel_marks(pg_temp.free_actor(1),pg_temp.free_cloud()))=1);
insert into free_fixture values('editor_invite',public.daytrail_collab_invite(pg_temp.free_actor(1),pg_temp.free_cloud(),'free-editor@example.com','editor'));
insert into free_fixture values('viewer_invite',public.daytrail_collab_invite(pg_temp.free_actor(1),pg_temp.free_cloud(),'free-viewer@example.com','viewer'));
select set_config('request.jwt.claim.sub',pg_temp.free_actor(2)::text,true);
select public.daytrail_collab_accept(pg_temp.free_actor(2),(select value->>'token' from free_fixture where key='editor_invite'));
select pg_temp.check_free('editor can change free duration',public.daytrail_collab_mutate(pg_temp.free_actor(2),pg_temp.free_cloud(),2,pg_temp.free_mid(5),'save',jsonb_set(pg_temp.free_current(),'{days,0,items,0,freeTime,duration}','90'))->'trip'->'document'#>'{days,0,items,0,freeTime,duration}'='90'::jsonb);
select pg_temp.check_free('editor free progress is independent',public.daytrail_collab_mutate_travel_mark(pg_temp.free_actor(2),pg_temp.free_cloud(),'free:free1','nijo','skipped',0,pg_temp.free_mid(6))->>'status'='ok');
select pg_temp.check_free('editor progress version conflicts are preserved',public.daytrail_collab_mutate_travel_mark(pg_temp.free_actor(2),pg_temp.free_cloud(),'free:free1','nijo','done',0,pg_temp.free_mid(7))->>'status'='conflict');
select pg_temp.free_error('shared free target requires its actual place',$$select public.daytrail_collab_mutate_travel_mark(pg_temp.free_actor(2),pg_temp.free_cloud(),'free:free1','tea','done',1,pg_temp.free_mid(8))$$,'22023');
select set_config('request.jwt.claim.sub',pg_temp.free_actor(3)::text,true);
select public.daytrail_collab_accept(pg_temp.free_actor(3),(select value->>'token' from free_fixture where key='viewer_invite'));
select pg_temp.check_free('viewer reads saved free duration',pg_temp.free_current()#>'{days,0,items,0,freeTime,duration}'='90'::jsonb);
select pg_temp.free_error('viewer cannot edit free time',$$select public.daytrail_collab_mutate(pg_temp.free_actor(3),pg_temp.free_cloud(),3,pg_temp.free_mid(9),'save',jsonb_set(pg_temp.free_current(),'{days,0,items,0,freeTime,duration}','30'))$$,'42501');
select pg_temp.check_free('viewer may track own free progress',public.daytrail_collab_mutate_travel_mark(pg_temp.free_actor(3),pg_temp.free_cloud(),'free:free1','nijo','done',0,pg_temp.free_mid(10))->>'status'='ok');
select set_config('request.jwt.claim.sub',pg_temp.free_actor(1)::text,true);
select pg_temp.check_free('other members cannot overwrite owner free progress',public.daytrail_collab_list_travel_marks(pg_temp.free_actor(1),pg_temp.free_cloud())->0->>'state'='done');
reset role;
select count(*) as passed_free_checks from daytrail_free_checks;
rollback;
