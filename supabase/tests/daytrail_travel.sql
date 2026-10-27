-- Synthetic owner-isolation and travel lifecycle checks; all changes rolled back.
begin;
create temporary table daytrail_travel_checks(label text primary key);
grant select,insert on daytrail_travel_checks to anon,authenticated;
create or replace function pg_temp.check_true(label text,actual boolean) returns void language plpgsql as $$
begin
  if actual is distinct from true then raise exception 'Failed: %',label; end if;
  insert into daytrail_travel_checks values(label);
end;
$$;
create or replace function pg_temp.expect_error(label text,statement text,expected_state text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_state then raise exception 'Failed: % (expected %, got %)',label,expected_state,sqlstate; end if;
    insert into daytrail_travel_checks values(label); return;
  end;
  raise exception 'Failed: % (unexpected success)',label;
end;
$$;
create or replace function pg_temp.mutation(n integer) returns uuid language sql as $$
  select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create or replace function pg_temp.travel_trip(id text default 'travel-trip') returns jsonb language sql as $$
  select jsonb_build_object('id',id,'name','Travel test','destination','Kyoto','startDate','2026-10-27','timezone','Asia/Tokyo','ideas','[]'::jsonb,
    'customPlaces','{"airport":{"id":"airport","name":"Saved place","cat":"custom","x":50,"y":50,"area":"","typical":"","blurb":"","googlePlaceId":"ChIJ_airport"}}'::jsonb,
    'days','[{"id":"d1","label":"Day 1","date":"Tue 27","title":"First day","endMode":"walk","items":[{"aid":"a1","placeId":"nijo","duration":60,"fixed":null,"mode":"walk","note":"Keep this"},{"aid":"a2","placeId":"fushimi","duration":90,"fixed":null,"mode":"walk","note":""}]},{"id":"d2","label":"Day 2","date":"Wed 28","title":"Departure","endMode":"transit","endPlaceId":"airport","items":[]}]'::jsonb);
$$;
insert into auth.users(id) values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222') on conflict do nothing;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111"}',true);
set local role authenticated;
select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','travel-trip',0,pg_temp.mutation(1),'create',pg_temp.travel_trip());
select pg_temp.check_true('empty owned trip has no marks',public.daytrail_list_travel_marks('11111111-1111-4111-8111-111111111111','travel-trip')='[]'::jsonb);
select pg_temp.check_true('create activity done revision one',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','done',0,pg_temp.mutation(10))->'mark'->>'revision'='1');
select pg_temp.check_true('travel does not change trip document or revision',(select revision=1 and document=pg_temp.travel_trip() from public.daytrail_trips where trip_id='travel-trip'));
select pg_temp.check_true('exact retry is idempotent',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','done',0,pg_temp.mutation(10))->'mark'->>'revision'='1');
select pg_temp.expect_error('mutation ID reuse with another state rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','planned',0,pg_temp.mutation(10))$$,'22023');
select pg_temp.check_true('different initial mutation conflicts',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','skipped',0,pg_temp.mutation(11))->>'status'='conflict');
select pg_temp.check_true('skip update increments',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','skipped',1,pg_temp.mutation(12))->'mark'->>'revision'='2');
select pg_temp.check_true('stale update conflicts',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','done',1,pg_temp.mutation(13))->>'status'='conflict');
select pg_temp.check_true('old retry after later mutation conflicts',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','done',0,pg_temp.mutation(10))->>'status'='conflict');
select pg_temp.check_true('reset is retained with a new revision',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','planned',2,pg_temp.mutation(14))->'mark'->>'revision'='3');
select pg_temp.check_true('reset remains in list',public.daytrail_list_travel_marks('11111111-1111-4111-8111-111111111111','travel-trip')->0->>'state'='planned');
select pg_temp.check_true('unmarked target with expected revision conflicts',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a2','fushimi','done',1,pg_temp.mutation(15))->'mark'='null'::jsonb);
select pg_temp.check_true('other target has independent revision',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a2','fushimi','done',0,pg_temp.mutation(16))->'mark'->>'revision'='1');
select pg_temp.check_true('default hotel endpoint can be done',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d1','hotel','done',0,pg_temp.mutation(17))->>'status'='ok');
select pg_temp.check_true('explicit airport endpoint can be done',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d2','airport','done',0,pg_temp.mutation(18))->>'status'='ok');
select pg_temp.expect_error('endpoint cannot be skipped',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d2','airport','skipped',1,pg_temp.mutation(19))$$,'22023');
select pg_temp.expect_error('wrong activity location rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','fushimi','done',3,pg_temp.mutation(20))$$,'22023');
select pg_temp.expect_error('wrong endpoint location rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d2','hotel','done',1,pg_temp.mutation(21))$$,'22023');
select pg_temp.expect_error('nonexistent activity rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:missing','nijo','done',0,pg_temp.mutation(22))$$,'22023');
select pg_temp.expect_error('nonexistent day rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:missing','hotel','done',0,pg_temp.mutation(23))$$,'22023');
select pg_temp.expect_error('unknown target prefix rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','start:d1','hotel','done',0,pg_temp.mutation(24))$$,'22023');
select pg_temp.expect_error('unknown state rejected',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','complete',3,pg_temp.mutation(25))$$,'22023');
select pg_temp.expect_error('wrong expected owner list rejected',$$select public.daytrail_list_travel_marks('22222222-2222-4222-8222-222222222222','travel-trip')$$,'42501');
select pg_temp.expect_error('wrong expected owner mutation rejected',$$select public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','travel-trip','activity:a1','nijo','done',3,pg_temp.mutation(26))$$,'42501');
select pg_temp.expect_error('direct progress update denied',$$update public.daytrail_travel_marks set state='done'$$,'42501');
select pg_temp.expect_error('direct progress deletion denied',$$delete from public.daytrail_travel_marks$$,'42501');
select pg_temp.expect_error('direct progress insert denied',$$insert into public.daytrail_travel_marks(owner_id,trip_id,target_id,place_id,state,revision,last_mutation_id,last_mutation_hash) values('11111111-1111-4111-8111-111111111111','travel-trip','activity:bad','nijo','done',1,pg_temp.mutation(27),'fake')$$,'42501');

-- Itinerary edits preserve progress identity but stale locations cannot be replayed.
select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','travel-trip',1,pg_temp.mutation(30),'save',jsonb_set(pg_temp.travel_trip(),'{days,0,items,0,placeId}','"gion"'));
select pg_temp.check_true('old place retained for client filtering',(select place_id='nijo' and revision=3 from public.daytrail_travel_marks where target_id='activity:a1'));
select pg_temp.expect_error('same mutation replay cannot mark changed location',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','nijo','planned',2,pg_temp.mutation(14))$$,'22023');
select pg_temp.check_true('new location updates with existing target revision',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','gion','done',3,pg_temp.mutation(31))->'mark'->>'revision'='4');
select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','travel-trip',2,pg_temp.mutation(32),'save',jsonb_set(pg_temp.travel_trip(),'{days,0,items}','[]'));
select pg_temp.expect_error('removed target cannot receive progress',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','activity:a1','gion','planned',4,pg_temp.mutation(33))$$,'22023');

select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','travel-trip',3,pg_temp.mutation(40),'delete');
select pg_temp.check_true('deleted trip progress hidden by RLS',(select count(*)=0 from public.daytrail_travel_marks));
select pg_temp.expect_error('deleted trip list rejected',$$select public.daytrail_list_travel_marks('11111111-1111-4111-8111-111111111111','travel-trip')$$,'22023');
select pg_temp.expect_error('progress cannot resurrect deleted trip',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d1','hotel','planned',1,pg_temp.mutation(41))$$,'22023');
select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','travel-trip',4,pg_temp.mutation(42),'restore');
select pg_temp.check_true('restore exposes retained progress',(select count(*)=4 from public.daytrail_travel_marks));
select pg_temp.check_true('restore does not reset progress revisions',(select revision=4 from public.daytrail_travel_marks where target_id='activity:a1'));
select pg_temp.check_true('restored endpoint supports planned reset',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d1','hotel','planned',1,pg_temp.mutation(43))->'mark'->>'revision'='2');
reset role;
set local role anon;
select pg_temp.expect_error('guest progress reads denied',$$select * from public.daytrail_travel_marks$$,'42501');
select pg_temp.expect_error('guest progress list denied',$$select public.daytrail_list_travel_marks('11111111-1111-4111-8111-111111111111','travel-trip')$$,'42501');
select pg_temp.expect_error('guest progress mutation denied',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d1','hotel','planned',2,pg_temp.mutation(44))$$,'42501');
reset role;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222"}',true);
set local role authenticated;
select pg_temp.check_true('other owner sees no progress',(select count(*)=0 from public.daytrail_travel_marks));
select pg_temp.expect_error('other owner cannot list first trip',$$select public.daytrail_list_travel_marks('22222222-2222-4222-8222-222222222222','travel-trip')$$,'22023');
select pg_temp.expect_error('other owner cannot mutate first trip',$$select public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','travel-trip','end:d1','hotel','done',0,pg_temp.mutation(45))$$,'22023');
select public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','travel-trip',0,pg_temp.mutation(46),'create',pg_temp.travel_trip());
select pg_temp.check_true('same trip target IDs stay independent across owners',public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','travel-trip','activity:a1','nijo','done',0,pg_temp.mutation(47))->'mark'->>'revision'='1');
select pg_temp.check_true('second owner only sees own marks',(select count(*)=1 and bool_and(owner_id='22222222-2222-4222-8222-222222222222') from public.daytrail_travel_marks));
select pg_temp.expect_error('missing trip list rejected',$$select public.daytrail_list_travel_marks('22222222-2222-4222-8222-222222222222','missing-trip')$$,'22023');
select pg_temp.expect_error('missing trip mutation rejected',$$select public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','missing-trip','end:d1','hotel','done',0,pg_temp.mutation(49))$$,'22023');
reset role;
-- Synthetic historical/orphan targets exercise the bounded storage guard.
insert into public.daytrail_travel_marks(owner_id,trip_id,target_id,place_id,state,revision,last_mutation_id,last_mutation_hash)
select '22222222-2222-4222-8222-222222222222','travel-trip','activity:orphan-'||i,'nijo','planned',1,pg_temp.mutation(1000+i),'fixture'
from generate_series(1,9999) i;
set local role authenticated;
select pg_temp.check_true('bounded mark list includes historical revisions',jsonb_array_length(public.daytrail_list_travel_marks('22222222-2222-4222-8222-222222222222','travel-trip'))=10000);
select pg_temp.expect_error('new marks cannot exceed storage bound',$$select public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','travel-trip','activity:a2','fushimi','done',0,pg_temp.mutation(50))$$,'22023');
select pg_temp.check_true('existing marks can reset at storage bound',public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','travel-trip','activity:a1','nijo','planned',1,pg_temp.mutation(51))->'mark'->>'revision'='2');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role authenticated;
select pg_temp.check_true('missing session sees no progress',(select count(*)=0 from public.daytrail_travel_marks));
select pg_temp.expect_error('missing session cannot list',$$select public.daytrail_list_travel_marks('11111111-1111-4111-8111-111111111111','travel-trip')$$,'42501');
select pg_temp.expect_error('missing session cannot mutate',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','travel-trip','end:d1','hotel','planned',2,pg_temp.mutation(48))$$,'42501');
reset role;
select count(*) as passed_travel_checks from daytrail_travel_checks;
rollback;
