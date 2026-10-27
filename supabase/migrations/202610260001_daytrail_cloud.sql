-- Private, revisioned Daytrail plans. Apply using the Supabase migration owner.
begin;
create schema if not exists daytrail_private;
revoke all on schema daytrail_private from public, anon, authenticated;

create or replace function daytrail_private.valid_id(v text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(v ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$'
    and v not in ('__proto__', 'prototype', 'constructor'), false);
$$;
create or replace function daytrail_private.valid_text(v jsonb, maximum integer, nonempty boolean default false)
returns boolean language sql immutable set search_path = '' as $$
  -- Match JavaScript UTF-16 length and String.trim(), including astral emoji
  -- and Unicode whitespace, so accepted cloud rows remain readable by isTrip.
  select coalesce(jsonb_typeof(v) = 'string'
    and char_length(v #>> '{}') + regexp_count(v #>> '{}', U&'[\+010000-\+10FFFF]') <= maximum
    and (not nonempty or length(btrim(v #>> '{}', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0), false);
$$;
create or replace function daytrail_private.valid_number(v jsonb, minimum numeric, maximum numeric, whole boolean default false)
returns boolean language plpgsql immutable set search_path = '' as $$
declare n numeric;
begin
  if jsonb_typeof(v) is distinct from 'number' then return false; end if;
  n := (v #>> '{}')::numeric;
  return n >= minimum and n <= maximum and (not whole or trunc(n) = n);
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_keys(v jsonb, required text[], allowed text[])
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(v) is distinct from 'object' then return false; end if;
  return v ?& required and not exists (select 1 from jsonb_object_keys(v) k where not (k = any(allowed)));
end;
$$;

create or replace function daytrail_private.valid_document(v jsonb, expected_id text)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  p jsonb; d jsonb; a jsonb; place_key text; idea jsonb;
  known text[] := array['hotel','fushimi','kiyomizu','sannenzaka','nishiki','gion','pontocho','bamboo','tenryuji','arashilunch','kinkakuji','tea','heian','ginkakuji','nanzenji','philosopher','nijo','railway','tofukuji','sanjusangendo','yasaka','palace','ramen','demachi'];
  seen_days text[] := '{}'; seen_activities text[] := '{}'; seen_ideas text[] := '{}';
  trip_date date; last_date date; start_time integer;
begin
  if v is null or octet_length(v::text) > 4194304 or not daytrail_private.valid_id(expected_id)
    or not daytrail_private.valid_keys(v,
      array['id','name','destination','startDate','timezone','days','ideas','customPlaces'],
      array['id','name','destination','startDate','timezone','days','ideas','customPlaces']) then return false; end if;
  if jsonb_typeof(v->'id') <> 'string' or v->>'id' <> expected_id
    or not daytrail_private.valid_text(v->'name',160,true)
    or not daytrail_private.valid_text(v->'destination',160,true)
    or not daytrail_private.valid_text(v->'startDate',10,true)
    or v->>'startDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or not daytrail_private.valid_text(v->'timezone',100,true)
    or not exists (select 1 from pg_catalog.pg_timezone_names where lower(name) = lower(v->>'timezone'))
    or jsonb_typeof(v->'days') <> 'array' or jsonb_typeof(v->'ideas') <> 'array'
    or jsonb_typeof(v->'customPlaces') <> 'object' then return false; end if;
  if jsonb_array_length(v->'days') not between 1 and 30 or jsonb_array_length(v->'ideas') > 500
    or (select count(*) from jsonb_object_keys(v->'customPlaces')) > 500 then return false; end if;
  trip_date := (v->>'startDate')::date;
  last_date := trip_date + jsonb_array_length(v->'days') - 1;
  if to_char(trip_date,'YYYY-MM-DD') <> v->>'startDate' or extract(year from last_date) > 9999 then return false; end if;

  for place_key, p in select key,value from jsonb_each(v->'customPlaces') loop
    if not daytrail_private.valid_id(place_key) or (place_key <> 'hotel' and place_key = any(known))
      or not daytrail_private.valid_keys(p,
        array['id','name','cat','x','y','area','typical','blurb'],
        array['id','name','cat','x','y','area','typical','blurb','noTransit','lat','lng','googlePlaceId','userLabel','userNotes']) then return false; end if;
    if jsonb_typeof(p->'id') <> 'string' or p->>'id' <> place_key
      or not daytrail_private.valid_text(p->'name',160,true)
      or not coalesce(p->>'cat' = any(array['attr','food','custom']),false)
      or not daytrail_private.valid_number(p->'x',0,100) or not daytrail_private.valid_number(p->'y',0,100)
      or not daytrail_private.valid_text(p->'area',300) or not daytrail_private.valid_text(p->'typical',100)
      or not daytrail_private.valid_text(p->'blurb',4000)
      or (p ? 'userLabel' and not daytrail_private.valid_text(p->'userLabel',160))
      or (p ? 'userNotes' and not daytrail_private.valid_text(p->'userNotes',4000)) then return false; end if;
    if p ? 'googlePlaceId' then
      if not daytrail_private.valid_text(p->'googlePlaceId',512,true)
        or p->>'googlePlaceId' !~ '^[a-zA-Z0-9_-]+$'
        or p->>'name' <> (case when place_key = 'hotel' then 'Your stay' else 'Saved place' end)
        or p->>'area' <> '' or p->>'blurb' <> '' or (p->>'x')::numeric <> 50 or (p->>'y')::numeric <> 50
        or p ?| array['lat','lng','noTransit'] then return false; end if;
    else
      if (p ? 'noTransit' and jsonb_typeof(p->'noTransit') <> 'boolean')
        or ((p ? 'lat' or p ? 'lng') and (not daytrail_private.valid_number(p->'lat',-90,90)
          or not daytrail_private.valid_number(p->'lng',-180,180))) then return false; end if;
    end if;
    if not (place_key = any(known)) then known := array_append(known,place_key); end if;
  end loop;
  for idea in select value from jsonb_array_elements(v->'ideas') loop
    place_key := idea #>> '{}';
    if jsonb_typeof(idea) <> 'string' or not daytrail_private.valid_id(place_key)
      or place_key = 'hotel' or not (place_key = any(known)) or place_key = any(seen_ideas) then return false; end if;
    seen_ideas := array_append(seen_ideas,place_key);
  end loop;
  for d in select value from jsonb_array_elements(v->'days') loop
    if not daytrail_private.valid_keys(d,
      array['id','label','date','title','endMode','items'],
      array['id','label','date','title','endMode','items','startTime','finishBy','startPlaceId','endPlaceId']) then return false; end if;
    if jsonb_typeof(d->'id') <> 'string' or not daytrail_private.valid_id(d->>'id') or d->>'id' = any(seen_days)
      or not daytrail_private.valid_text(d->'label',80,true) or not daytrail_private.valid_text(d->'date',80,true)
      or not daytrail_private.valid_text(d->'title',160) or not coalesce(d->>'endMode' = any(array['walk','drive','transit']),false)
      or jsonb_typeof(d->'items') <> 'array' then return false; end if;
    if jsonb_array_length(d->'items') > 100
      or (d ? 'startTime' and not daytrail_private.valid_number(d->'startTime',0,1439,true))
      or (d ? 'startPlaceId' and (jsonb_typeof(d->'startPlaceId') <> 'string' or not (d->>'startPlaceId' = any(known))))
      or (d ? 'endPlaceId' and (jsonb_typeof(d->'endPlaceId') <> 'string' or not (d->>'endPlaceId' = any(known)))) then return false; end if;
    start_time := coalesce((d->>'startTime')::integer,540);
    if d ? 'finishBy' and d->'finishBy' <> 'null'::jsonb
      and not daytrail_private.valid_number(d->'finishBy',start_time+1,1439,true) then return false; end if;
    seen_days := array_append(seen_days,d->>'id');
    for a in select value from jsonb_array_elements(d->'items') loop
      if not daytrail_private.valid_keys(a,
        array['aid','placeId','duration','fixed','mode','note'],array['aid','placeId','duration','fixed','mode','note']) then return false; end if;
      if jsonb_typeof(a->'aid') <> 'string' or not daytrail_private.valid_id(a->>'aid') or a->>'aid' = any(seen_activities)
        or jsonb_typeof(a->'placeId') <> 'string' or a->>'placeId' = 'hotel' or not (a->>'placeId' = any(known))
        or not daytrail_private.valid_number(a->'duration',5,1440,true)
        or (a->'fixed' <> 'null'::jsonb and not daytrail_private.valid_number(a->'fixed',0,1439,true))
        or not coalesce(a->>'mode' = any(array['walk','drive','transit']),false)
        or not daytrail_private.valid_text(a->'note',8000) then return false; end if;
      seen_activities := array_append(seen_activities,a->>'aid');
    end loop;
  end loop;
  return true;
exception when others then return false;
end;
$$;

create table public.daytrail_trips (
  owner_id uuid not null references auth.users(id) on delete cascade,
  trip_id text not null,
  schema_version integer not null default 1 check (schema_version = 1),
  document jsonb not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  last_mutation_id uuid not null,
  last_mutation_hash text not null,
  primary key (owner_id,trip_id),
  constraint daytrail_document_valid check (daytrail_private.valid_document(document,trip_id))
);
create index daytrail_trips_owner_updated on public.daytrail_trips(owner_id,updated_at,trip_id);
alter table public.daytrail_trips enable row level security;
revoke all on table public.daytrail_trips from public, anon, authenticated;
grant select on table public.daytrail_trips to authenticated;
create policy daytrail_owner_read on public.daytrail_trips for select to authenticated
  using ((select auth.uid()) = owner_id);

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
    or p_schema_version is distinct from 1 or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or p_operation is null or p_operation not in ('create','save','delete','restore')
    or (p_operation = 'create' and p_expected_revision <> 0)
    or (p_operation <> 'create' and p_expected_revision < 1)
    or (p_operation in ('create','save') and not daytrail_private.valid_document(p_document,p_trip_id))
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
    insert into public.daytrail_trips(owner_id,trip_id,document,revision,last_mutation_id,last_mutation_hash)
      values(owner,p_trip_id,next_document,1,p_mutation_id,request_hash) returning * into current_row;
  else
    update public.daytrail_trips set document = next_document, revision = revision + 1,
      updated_at = clock_timestamp(),
      deleted_at = case when p_operation = 'delete' then clock_timestamp() when p_operation = 'restore' then null else deleted_at end,
      last_mutation_id = p_mutation_id,last_mutation_hash = request_hash
      where owner_id = owner and trip_id = p_trip_id returning * into current_row;
  end if;
  return jsonb_build_object('status','ok','trip',to_jsonb(current_row));
end;
$$;
revoke all on all functions in schema daytrail_private from public, anon, authenticated;
revoke all on function public.daytrail_mutate_trip(uuid,text,bigint,uuid,text,jsonb,integer) from public, anon, authenticated;
grant execute on function public.daytrail_mutate_trip(uuid,text,bigint,uuid,text,jsonb,integer) to authenticated;
comment on table public.daytrail_trips is 'Private canonical Daytrail plans. Deleted rows are sync tombstones; no client hard deletion.';
commit;
