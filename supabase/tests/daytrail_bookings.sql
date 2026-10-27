-- Synthetic schema migration, redaction-boundary and flight progress security checks.
begin;
create temporary table daytrail_booking_checks(label text primary key);
grant select,insert on daytrail_booking_checks to anon,authenticated;
create or replace function pg_temp.check_true(label text,actual boolean) returns void language plpgsql as $$
begin
  if actual is distinct from true then raise exception 'Failed: %',label; end if;
  insert into daytrail_booking_checks values(label);
end; $$;
create or replace function pg_temp.expect_error(label text,statement text,expected_state text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate<>expected_state then raise exception 'Failed: % (expected %, got %)',label,expected_state,sqlstate; end if;
    insert into daytrail_booking_checks values(label); return;
  end;
  raise exception 'Failed: % (unexpected success)',label;
end; $$;
create or replace function pg_temp.mutation(n integer) returns uuid language sql as $$
select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create or replace function pg_temp.booking_trip() returns jsonb language sql as $$
select '{"id":"bookings","name":"Flight holiday","destination":"Tokyo","startDate":"2026-10-27","timezone":"Asia/Tokyo","ideas":[],"customPlaces":{},
"flights":[{"id":"f1","fromPlaceId":"nijo","toPlaceId":"gion","departure":{"date":"2026-10-27","time":"12:30","timezone":"Europe/London"},"arrival":{"date":"2026-10-28","time":"10:00","timezone":"Asia/Tokyo","offsetMinutes":540},"airline":"Test Air","flightNumber":"TA123","departureTerminal":"T1","arrivalTerminal":"T2","departureGate":"G1","arrivalGate":"G2","bookingReference":"PRIVATE-FLIGHT","privateNotes":"Private flight note","airportBufferMinutes":120,"arrivalBufferMinutes":60,"groupId":"outbound"}],
"stays":[{"id":"s1","placeId":"hotel","checkInDate":"2026-10-27","checkOutDate":"2026-10-30","timezone":"Asia/Tokyo","checkInTime":"15:00","checkOutTime":"11:00","bookingReference":"PRIVATE-STAY","contact":"Hotel contact","bookingUrl":"https://example.com/booking","privateNotes":"Private stay note"}],
"days":[{"id":"d1","label":"Day 1","date":"Tue 27","title":"Fly","timezone":"Europe/London","startPlaceId":"nijo","endPlaceId":"hotel","endStayId":"s1","endMode":"transit","items":[{"aid":"a1","placeId":"gion","duration":0,"fixed":null,"mode":"flight","note":"","flightId":"f1"}]},{"id":"d2","label":"Day 2","date":"Wed 28","title":"Tokyo","startStayId":"s1","endMode":"walk","items":[]}]}'::jsonb;
$$;
create or replace function pg_temp.legacy_trip() returns jsonb language sql as $$
select '{"id":"bookings","name":"Legacy","destination":"Tokyo","startDate":"2026-10-27","timezone":"Asia/Tokyo","ideas":[],"customPlaces":{},"days":[{"id":"d1","label":"Day 1","date":"Tue 27","title":"A day","endMode":"walk","items":[]}]}'::jsonb;
$$;
select pg_temp.check_true('v1 accepted after upgrade',daytrail_private.valid_document_version(pg_temp.legacy_trip(),'bookings',1));
select pg_temp.check_true('v2 accepts legacy trip',daytrail_private.valid_document_version(pg_temp.legacy_trip(),'bookings',2));
select pg_temp.check_true('v2 complete booking accepted',daytrail_private.valid_document_version(pg_temp.booking_trip(),'bookings',2));
select pg_temp.check_true('v1 does not accept booking fields',not daytrail_private.valid_document_version(pg_temp.booking_trip(),'bookings',1));
select pg_temp.check_true('unsupported schema rejected',not daytrail_private.valid_document_version(pg_temp.booking_trip(),'bookings',3));
select pg_temp.check_true('unknown booking field rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,debug}','true'),'bookings'));
select pg_temp.check_true('unknown stay field rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,debug}','true'),'bookings'));
select pg_temp.check_true('unknown moment field rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,debug}','true'),'bookings'));
select pg_temp.check_true('null flight array rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights}','null'),'bookings'));
select pg_temp.check_true('null stay array rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays}','null'),'bookings'));
select pg_temp.check_true('duplicate flights rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights}',(pg_temp.booking_trip()->'flights')||(pg_temp.booking_trip()->'flights')),'bookings'));
select pg_temp.check_true('duplicate stays rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays}',(pg_temp.booking_trip()->'stays')||(pg_temp.booking_trip()->'stays')),'bookings'));
select pg_temp.check_true('unlocated airport rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,fromPlaceId}','"missing"'),'bookings'));
select pg_temp.check_true('identical airports rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,fromPlaceId}','"gion"'),'bookings'));
select pg_temp.check_true('invalid calendar day rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,date}','"2026-02-30"'),'bookings'));
select pg_temp.check_true('invalid flight zone rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,timezone}','"Wrong/Zone"'),'bookings'));
select pg_temp.check_true('invalid day zone rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,timezone}','"Wrong/Zone"'),'bookings'));
select pg_temp.check_true('invalid flight time rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,time}','"24:00"'),'bookings'));
select pg_temp.check_true('unknown flight time retained',daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,time}','null'),'bookings'));
select pg_temp.check_true('invalid offset rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,offsetMinutes}','841'),'bookings'));
select pg_temp.check_true('fractional offset rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,departure,offsetMinutes}','1.5'),'bookings'));
select pg_temp.check_true('negative buffer rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,airportBufferMinutes}','-1'),'bookings'));
select pg_temp.check_true('oversized booking notes rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{flights,0,privateNotes}',to_jsonb(repeat('x',8001))),'bookings'));
select pg_temp.check_true('checkout same day rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,checkOutDate}','"2026-10-27"'),'bookings'));
select pg_temp.check_true('checkout before checkin rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,checkOutDate}','"2026-10-26"'),'bookings'));
select pg_temp.check_true('overlong stay rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,checkOutDate}','"2028-10-26"'),'bookings'));
select pg_temp.check_true('unsafe booking URL rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,bookingUrl}','"javascript:alert(1)"'),'bookings'));
select pg_temp.check_true('credential booking URL rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,bookingUrl}','"https://user:pass@example.com/private"'),'bookings'));
select pg_temp.check_true('invalid port booking URL rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,bookingUrl}','"https://example.com:99999/private"'),'bookings'));
select pg_temp.check_true('invalid IPv4 booking URL rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,bookingUrl}','"https://999.999.999.999/private"'),'bookings'));
select pg_temp.check_true('valid IPv6 booking URL accepted',daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,bookingUrl}','"https://[::1]:443/private"'),'bookings'));
select pg_temp.check_true('insecure booking URL rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,bookingUrl}','"http://example.com"'),'bookings'));
select pg_temp.check_true('unknown stay location rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,placeId}','"missing"'),'bookings'));
select pg_temp.check_true('null checkin time rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{stays,0,checkInTime}','null'),'bookings'));
select pg_temp.check_true('missing linked flight rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,items,0,flightId}','"missing"'),'bookings'));
select pg_temp.check_true('flight must start at prior stop',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,startPlaceId}','"hotel"'),'bookings'));
select pg_temp.check_true('flight must end at linked stop',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,items,0,placeId}','"fushimi"'),'bookings'));
select pg_temp.check_true('ground mode cannot hold flightId',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,items,0,mode}','"walk"'),'bookings'));
select pg_temp.check_true('ground activity duration still minimum five',not daytrail_private.valid_document(jsonb_set(pg_temp.legacy_trip(),'{days,0,items}','[{"aid":"a1","placeId":"gion","duration":0,"fixed":null,"mode":"walk","note":""}]'),'bookings'));
select pg_temp.check_true('stay endpoint must match its place',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,endPlaceId}','"gion"'),'bookings'));
select pg_temp.check_true('unknown stay link rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,endStayId}','"missing"'),'bookings'));
select pg_temp.check_true('airport departure marker accepted',daytrail_private.valid_document(jsonb_set(jsonb_set(pg_temp.booking_trip(),'{days,0,startPlaceId}','"hotel"'),'{days,0,items}',jsonb_build_array('{"aid":"dep1","placeId":"nijo","duration":5,"fixed":null,"mode":"transit","note":"","departureForFlightId":"f1"}'::jsonb,pg_temp.booking_trip()->'days'->0->'items'->0)),'bookings'));
select pg_temp.check_true('wrong airport departure marker rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0,items,0,departureForFlightId}','"f1"'),'bookings'));
select pg_temp.check_true('same flight cannot occur twice',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days}',jsonb_build_array(pg_temp.booking_trip()->'days'->0,jsonb_set(jsonb_set(pg_temp.booking_trip()->'days'->0,'{id}','"d3"'),'{items,0,aid}','"a3"'))),'bookings'));
select pg_temp.check_true('end flight link accepted',daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0}','{"id":"d1","label":"Day 1","date":"Tue 27","title":"Fly","startPlaceId":"nijo","endPlaceId":"gion","endMode":"flight","endFlightId":"f1","items":[]}'),'bookings'));
select pg_temp.check_true('end flight missing link rejected',not daytrail_private.valid_document(jsonb_set(pg_temp.booking_trip(),'{days,0}','{"id":"d1","label":"Day 1","date":"Tue 27","title":"Fly","startPlaceId":"nijo","endPlaceId":"gion","endMode":"flight","items":[]}'),'bookings'));

insert into auth.users(id) values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222') on conflict do nothing;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
select pg_temp.check_true('legacy client creates schema1',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',0,pg_temp.mutation(1),'create',pg_temp.legacy_trip(),1)->'trip'->>'schema_version'='1');
select pg_temp.check_true('legacy mutation replay is still exact',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',0,pg_temp.mutation(1),'create',pg_temp.legacy_trip(),1)->'trip'->>'revision'='1');
select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','bookings','end:d1','hotel','done',0,pg_temp.mutation(2));
select pg_temp.check_true('v2 save upgrades row with IDs intact',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',1,pg_temp.mutation(3),'save',pg_temp.booking_trip(),2)->'trip'->>'schema_version'='2');
select pg_temp.check_true('preexisting travel progress retained',(select state='done' and revision=1 from public.daytrail_travel_marks where target_id='end:d1'));
select pg_temp.expect_error('old client cannot overwrite v2 row',$$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',2,pg_temp.mutation(4),'save',pg_temp.legacy_trip(),1)$$,'0A000');
select pg_temp.expect_error('old client cannot delete v2 row',$$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',2,pg_temp.mutation(5),'delete',null,1)$$,'0A000');
select pg_temp.check_true('v2 retry is idempotent',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',1,pg_temp.mutation(3),'save',pg_temp.booking_trip(),2)->'trip'->>'revision'='2');
select pg_temp.check_true('flight progress creates stable mark',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','bookings','flight:f1','gion','done',0,pg_temp.mutation(6))->'mark'->>'target_id'='flight:f1');
select pg_temp.check_true('flight progress does not edit trip',(select revision=2 and document=pg_temp.booking_trip() from public.daytrail_trips where trip_id='bookings'));
select pg_temp.check_true('flight can be skipped',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','bookings','flight:f1','gion','skipped',1,pg_temp.mutation(7))->'mark'->>'state'='skipped');
select pg_temp.expect_error('unknown flight cannot be marked',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','bookings','flight:missing','gion','done',0,pg_temp.mutation(8))$$,'22023');
select pg_temp.expect_error('departure airport does not complete flight',$$select public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','bookings','flight:f1','nijo','done',2,pg_temp.mutation(9))$$,'22023');
select pg_temp.check_true('flight progress stale changes conflict',public.daytrail_mutate_travel_mark('11111111-1111-4111-8111-111111111111','bookings','flight:f1','gion','done',1,pg_temp.mutation(10))->>'status'='conflict');
select pg_temp.expect_error('flight progress requires matching account',$$select public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','bookings','flight:f1','gion','done',2,pg_temp.mutation(11))$$,'42501');
select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',2,pg_temp.mutation(12),'delete',null,2);
select pg_temp.check_true('deleted flight marks invisible',(select count(*)=0 from public.daytrail_travel_marks));
select pg_temp.expect_error('old client cannot restore v2 row',$$select public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',3,pg_temp.mutation(13),'restore',null,1)$$,'0A000');
select pg_temp.check_true('v2 restore retains private bookings',public.daytrail_mutate_trip('11111111-1111-4111-8111-111111111111','bookings',3,pg_temp.mutation(14),'restore',null,2)->'trip'->'document'=pg_temp.booking_trip());
select pg_temp.check_true('restored flight progress intact',(select state='skipped' and revision=2 from public.daytrail_travel_marks where target_id='flight:f1'));
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.check_true('other owner cannot read booking references',(select count(*)=0 from public.daytrail_trips));
select pg_temp.check_true('other owner cannot read flight progress',(select count(*)=0 from public.daytrail_travel_marks));
select pg_temp.expect_error('other owner cannot mutate flight',$$select public.daytrail_mutate_travel_mark('22222222-2222-4222-8222-222222222222','bookings','flight:f1','gion','done',2,pg_temp.mutation(15))$$,'22023');
reset role;
select count(*) as passed_booking_checks from daytrail_booking_checks;
rollback;
