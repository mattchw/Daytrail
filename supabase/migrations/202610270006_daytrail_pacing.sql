-- Traveller-authored comfort settings and offline references. Provider payloads stay ephemeral.
begin;
alter function daytrail_private.valid_document(jsonb,text) rename to valid_document_v3;
create function daytrail_private.valid_document(v jsonb,expected_id text)
returns boolean language plpgsql stable set search_path='' as $$
declare legacy jsonb:=v-'pace'; days jsonb:='[]'; items jsonb; places jsonb:='{}'; d jsonb; a jsonb; p jsonb; detail jsonb; place_key text;
begin
  if v ? 'pace' and (jsonb_typeof(v->'pace') is distinct from 'string' or not coalesce(v->>'pace'=any(array['relaxed','moderate','active']),false)) then return false; end if;
  if jsonb_typeof(v->'days') is distinct from 'array' or jsonb_typeof(v->'customPlaces') is distinct from 'object' then return false; end if;
  for d in select value from jsonb_array_elements(v->'days') loop
    if d ? 'pace' and (jsonb_typeof(d->'pace') is distinct from 'string' or not coalesce(d->>'pace'=any(array['relaxed','moderate','active']),false)) then return false; end if;
    if jsonb_typeof(d->'items') is distinct from 'array' then return false; end if;
    items:='[]';
    for a in select value from jsonb_array_elements(d->'items') loop
      if a ? 'meal' and (jsonb_typeof(a->'meal') is distinct from 'string' or not coalesce(a->>'meal'=any(array['meal','snack','none']),false)) then return false; end if;
      if a ? 'exposure' and (jsonb_typeof(a->'exposure') is distinct from 'string' or not coalesce(a->>'exposure'=any(array['indoor','outdoor','mixed','unknown']),false)) then return false; end if;
      if a ? 'walkingMeters' and not daytrail_private.valid_number(a->'walkingMeters',0,100000,true) then return false; end if;
      items:=items||jsonb_build_array(a-'meal'-'exposure'-'walkingMeters');
    end loop;
    days:=days||jsonb_build_array(jsonb_set(d-'pace','{items}',items));
  end loop;
  for place_key,p in select key,value from jsonb_each(v->'customPlaces') loop
    if p ? 'offlineDetails' then
      detail:=p->'offlineDetails';
      if not daytrail_private.valid_keys(detail,array['name'],array['name','address','localAddress','hours'])
        or not daytrail_private.valid_text(detail->'name',200,true)
        or (detail ? 'address' and not daytrail_private.valid_text(detail->'address',500))
        or (detail ? 'localAddress' and not daytrail_private.valid_text(detail->'localAddress',500))
        or (detail ? 'hours' and not daytrail_private.valid_text(detail->'hours',1000)) then return false; end if;
    end if;
    places:=places||jsonb_build_object(place_key,p-'offlineDetails');
  end loop;
  legacy:=jsonb_set(jsonb_set(legacy,'{days}',days),'{customPlaces}',places);
  return daytrail_private.valid_document_v3(legacy,expected_id);
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_document_version(v jsonb,expected_id text,schema_version integer)
returns boolean language sql stable set search_path='' as $$
 select case when schema_version=1 then daytrail_private.valid_document_v1(v,expected_id)
 when schema_version=2 then daytrail_private.valid_document(v,expected_id) else false end;
$$;
revoke all on function daytrail_private.valid_document(jsonb,text) from public,anon,authenticated;
revoke all on function daytrail_private.valid_document_v3(jsonb,text) from public,anon,authenticated;
revoke all on function daytrail_private.valid_document_version(jsonb,text,integer) from public,anon,authenticated;
commit;
