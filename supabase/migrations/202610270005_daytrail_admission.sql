-- User-confirmed admission cutoffs are planning metadata, never copied Google hours.
begin;
alter function daytrail_private.valid_document(jsonb,text) rename to valid_document_v2;
create function daytrail_private.valid_document(v jsonb,expected_id text)
returns boolean language plpgsql stable set search_path='' as $$
declare legacy jsonb:=v; places jsonb:='{}'::jsonb; p jsonb; place_key text; weekday text; cutoff jsonb;
begin
  if jsonb_typeof(v->'customPlaces') is distinct from 'object' then return false; end if;
  for place_key,p in select key,value from jsonb_each(v->'customPlaces') loop
    if p ? 'lastEntryMinutes' then
      if jsonb_typeof(p->'lastEntryMinutes') is distinct from 'object' then return false; end if;
      for weekday,cutoff in select key,value from jsonb_each(p->'lastEntryMinutes') loop
        if weekday !~ '^[0-6]$' or not daytrail_private.valid_number(cutoff,0,1439,true) then return false; end if;
      end loop;
    end if;
    places:=places||jsonb_build_object(place_key,p-'lastEntryMinutes');
  end loop;
  legacy:=jsonb_set(legacy,'{customPlaces}',places);
  return daytrail_private.valid_document_v2(legacy,expected_id);
exception when others then return false;
end;
$$;
create or replace function daytrail_private.valid_document_version(v jsonb,expected_id text,schema_version integer)
returns boolean language sql stable set search_path='' as $$
  select case when schema_version=1 then daytrail_private.valid_document_v1(v,expected_id)
    when schema_version=2 then daytrail_private.valid_document(v,expected_id) else false end;
$$;
revoke all on function daytrail_private.valid_document(jsonb,text) from public,anon,authenticated;
revoke all on function daytrail_private.valid_document_v2(jsonb,text) from public,anon,authenticated;
revoke all on function daytrail_private.valid_document_version(jsonb,text,integer) from public,anon,authenticated;
commit;
