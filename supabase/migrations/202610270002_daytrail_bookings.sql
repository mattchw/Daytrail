-- Flights and accommodation schema v2. Existing plans and progress retain their IDs.
-- Run after both prior Daytrail migrations. No rows are rewritten or uploaded.
begin;

alter function daytrail_private.valid_document(jsonb,text) rename to valid_document_v1;

create or replace function daytrail_private.valid_booking_date(v jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare value text; parsed date;
begin
  if jsonb_typeof(v) is distinct from 'string' then return false; end if;
  value := v #>> '{}';
  if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  parsed := value::date;
  return to_char(parsed,'YYYY-MM-DD')=value and extract(year from parsed) between 1 and 9999;
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_booking_zone(v jsonb)
returns boolean language sql stable set search_path='' as $$
  select daytrail_private.valid_text(v,100,true) and exists(select 1 from pg_catalog.pg_timezone_names where lower(name)=lower(v #>> '{}'));
$$;
create or replace function daytrail_private.valid_booking_time(v jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(v)='string' and (v #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$',false);
$$;
-- Validate URL authority rather than trusting a prefix (credentials/invalid ports
-- would make a server row unreadable by the browser's URL validator).
create or replace function daytrail_private.valid_booking_url(v jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare value text; authority text; host text; port text; ip inet;
begin
  if not daytrail_private.valid_text(v,2048,true) then return false; end if;
  value := v #>> '{}';
  if value !~* '^https://' or value ~ '[[:space:]]' or position(chr(92) in value)>0 then return false; end if;
  authority := substring(value from '(?i)^https://([^/?#]+)');
  if authority is null or position('@' in authority)>0 then return false; end if;
  if authority like '[%' then
    host := substring(authority from '^\[([^]]+)\]');
    if host is null or authority !~ '^\[[^]]+\](:[0-9]*)?$' then return false; end if;
    ip := host::inet;
    if family(ip)<>6 then return false; end if;
    port := substring(authority from '\]:([0-9]*)$');
  else
    if authority !~ '^[[:alnum:]_.-]+(:[0-9]*)?$' then return false; end if;
    host := split_part(authority,':',1);
    port := substring(authority from ':([0-9]*)$');
    -- WHATWG treats a final numeric label as an IPv4 address.
    if host ~ '(^|\.)[0-9]+\.?$' then
      ip := rtrim(host,'.')::inet;
      if family(ip)<>4 then return false; end if;
    end if;
  end if;
  return port is null or port='' or port::numeric between 0 and 65535;
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_flight_moment(v jsonb)
returns boolean language sql stable set search_path='' as $$
  select daytrail_private.valid_keys(v,array['date','time','timezone'],array['date','time','timezone','offsetMinutes'])
    and daytrail_private.valid_booking_date(v->'date') and daytrail_private.valid_booking_zone(v->'timezone')
    and (v->'time'='null'::jsonb or daytrail_private.valid_booking_time(v->'time'))
    and (not (v ? 'offsetMinutes') or daytrail_private.valid_number(v->'offsetMinutes',-840,840,true));
$$;

-- V2 keeps the mature canonical place/itinerary validator as its base. New fields
-- are checked here, then removed from the temporary document passed to v1.
create or replace function daytrail_private.valid_document(v jsonb,expected_id text)
returns boolean language plpgsql stable set search_path='' as $$
declare
  legacy jsonb; days jsonb := '[]'::jsonb; items jsonb; d jsonb; a jsonb; f jsonb; s jsonb; m jsonb;
  old_day jsonb; old_item jsonb; field text; previous_place text; end_place text;
  flight_ids text[] := '{}'; stay_ids text[] := '{}'; linked_flights text[] := '{}';
  known text[] := array['hotel','fushimi','kiyomizu','sannenzaka','nishiki','gion','pontocho','bamboo','tenryuji','arashilunch','kinkakuji','tea','heian','ginkakuji','nanzenji','philosopher','nijo','railway','tofukuji','sanjusangendo','yasaka','palace','ramen','demachi'];
begin
  if v is null or octet_length(v::text)>4194304 or not daytrail_private.valid_keys(v,
    array['id','name','destination','startDate','timezone','days','ideas','customPlaces'],
    array['id','name','destination','startDate','timezone','days','ideas','customPlaces','flights','stays']) then return false; end if;
  if jsonb_typeof(v->'days') is distinct from 'array' or jsonb_typeof(v->'customPlaces') is distinct from 'object' then return false; end if;
  known := known || array(select jsonb_object_keys(v->'customPlaces'));
  if v ? 'flights' then
    if jsonb_typeof(v->'flights') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'flights')>100 then return false; end if;
    for f in select value from jsonb_array_elements(v->'flights') loop
      if not daytrail_private.valid_keys(f,array['id','fromPlaceId','toPlaceId','departure','arrival'],
        array['id','fromPlaceId','toPlaceId','departure','arrival','airline','flightNumber','departureTerminal','arrivalTerminal','departureGate','arrivalGate','bookingReference','privateNotes','airportBufferMinutes','arrivalBufferMinutes','groupId'])
        or jsonb_typeof(f->'id') is distinct from 'string' or not daytrail_private.valid_id(f->>'id') or f->>'id'=any(flight_ids)
        or jsonb_typeof(f->'fromPlaceId') is distinct from 'string' or not coalesce(f->>'fromPlaceId'=any(known),false)
        or jsonb_typeof(f->'toPlaceId') is distinct from 'string' or not coalesce(f->>'toPlaceId'=any(known),false)
        or f->>'fromPlaceId'=f->>'toPlaceId'
        or not daytrail_private.valid_flight_moment(f->'departure') or not daytrail_private.valid_flight_moment(f->'arrival') then return false; end if;
      foreach field in array array['airline','bookingReference'] loop
        if f ? field and not daytrail_private.valid_text(f->field,160) then return false; end if;
      end loop;
      foreach field in array array['flightNumber','departureGate','arrivalGate'] loop
        if f ? field and not daytrail_private.valid_text(f->field,40) then return false; end if;
      end loop;
      foreach field in array array['departureTerminal','arrivalTerminal'] loop
        if f ? field and not daytrail_private.valid_text(f->field,80) then return false; end if;
      end loop;
      if (f ? 'privateNotes' and not daytrail_private.valid_text(f->'privateNotes',8000))
        or (f ? 'groupId' and (jsonb_typeof(f->'groupId') is distinct from 'string' or not daytrail_private.valid_id(f->>'groupId'))) then return false; end if;
      foreach field in array array['airportBufferMinutes','arrivalBufferMinutes'] loop
        if f ? field and not daytrail_private.valid_number(f->field,0,1440,true) then return false; end if;
      end loop;
      flight_ids := array_append(flight_ids,f->>'id');
    end loop;
  end if;
  if v ? 'stays' then
    if jsonb_typeof(v->'stays') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'stays')>100 then return false; end if;
    for s in select value from jsonb_array_elements(v->'stays') loop
      if not daytrail_private.valid_keys(s,array['id','placeId','checkInDate','checkOutDate','timezone'],
        array['id','placeId','checkInDate','checkOutDate','timezone','checkInTime','checkOutTime','bookingReference','contact','bookingUrl','privateNotes'])
        or jsonb_typeof(s->'id') is distinct from 'string' or not daytrail_private.valid_id(s->>'id') or s->>'id'=any(stay_ids)
        or jsonb_typeof(s->'placeId') is distinct from 'string' or not coalesce(s->>'placeId'=any(known),false)
        or not daytrail_private.valid_booking_date(s->'checkInDate') or not daytrail_private.valid_booking_date(s->'checkOutDate')
        or not daytrail_private.valid_booking_zone(s->'timezone') then return false; end if;
      if (s->>'checkOutDate')::date-(s->>'checkInDate')::date not between 1 and 365 then return false; end if;
      foreach field in array array['checkInTime','checkOutTime'] loop
        if s ? field and not daytrail_private.valid_booking_time(s->field) then return false; end if;
      end loop;
      if (s ? 'bookingReference' and not daytrail_private.valid_text(s->'bookingReference',160))
        or (s ? 'contact' and not daytrail_private.valid_text(s->'contact',500))
        or (s ? 'privateNotes' and not daytrail_private.valid_text(s->'privateNotes',8000))
        or (s ? 'bookingUrl' and not daytrail_private.valid_booking_url(s->'bookingUrl')) then return false; end if;
      stay_ids := array_append(stay_ids,s->>'id');
    end loop;
  end if;
  for d in select value from jsonb_array_elements(v->'days') loop
    if d ? 'timezone' and not daytrail_private.valid_booking_zone(d->'timezone') then return false; end if;
    previous_place := coalesce(d->>'startPlaceId','hotel'); end_place := coalesce(d->>'endPlaceId','hotel');
    foreach field in array array['startStayId','endStayId'] loop
      if d ? field then
        if jsonb_typeof(d->field) is distinct from 'string' or not coalesce(d->>field=any(stay_ids),false) then return false; end if;
        select value into s from jsonb_array_elements(v->'stays') where value->>'id'=d->>field;
        if s->>'placeId' <> (case when field='startStayId' then previous_place else end_place end) then return false; end if;
      end if;
    end loop;
    old_day := d-array['timezone','startStayId','endStayId','endFlightId']; items := '[]'::jsonb;
    for a in select value from jsonb_array_elements(d->'items') loop
      old_item := a-array['flightId','departureForFlightId'];
      if a ? 'departureForFlightId' then
        if a->>'mode'='flight' or jsonb_typeof(a->'departureForFlightId') is distinct from 'string'
          or not coalesce(a->>'departureForFlightId'=any(flight_ids),false) then return false; end if;
        select value into f from jsonb_array_elements(v->'flights') where value->>'id'=a->>'departureForFlightId';
        if f->>'fromPlaceId' <> a->>'placeId' then return false; end if;
      end if;
      if a->>'mode'='flight' then
        if jsonb_typeof(a->'flightId') is distinct from 'string' or not coalesce(a->>'flightId'=any(flight_ids),false)
          or a->>'flightId'=any(linked_flights) or not daytrail_private.valid_number(a->'duration',0,1440,true) then return false; end if;
        select value into f from jsonb_array_elements(v->'flights') where value->>'id'=a->>'flightId';
        if f->>'fromPlaceId' <> previous_place or f->>'toPlaceId' <> a->>'placeId' then return false; end if;
        linked_flights := array_append(linked_flights,a->>'flightId');
        old_item := jsonb_set(jsonb_set(old_item,'{mode}','"walk"'),'{duration}',to_jsonb(greatest(5,(a->>'duration')::integer)));
      elsif a ? 'flightId' then return false;
      end if;
      previous_place := a->>'placeId'; items := items || jsonb_build_array(old_item);
    end loop;
    if d->>'endMode'='flight' then
      if jsonb_typeof(d->'endFlightId') is distinct from 'string' or not coalesce(d->>'endFlightId'=any(flight_ids),false)
        or d->>'endFlightId'=any(linked_flights) then return false; end if;
      select value into f from jsonb_array_elements(v->'flights') where value->>'id'=d->>'endFlightId';
      if f->>'fromPlaceId' <> previous_place or f->>'toPlaceId' <> end_place then return false; end if;
      linked_flights := array_append(linked_flights,d->>'endFlightId');
      old_day := jsonb_set(old_day,'{endMode}','"walk"');
    elsif d ? 'endFlightId' then return false;
    end if;
    days := days || jsonb_build_array(jsonb_set(old_day,'{items}',items));
  end loop;
  legacy := jsonb_set(v-array['flights','stays'],'{days}',days);
  return daytrail_private.valid_document_v1(legacy,expected_id);
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_document_version(v jsonb,expected_id text,schema_version integer)
returns boolean language sql stable set search_path='' as $$
  select case when schema_version=1 then daytrail_private.valid_document_v1(v,expected_id)
    when schema_version=2 then daytrail_private.valid_document(v,expected_id) else false end;
$$;

alter table public.daytrail_trips drop constraint daytrail_trips_schema_version_check;
alter table public.daytrail_trips add constraint daytrail_trips_schema_version_check check(schema_version in (1,2));
alter table public.daytrail_trips drop constraint daytrail_document_valid;
alter table public.daytrail_trips add constraint daytrail_document_valid check(daytrail_private.valid_document_version(document,trip_id,schema_version));

create or replace function daytrail_private.valid_travel_target(v text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(split_part(v,':',1) in ('activity','end','flight')
    and daytrail_private.valid_id(substring(v from position(':' in v)+1)) and position(':' in v)>0,false);
$$;
create or replace function public.daytrail_mutate_trip(
  p_expected_owner_id uuid, p_trip_id text, p_expected_revision bigint,
  p_mutation_id uuid, p_operation text, p_document jsonb default null, p_schema_version integer default 1
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid(); current_row public.daytrail_trips%rowtype;
  request_hash text; found_row boolean; total_rows bigint; total_bytes bigint; next_document jsonb;
begin
  if owner is null or p_expected_owner_id is distinct from owner then
    raise exception using errcode = '42501', message = 'Daytrail account mismatch';
  end if;
  if not daytrail_private.valid_id(p_trip_id) or p_mutation_id is null
    or (p_schema_version is null or p_schema_version not in (1,2)) or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or p_operation is null or p_operation not in ('create','save','delete','restore')
    or (p_operation = 'create' and p_expected_revision <> 0)
    or (p_operation <> 'create' and p_expected_revision < 1)
    or (p_operation in ('create','save') and not daytrail_private.valid_document_version(p_document,p_trip_id,p_schema_version))
    or (p_operation in ('delete','restore') and p_document is not null) then
    raise exception using errcode = '22023', message = 'Invalid Daytrail mutation';
  end if;
  request_hash := encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'revision',p_expected_revision,
    'schema',p_schema_version,'document',p_document)::text,'UTF8')),'hex');
  -- One owner lock also makes account quota checks and concurrent creates atomic.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select * into current_row from public.daytrail_trips where owner_id = owner and trip_id = p_trip_id for update;
  found_row := found;
  if found_row and current_row.last_mutation_id = p_mutation_id then
    if current_row.last_mutation_hash <> request_hash then
      raise exception using errcode = '22023', message = 'Mutation ID was reused';
    end if;
    return jsonb_build_object('status','ok','trip',to_jsonb(current_row));
  end if;
  -- Never let an older client silently strip booking data, including via delete/restore.
  if found_row and current_row.schema_version > p_schema_version then
    raise exception using errcode = '0A000', message = 'Reload Daytrail before editing this trip';
  end if;
  if (p_operation = 'create' and found_row) or (p_operation <> 'create' and not found_row)
    or (found_row and current_row.revision <> p_expected_revision)
    or (found_row and ((p_operation = 'save' and current_row.deleted_at is not null)
      or (p_operation = 'delete' and current_row.deleted_at is not null)
      or (p_operation = 'restore' and current_row.deleted_at is null))) then
    return jsonb_build_object('status','conflict','trip',case when found_row then to_jsonb(current_row) else null end);
  end if;
  next_document := case when p_operation in ('create','save') then p_document else current_row.document end;
  select count(*),coalesce(sum(octet_length(document::text)),0) into total_rows,total_bytes
    from public.daytrail_trips where owner_id = owner;
  if (not found_row and total_rows >= 100)
    or total_bytes - (case when found_row then octet_length(current_row.document::text) else 0 end)
      + octet_length(next_document::text) > 4194304 then
    raise exception using errcode = '22023', message = 'Daytrail cloud quota exceeded';
  end if;
  if p_operation = 'create' then
    insert into public.daytrail_trips(owner_id,trip_id,schema_version,document,revision,last_mutation_id,last_mutation_hash)
      values(owner,p_trip_id,p_schema_version,next_document,1,p_mutation_id,request_hash) returning * into current_row;
  else
    update public.daytrail_trips set document = next_document, schema_version = greatest(schema_version,p_schema_version), revision = revision + 1,
      updated_at = clock_timestamp(),
      deleted_at = case when p_operation = 'delete' then clock_timestamp() when p_operation = 'restore' then null else deleted_at end,
      last_mutation_id = p_mutation_id,last_mutation_hash = request_hash
      where owner_id = owner and trip_id = p_trip_id returning * into current_row;
  end if;
  return jsonb_build_object('status','ok','trip',to_jsonb(current_row));
end;
$$;

create or replace function public.daytrail_mutate_travel_mark(
  p_expected_owner_id uuid,p_trip_id text,p_target_id text,p_place_id text,p_state text,
  p_expected_revision bigint,p_mutation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid(); trip_row public.daytrail_trips%rowtype;
  current_row public.daytrail_travel_marks%rowtype; found_row boolean;
  target_kind text; target_key text; actual_place text; request_hash text;
begin
  if owner is null or p_expected_owner_id is distinct from owner then
    raise exception using errcode = '42501',message = 'Daytrail account mismatch';
  end if;
  if not daytrail_private.valid_id(p_trip_id) or not daytrail_private.valid_travel_target(p_target_id)
    or not daytrail_private.valid_id(p_place_id) or p_state is null or p_state not in ('planned','done','skipped')
    or (split_part(p_target_id,':',1)='end' and p_state='skipped') or p_mutation_id is null
    or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '22023',message = 'Invalid Daytrail travel mutation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select * into trip_row from public.daytrail_trips where owner_id=owner and trip_id=p_trip_id for update;
  if not found or trip_row.deleted_at is not null then
    raise exception using errcode = '22023',message = 'Daytrail trip is unavailable';
  end if;
  target_kind := split_part(p_target_id,':',1);
  target_key := substring(p_target_id from position(':' in p_target_id)+1);
  if target_kind='activity' then
    select a->>'placeId' into actual_place from jsonb_array_elements(trip_row.document->'days') d
      cross join lateral jsonb_array_elements(d->'items') a where a->>'aid'=target_key;
  elsif target_kind='flight' then
    select f->>'toPlaceId' into actual_place from jsonb_array_elements(coalesce(trip_row.document->'flights','[]'::jsonb)) f where f->>'id'=target_key;
  else
    select coalesce(d->>'endPlaceId','hotel') into actual_place from jsonb_array_elements(trip_row.document->'days') d
      where d->>'id'=target_key;
  end if;
  -- Guard even exact replays when the place ID was replaced. Name/coordinate
  -- edits under the same stable place ID intentionally preserve progress.
  if actual_place is null or actual_place <> p_place_id then
    raise exception using errcode = '22023',message = 'Daytrail travel target changed';
  end if;
  request_hash := encode(sha256(convert_to(jsonb_build_object('place',p_place_id,'state',p_state,'revision',p_expected_revision)::text,'UTF8')),'hex');
  select * into current_row from public.daytrail_travel_marks
    where owner_id=owner and trip_id=p_trip_id and target_id=p_target_id for update;
  found_row := found;
  if found_row and current_row.last_mutation_id=p_mutation_id then
    if current_row.last_mutation_hash <> request_hash then
      raise exception using errcode = '22023',message = 'Mutation ID was reused';
    end if;
    return jsonb_build_object('status','ok','mark',to_jsonb(current_row));
  end if;
  if (not found_row and p_expected_revision<>0) or (found_row and current_row.revision<>p_expected_revision) then
    return jsonb_build_object('status','conflict','mark',(case when found_row then to_jsonb(current_row) else null end));
  end if;
  if not found_row then
    if (select count(*) from public.daytrail_travel_marks where owner_id=owner and trip_id=p_trip_id) >= 10000 then
      raise exception using errcode = '22023',message = 'Daytrail travel limit reached';
    end if;
    insert into public.daytrail_travel_marks(owner_id,trip_id,target_id,place_id,state,revision,last_mutation_id,last_mutation_hash)
      values(owner,p_trip_id,p_target_id,p_place_id,p_state,1,p_mutation_id,request_hash) returning * into current_row;
  else
    update public.daytrail_travel_marks set place_id=p_place_id,state=p_state,revision=revision+1,
      updated_at=clock_timestamp(),last_mutation_id=p_mutation_id,last_mutation_hash=request_hash
      where owner_id=owner and trip_id=p_trip_id and target_id=p_target_id returning * into current_row;
  end if;
  return jsonb_build_object('status','ok','mark',to_jsonb(current_row));
end;
$$;

revoke all on all functions in schema daytrail_private from public,anon,authenticated;
revoke all on function public.daytrail_mutate_trip(uuid,text,bigint,uuid,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.daytrail_mutate_travel_mark(uuid,text,text,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.daytrail_mutate_trip(uuid,text,bigint,uuid,text,jsonb,integer) to authenticated;
grant execute on function public.daytrail_mutate_travel_mark(uuid,text,text,text,text,bigint,uuid) to authenticated;
comment on table public.daytrail_trips is 'Private canonical Daytrail plans; schema 2 adds flights and stays. Old clients cannot overwrite schema 2 rows.';
commit;
