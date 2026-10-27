-- Isolated PostgreSQL/Supabase smoke tests. Every fixture is rolled back.
-- Run as migration owner after applying the migration; never needs real users/tokens.
begin;
create temporary table daytrail_test_checks (label text primary key);
grant select, insert on daytrail_test_checks to anon, authenticated;
create function pg_temp.check_true(label text, actual boolean) returns void language plpgsql as $$
begin
  if actual is distinct from true then raise exception 'Failed: %', label; end if;
  insert into daytrail_test_checks values(label);
end;
$$;
create function pg_temp.expect_error(label text, statement text, expected_state text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_state then raise exception 'Failed: % (expected %, got %)',label,expected_state,sqlstate; end if;
    insert into daytrail_test_checks values(label);
    return;
  end;
  raise exception 'Failed: % (statement unexpectedly succeeded)',label;
end;
$$;
create function pg_temp.fixture(id text default 'legacy-trip') returns jsonb language sql as $$
  select jsonb_build_object('id',id,'name','Test trip','destination','Kyoto','startDate','2026-10-26','timezone','Asia/Tokyo',
    'days',jsonb_build_array(jsonb_build_object('id','d1','label','Day 1','date','Mon 26','title','A day','endMode','walk',
      'startPlaceId','hotel','endPlaceId','hotel','startTime',540,'finishBy',1200,
      'items',jsonb_build_array(jsonb_build_object('aid','a1','placeId','nijo','duration',60,'fixed',null,'mode','walk','note','Keep this note')))),
    'ideas','["nijo"]'::jsonb,'customPlaces','{}'::jsonb);
$$;
create function pg_temp.mutation(n integer) returns uuid language sql as $$
  select ('10000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id) values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222') on conflict do nothing;

select pg_temp.check_true('canonical legacy trip accepted',daytrail_private.valid_document(pg_temp.fixture(),'legacy-trip'));
select pg_temp.check_true('document id must match row',not daytrail_private.valid_document(pg_temp.fixture(),'different'));
select pg_temp.check_true('unknown top-level fields rejected',not daytrail_private.valid_document(pg_temp.fixture() || '{"token":"private"}', 'legacy-trip'));
select pg_temp.check_true('unknown activity fields rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,items,0,rating}','5'),'legacy-trip'));
select pg_temp.check_true('unknown day fields rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,debug}','true'),'legacy-trip'));
select pg_temp.check_true('invalid reference rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,endPlaceId}','"missing"'),'legacy-trip'));
select pg_temp.check_true('duplicate ideas rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{ideas}','["nijo","nijo"]'),'legacy-trip'));
select pg_temp.check_true('duplicate days rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days}',jsonb_build_array(pg_temp.fixture()->'days'->0,pg_temp.fixture()->'days'->0)),'legacy-trip'));
select pg_temp.check_true('duplicate activities rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,items}',jsonb_build_array(pg_temp.fixture()->'days'->0->'items'->0,pg_temp.fixture()->'days'->0->'items'->0)),'legacy-trip'));
select pg_temp.check_true('invalid calendar date rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{startDate}','"2026-02-30"'),'legacy-trip'));
select pg_temp.check_true('invalid timezone rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{timezone}','"Unknown/City"'),'legacy-trip'));
select pg_temp.check_true('case-insensitive timezone accepted',daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{timezone}','"asia/tokyo"'),'legacy-trip'));
select pg_temp.check_true('lowercase UTC accepted',daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{timezone}','"utc"'),'legacy-trip'));
select pg_temp.check_true('emoji limit matches UTF16 units',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{name}',to_jsonb(repeat('🍜',81))),'legacy-trip'));
select pg_temp.check_true('emoji within UTF16 limit accepted',daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{name}',to_jsonb(repeat('🍜',80))),'legacy-trip'));
select pg_temp.check_true('Unicode blank name rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{name}',to_jsonb(U&'\00A0\2000\FEFF'::text)),'legacy-trip'));
select pg_temp.check_true('invalid finish time rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,finishBy}','500'),'legacy-trip'));
select pg_temp.check_true('fractional duration rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,items,0,duration}','5.5'),'legacy-trip'));
select pg_temp.check_true('oversized text rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{days,0,items,0,note}',to_jsonb(repeat('x',8001))),'legacy-trip'));
select pg_temp.check_true('provider placeholder accepted',daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{customPlaces}',
  '{"google":{"id":"google","name":"Saved place","cat":"attr","x":50,"y":50,"area":"","typical":"60 min","blurb":"","googlePlaceId":"ChIJ_test","userLabel":"My stop"}}'),'legacy-trip'));
select pg_temp.check_true('hydrated provider content rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{customPlaces}',
  '{"google":{"id":"google","name":"Provider name","cat":"attr","x":50,"y":50,"area":"","typical":"60 min","blurb":"","googlePlaceId":"ChIJ_test"}}'),'legacy-trip'));
select pg_temp.check_true('provider coordinates rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{customPlaces}',
  '{"google":{"id":"google","name":"Saved place","cat":"attr","x":50,"y":50,"area":"","typical":"60 min","blurb":"","googlePlaceId":"ChIJ_test","lat":35,"lng":135}}'),'legacy-trip'));
select pg_temp.check_true('user custom coordinates accepted',daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{customPlaces}',
  '{"custom":{"id":"custom","name":"Our meeting","cat":"custom","x":50,"y":50,"area":"User address","typical":"60 min","blurb":"Ring twice","lat":35,"lng":135}}'),'legacy-trip'));
select pg_temp.check_true('prototype key rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.fixture(),'{customPlaces}',
  '{"constructor":{"id":"constructor","name":"Unsafe","cat":"custom","x":50,"y":50,"area":"","typical":"","blurb":""}}'),'legacy-trip'));

set local role anon;
select pg_temp.expect_error('anonymous reads denied','select * from public.daytrail_trips','42501');
select pg_temp.expect_error('anonymous RPC denied', $$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',0,pg_temp.mutation(1),'create',pg_temp.fixture())$$,'42501');
reset role;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111"}',true);
set local role authenticated;
select pg_temp.check_true('create revision one',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',0,pg_temp.mutation(1),'create',pg_temp.fixture())->'trip'->>'revision' = '1');
select pg_temp.check_true('exact create replay revision unchanged',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',0,pg_temp.mutation(1),'create',pg_temp.fixture())->'trip'->>'revision' = '1');
select pg_temp.expect_error('same mutation different payload rejected', $$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',0,pg_temp.mutation(1),'create',jsonb_set(pg_temp.fixture(),'{name}','"Other"'))$$,'22023');
select pg_temp.check_true('different create never replaces',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',0,pg_temp.mutation(2),'create',pg_temp.fixture())->>'status' = 'conflict');
select pg_temp.expect_error('wrong expected account rejected', $$select public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','legacy-trip',1,pg_temp.mutation(3),'save',pg_temp.fixture())$$,'42501');
select pg_temp.expect_error('direct update denied', $$update public.daytrail_trips set revision=500$$,'42501');
select pg_temp.expect_error('direct delete denied', $$delete from public.daytrail_trips$$,'42501');
select pg_temp.expect_error('direct insert denied', $$insert into public.daytrail_trips(owner_id,trip_id,document,revision,last_mutation_id,last_mutation_hash) values('11111111-1111-4111-8111-111111111111','bypass',pg_temp.fixture('bypass'),1,pg_temp.mutation(4),'fake')$$,'42501');
select pg_temp.expect_error('unknown schema rejected', $$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',1,pg_temp.mutation(4),'save',pg_temp.fixture(),2)$$,'22023');
select pg_temp.expect_error('unsafe payload rejected in RPC', $$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',1,pg_temp.mutation(4),'save',pg_temp.fixture() || '{"secret":"bad"}')$$,'22023');
select pg_temp.check_true('valid update increments',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',1,pg_temp.mutation(5),'save',jsonb_set(pg_temp.fixture(),'{name}','"Saved edit"'))->'trip'->>'revision' = '2');
select pg_temp.check_true('stale update conflicts',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',1,pg_temp.mutation(6),'save',pg_temp.fixture())->>'status' = 'conflict');
select pg_temp.check_true('older replay after another write conflicts',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',0,pg_temp.mutation(1),'create',pg_temp.fixture())->>'status' = 'conflict');
select pg_temp.check_true('stale delete conflicts',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',1,pg_temp.mutation(7),'delete')->>'status' = 'conflict');
select pg_temp.check_true('delete creates tombstone',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',2,pg_temp.mutation(8),'delete')->'trip'->>'deleted_at' is not null);
select pg_temp.check_true('delete replay revision unchanged',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',2,pg_temp.mutation(8),'delete')->'trip'->>'revision' = '3');
select pg_temp.check_true('normal save cannot resurrect',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',3,pg_temp.mutation(9),'save',pg_temp.fixture())->>'status' = 'conflict');
select pg_temp.check_true('tombstone retains saved content',(select document->>'name'='Saved edit' from public.daytrail_trips where trip_id='legacy-trip'));
select pg_temp.check_true('explicit restore increments',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',3,pg_temp.mutation(10),'restore')->'trip'->>'revision' = '4');
select pg_temp.check_true('restored row active',(select deleted_at is null from public.daytrail_trips where trip_id='legacy-trip'));
select pg_temp.check_true('missing row save never creates',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','absent',1,pg_temp.mutation(11),'save',pg_temp.fixture('absent'))->>'status' = 'conflict');
reset role;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222"}',true);
set local role authenticated;
select pg_temp.check_true('other owner cannot read first owner',(select count(*)=0 from public.daytrail_trips));
select pg_temp.check_true('cross owner mutation cannot find row',public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','legacy-trip',4,pg_temp.mutation(12),'delete')->'trip' = 'null'::jsonb);
select pg_temp.check_true('same legacy id valid in another account',public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','legacy-trip',0,pg_temp.mutation(13),'create',pg_temp.fixture())->>'status' = 'ok');
select pg_temp.check_true('second owner only sees own row',(select count(*)=1 and bool_and(owner_id='22222222-2222-4222-8222-222222222222') from public.daytrail_trips));
do $$
begin
  for i in 1..99 loop
    perform public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','quota-'||i,0,pg_temp.mutation(100+i),'create',pg_temp.fixture('quota-'||i));
  end loop;
end;
$$;
select pg_temp.check_true('100 trips allowed',(select count(*)=100 from public.daytrail_trips));
select pg_temp.expect_error('trip count quota rejects next create', $$select public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','overflow',0,pg_temp.mutation(300),'create',pg_temp.fixture('overflow'))$$,'22023');
select public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','quota-1',1,pg_temp.mutation(301),'delete');
select pg_temp.expect_error('trash counts toward quota', $$select public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','overflow',0,pg_temp.mutation(302),'create',pg_temp.fixture('overflow'))$$,'22023');
select pg_temp.check_true('update at count quota remains possible',public.daytrail_mutate_trip('22222222-2222-4222-8222-222222222222','legacy-trip',1,pg_temp.mutation(303),'save',pg_temp.fixture())->>'status'='ok');
reset role;
create function pg_temp.large_fixture(id text, day_count integer) returns jsonb language sql as $$
  select jsonb_set(pg_temp.fixture(id),'{days}',(
    select jsonb_agg(jsonb_build_object('id','day-'||d,'label','Day '||d,'date','Mon 26','title','A day','endMode','walk','items',(
      select jsonb_agg(jsonb_build_object('aid','a-'||d||'-'||a,'placeId','nijo','duration',60,'fixed',null,'mode','walk','note',repeat('x',8000)))
      from generate_series(1,100) a))) from generate_series(1,day_count) d));
$$;
select pg_temp.check_true('under-limit large document accepted',daytrail_private.valid_document(pg_temp.large_fixture('large',3),'large'));
select pg_temp.check_true('document byte quota enforced',not daytrail_private.valid_document(pg_temp.large_fixture('large',6),'large'));
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111"}',true);
set local role authenticated;
select pg_temp.check_true('another account retains own quota',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','large',0,pg_temp.mutation(400),'create',pg_temp.large_fixture('large',3))->>'status'='ok');
select pg_temp.expect_error('aggregate account byte quota enforced', $$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','large-2',0,pg_temp.mutation(401),'create',pg_temp.large_fixture('large-2',3))$$,'22023');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role authenticated;
select pg_temp.expect_error('missing JWT cannot mutate', $$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','legacy-trip',4,pg_temp.mutation(14),'delete')$$,'42501');
select pg_temp.check_true('missing JWT sees no rows',(select count(*)=0 from public.daytrail_trips));
reset role;
select count(*) as passed_checks from daytrail_test_checks;
rollback;
