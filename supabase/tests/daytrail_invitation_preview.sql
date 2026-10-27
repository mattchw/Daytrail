begin;
create temporary table preview_checks(label text primary key);
create temporary table preview_fixtures(key text primary key,value jsonb);
grant select,insert,update on preview_fixtures to authenticated;
grant select,insert on preview_checks to anon,authenticated;
create or replace function pg_temp.check_true(label text,actual boolean) returns void language plpgsql as $$
begin if actual is distinct from true then raise exception 'Failed: %',label; end if; insert into preview_checks values(label); end; $$;
create or replace function pg_temp.expect_error(label text,statement text,expected_state text) returns void language plpgsql as $$
begin begin execute statement; exception when others then if sqlstate<>expected_state then raise exception 'Failed: % (expected %, got %: %)',label,expected_state,sqlstate,sqlerrm; end if; insert into preview_checks values(label); return; end; raise exception 'Failed: % (unexpected success)',label; end; $$;
create or replace function pg_temp.actor(n integer) returns uuid language sql as $$select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create or replace function pg_temp.cloud() returns uuid language sql as $$select (value->>'cloud_trip_id')::uuid from preview_fixtures where key='trip';$$;
create or replace function pg_temp.token(k text) returns text language sql as $$select value->>'token' from preview_fixtures where key=k;$$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
(pg_temp.actor(1),'owner@example.com',now(),'{"full_name":"Trip owner"}'),
(pg_temp.actor(2),'recipient@example.com',now(),'{"full_name":"Recipient"}'),
(pg_temp.actor(3),'other@example.com',now(),'{}'),
(pg_temp.actor(4),'unverified@example.com',null,'{}');
select set_config('request.jwt.claim.sub',pg_temp.actor(1)::text,true);
set local role authenticated;
select public.daytrail_mutate_trip(pg_temp.actor(1),'preview',0,'10000000-0000-4000-8000-000000000001','create','{"id":"preview","name":"A shared holiday","destination":"Tokyo","startDate":"2026-10-27","timezone":"Asia/Tokyo","ideas":[],"customPlaces":{},"days":[{"id":"d1","label":"Day 1","date":"Tue 27","title":"Explore","endMode":"walk","items":[]}]}',2);
insert into preview_fixtures values('trip',public.daytrail_collab_enable(pg_temp.actor(1),'preview',1)->'trip');
insert into preview_fixtures values('invite',public.daytrail_collab_invite(pg_temp.actor(1),pg_temp.cloud(),'recipient@example.com','editor'));
insert into preview_fixtures values('unverified',public.daytrail_collab_invite(pg_temp.actor(1),pg_temp.cloud(),'unverified@example.com','viewer'));
select set_config('request.jwt.claim.sub',pg_temp.actor(2)::text,true);
insert into preview_fixtures values('preview',public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite')));
select pg_temp.check_true('verified preview gives intended trip',(select value->>'trip_name'='A shared holiday' from preview_fixtures where key='preview'));
select pg_temp.check_true('preview identifies owner',(select value->>'owner_name'='Trip owner' from preview_fixtures where key='preview'));
select pg_temp.check_true('preview role and email accurate',(select value->>'role'='editor' and value->>'email'='recipient@example.com' from preview_fixtures where key='preview'));
select pg_temp.check_true('preview only includes five allowed fields',(select value-array['trip_name','owner_name','role','email','expires_at']='{}'::jsonb and (select count(*) from jsonb_object_keys(value))=5 from preview_fixtures where key='preview'));
select pg_temp.check_true('preview does not join trip',public.daytrail_collab_list(pg_temp.actor(2))='[]'::jsonb);
select pg_temp.expect_error('preview does not grant trip access',$$select public.daytrail_collab_get(pg_temp.actor(2),pg_temp.cloud())$$,'42501');
select pg_temp.check_true('repeated preview remains available',public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite'))->>'role'='editor');
select pg_temp.expect_error('bad preview token rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),'bad')$$,'22023');
select pg_temp.expect_error('unknown preview token rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),repeat('a',64))$$,'22023');
select pg_temp.expect_error('preview actor mismatch rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(3),pg_temp.token('invite'))$$,'42501');
select set_config('request.jwt.claim.sub',pg_temp.actor(3)::text,true);
select pg_temp.expect_error('different verified email rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(3),pg_temp.token('invite'))$$,'42501');
select set_config('request.jwt.claim.sub',pg_temp.actor(4)::text,true);
select pg_temp.expect_error('unverified recipient rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(4),pg_temp.token('unverified'))$$,'42501');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error('missing session rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite'))$$,'42501');
select set_config('request.jwt.claim.sub',pg_temp.actor(2)::text,true);
select public.daytrail_collab_accept(pg_temp.actor(2),pg_temp.token('invite'));
select pg_temp.check_true('accepted recipient can preview again',public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite'))->>'role'='editor');
select set_config('request.jwt.claim.sub',pg_temp.actor(1)::text,true);
select public.daytrail_collab_member(pg_temp.actor(1),pg_temp.cloud(),pg_temp.actor(2),'viewer');
select set_config('request.jwt.claim.sub',pg_temp.actor(2)::text,true);
select pg_temp.check_true('accepted preview reflects current role',public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite'))->>'role'='viewer');
select set_config('request.jwt.claim.sub',pg_temp.actor(1)::text,true);
select public.daytrail_collab_member(pg_temp.actor(1),pg_temp.cloud(),pg_temp.actor(2),null);
select set_config('request.jwt.claim.sub',pg_temp.actor(2)::text,true);
select pg_temp.expect_error('removed member cannot preview accepted link',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite'))$$,'22023');
select set_config('request.jwt.claim.sub',pg_temp.actor(1)::text,true);
insert into preview_fixtures values('cancelled',public.daytrail_collab_invite(pg_temp.actor(1),pg_temp.cloud(),'recipient@example.com','viewer'));
select public.daytrail_collab_cancel_invite(pg_temp.actor(1),pg_temp.cloud(),(select (value->>'id')::uuid from preview_fixtures where key='cancelled'));
insert into preview_fixtures values('expired',public.daytrail_collab_invite(pg_temp.actor(1),pg_temp.cloud(),'recipient@example.com','viewer'));
reset role;
update daytrail_private.invites set expires_at=now()-interval '1 second' where id=(select (value->>'id')::uuid from preview_fixtures where key='expired');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.actor(2)::text,true);
select pg_temp.expect_error('cancelled invitation preview rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('cancelled'))$$,'22023');
select pg_temp.expect_error('expired invitation preview rejected',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('expired'))$$,'22023');
select pg_temp.check_true('invalid previews never restore membership',public.daytrail_collab_list(pg_temp.actor(2))='[]'::jsonb);
reset role;
set local role anon;
select pg_temp.expect_error('anonymous preview RPC unavailable',$$select public.daytrail_collab_preview_invite(pg_temp.actor(2),pg_temp.token('invite'))$$,'42501');
reset role;
select count(*) as passed_invitation_preview_checks from preview_checks;
rollback;
