-- Free time is traveller-authored time attached to a visit, never a synthetic place.
begin;
alter function daytrail_private.valid_document(jsonb,text) rename to valid_document_v4;
create function daytrail_private.valid_document(v jsonb,expected_id text)
returns boolean language plpgsql stable set search_path='' as $$
declare days jsonb:='[]'; items jsonb; d jsonb; a jsonb; f jsonb; seen text[]:=array[]::text[];
begin
  if jsonb_typeof(v->'days') is distinct from 'array' then return false; end if;
  for d in select value from jsonb_array_elements(v->'days') loop
    if jsonb_typeof(d->'items') is distinct from 'array' then return false; end if;
    items:='[]';
    for a in select value from jsonb_array_elements(d->'items') loop
      if a ? 'freeTime' then
        f:=a->'freeTime';
        if not daytrail_private.valid_keys(f,array['id','kind','duration','untilBooking'],array['id','kind','duration','untilBooking'])
          or jsonb_typeof(f->'id') is distinct from 'string' or not daytrail_private.valid_id(f->>'id') or f->>'id'=any(seen)
          or not coalesce(f->>'kind'=any(array['explore','rest','shopping','nothing']),false)
          or not daytrail_private.valid_number(f->'duration',15,720,true)
          or (f->>'duration')::numeric % 15 <> 0
          or jsonb_typeof(f->'untilBooking') is distinct from 'boolean' then return false; end if;
        seen:=array_append(seen,f->>'id');
      end if;
      items:=items||jsonb_build_array(a-'freeTime');
    end loop;
    days:=days||jsonb_build_array(jsonb_set(d,'{items}',items));
  end loop;
  return daytrail_private.valid_document_v4(jsonb_set(v,'{days}',days),expected_id);
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_document_version(v jsonb,expected_id text,schema_version integer)
returns boolean language sql stable set search_path='' as $$
 select case when schema_version=1 then daytrail_private.valid_document_v1(v,expected_id)
 when schema_version=2 then daytrail_private.valid_document(v,expected_id) else false end;
$$;
create or replace function daytrail_private.valid_travel_target(v text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(split_part(v,':',1) in ('activity','end','flight','free')
   and daytrail_private.valid_id(substring(v from position(':' in v)+1)) and position(':' in v)>0,false);
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
  elsif target_kind='free' then
    select a->>'placeId' into actual_place from jsonb_array_elements(trip_row.document->'days') d
      cross join lateral jsonb_array_elements(d->'items') a where a->'freeTime'->>'id'=target_key;
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
create or replace function public.daytrail_collab_mutate_travel_mark(p_expected_actor_id uuid,p_cloud_trip_id uuid,p_target_id text,p_place_id text,p_state text,p_expected_revision bigint,p_mutation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
  m daytrail_private.collab_travel_marks%rowtype; receipt daytrail_private.collab_travel_receipts%rowtype; present boolean; actual text; hash text; target text:=split_part(p_target_id,':',2);
begin
  if t.deleted_at is not null then raise exception using errcode='22023',message='Daytrail trip is unavailable'; end if;
  if not daytrail_private.valid_travel_target(p_target_id) or not daytrail_private.valid_id(p_place_id) or p_state is null or p_state not in ('planned','done','skipped') or (split_part(p_target_id,':',1)='end' and p_state='skipped') or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 or p_mutation_id is null then raise exception using errcode='22023',message='Invalid travel update'; end if;
  if split_part(p_target_id,':',1)='activity' then select a->>'placeId' into actual from jsonb_array_elements(t.document->'days') d cross join lateral jsonb_array_elements(d->'items') a where a->>'aid'=target;
  elsif split_part(p_target_id,':',1)='free' then select a->>'placeId' into actual from jsonb_array_elements(t.document->'days') d cross join lateral jsonb_array_elements(d->'items') a where a->'freeTime'->>'id'=target;
  elsif split_part(p_target_id,':',1)='flight' then select f->>'toPlaceId' into actual from jsonb_array_elements(coalesce(t.document->'flights','[]')) f where f->>'id'=target;
  else select coalesce(d->>'endPlaceId','hotel') into actual from jsonb_array_elements(t.document->'days') d where d->>'id'=target; end if;
  if actual is null or actual<>p_place_id then raise exception using errcode='22023',message='Daytrail travel target changed'; end if;
  if t.owner_id=p_expected_actor_id then perform daytrail_private.copy_owner_marks(t); end if;
  hash:=encode(sha256(convert_to(jsonb_build_object('target',p_target_id,'place',p_place_id,'state',p_state,'revision',p_expected_revision)::text,'UTF8')),'hex');
  select * into receipt from daytrail_private.collab_travel_receipts where cloud_trip_id=t.cloud_trip_id and actor_id=p_expected_actor_id and mutation_id=p_mutation_id;
  if found then
    if receipt.request_hash<>hash then raise exception using errcode='22023',message='Mutation ID was reused'; end if;
    return jsonb_build_object('status','ok','mark',receipt.mark);
  end if;
  select * into m from daytrail_private.collab_travel_marks where cloud_trip_id=t.cloud_trip_id and actor_id=p_expected_actor_id and target_id=p_target_id;
  present:=found;
  if (present and m.revision<>p_expected_revision) or (not present and p_expected_revision<>0) then return jsonb_build_object('status','conflict','mark',case when present then daytrail_private.collab_mark_projection(m) else null end); end if;
  if not present and (select count(*) from daytrail_private.collab_travel_marks where cloud_trip_id=t.cloud_trip_id and actor_id=p_expected_actor_id)>=10000 then raise exception using errcode='22023',message='Daytrail travel limit reached'; end if;
  insert into daytrail_private.collab_travel_marks(cloud_trip_id,actor_id,target_id,place_id,state,revision) values(t.cloud_trip_id,p_expected_actor_id,p_target_id,p_place_id,p_state,p_expected_revision+1)
    on conflict(cloud_trip_id,actor_id,target_id) do update set place_id=excluded.place_id,state=excluded.state,revision=excluded.revision,updated_at=clock_timestamp() returning * into m;
  insert into daytrail_private.collab_travel_receipts(cloud_trip_id,actor_id,mutation_id,request_hash,mark) values(t.cloud_trip_id,p_expected_actor_id,p_mutation_id,hash,daytrail_private.collab_mark_projection(m));
  return jsonb_build_object('status','ok','mark',daytrail_private.collab_mark_projection(m));
end; $$;
revoke all on function daytrail_private.valid_document(jsonb,text) from public,anon,authenticated;
revoke all on function daytrail_private.valid_document_v4(jsonb,text) from public,anon,authenticated;
revoke all on function daytrail_private.valid_document_version(jsonb,text,integer) from public,anon,authenticated;
revoke all on function daytrail_private.valid_travel_target(text) from public,anon,authenticated;
revoke all on function public.daytrail_mutate_travel_mark(uuid,text,text,text,text,bigint,uuid) from public,anon,authenticated;
revoke all on function public.daytrail_collab_mutate_travel_mark(uuid,uuid,text,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.daytrail_mutate_travel_mark(uuid,text,text,text,text,bigint,uuid) to authenticated;
grant execute on function public.daytrail_collab_mutate_travel_mark(uuid,uuid,text,text,text,bigint,uuid) to authenticated;
commit;
