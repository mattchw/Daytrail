-- Separate owner-private travel progress; itinerary JSON and trip revisions never change.
begin;
create or replace function daytrail_private.valid_travel_target(v text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(split_part(v,':',1) in ('activity','end')
    and daytrail_private.valid_id(substring(v from position(':' in v)+1))
    and position(':' in v) > 0, false);
$$;

create table public.daytrail_travel_marks (
  owner_id uuid not null,
  trip_id text not null,
  target_id text not null check (daytrail_private.valid_travel_target(target_id)),
  place_id text not null check (daytrail_private.valid_id(place_id)),
  state text not null check (state in ('planned','done','skipped')),
  revision bigint not null check (revision between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  last_mutation_id uuid not null,
  last_mutation_hash text not null,
  primary key(owner_id,trip_id,target_id),
  foreign key(owner_id,trip_id) references public.daytrail_trips(owner_id,trip_id) on delete cascade,
  constraint daytrail_end_state check (split_part(target_id,':',1) <> 'end' or state <> 'skipped')
);
alter table public.daytrail_travel_marks enable row level security;
revoke all on table public.daytrail_travel_marks from public,anon,authenticated;
grant select on table public.daytrail_travel_marks to authenticated;
create policy daytrail_travel_owner_read on public.daytrail_travel_marks for select to authenticated
  using ((select auth.uid()) = owner_id and exists (
    select 1 from public.daytrail_trips t where t.owner_id = daytrail_travel_marks.owner_id
      and t.trip_id = daytrail_travel_marks.trip_id and t.deleted_at is null));

create or replace function public.daytrail_list_travel_marks(p_expected_owner_id uuid,p_trip_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); trip_row public.daytrail_trips%rowtype;
begin
  if owner is null or p_expected_owner_id is distinct from owner then
    raise exception using errcode = '42501',message = 'Daytrail account mismatch';
  end if;
  if not daytrail_private.valid_id(p_trip_id) then raise exception using errcode = '22023',message = 'Invalid Daytrail trip'; end if;
  -- Match trip writes' lock order so delete/reference changes cannot race this read.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select * into trip_row from public.daytrail_trips where owner_id=owner and trip_id=p_trip_id for share;
  if not found or trip_row.deleted_at is not null then
    raise exception using errcode = '22023',message = 'Daytrail trip is unavailable';
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(m) order by m.target_id),'[]'::jsonb)
    from public.daytrail_travel_marks m where m.owner_id=owner and m.trip_id=p_trip_id);
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

revoke all on function daytrail_private.valid_travel_target(text) from public,anon,authenticated;
revoke all on function public.daytrail_list_travel_marks(uuid,text) from public,anon,authenticated;
revoke all on function public.daytrail_mutate_travel_mark(uuid,text,text,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.daytrail_list_travel_marks(uuid,text) to authenticated;
grant execute on function public.daytrail_mutate_travel_mark(uuid,text,text,text,text,bigint,uuid) to authenticated;
comment on table public.daytrail_travel_marks is 'Private per-stop progress. Planned resets and old-location marks retain revisions; no client hard deletion.';
commit;
