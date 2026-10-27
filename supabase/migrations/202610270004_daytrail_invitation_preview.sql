-- Authenticated recipients can review an invitation without joining the trip.
begin;
create function public.daytrail_collab_preview_invite(p_expected_actor_id uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=daytrail_private.assert_actor(p_expected_actor_id);
  i daytrail_private.invites%rowtype; t public.daytrail_trips%rowtype;
  address text; membership_role text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='Invitation expired or unavailable';
  end if;
  select * into i from daytrail_private.invites where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  if not found then raise exception using errcode='22023',message='Invitation expired or unavailable'; end if;
  -- Match acceptance and membership writes, so revocation cannot race this preview.
  perform pg_advisory_xact_lock(hashtextextended((select owner_id::text from public.daytrail_trips where cloud_trip_id=i.cloud_trip_id),0));
  select * into t from public.daytrail_trips where cloud_trip_id=i.cloud_trip_id and collaboration_enabled for update;
  if not found or t.deleted_at is not null then raise exception using errcode='22023',message='Invitation expired or unavailable'; end if;
  select * into i from daytrail_private.invites where id=i.id;
  select lower(email) into address from auth.users where id=actor and email_confirmed_at is not null;
  if address is null or address<>i.email then raise exception using errcode='42501',message='Sign in with the invited Google account'; end if;
  membership_role:=daytrail_private.collab_role(actor,t);
  if i.cancelled_at is not null or i.expires_at<=now()
    or (i.accepted_at is not null and (i.accepted_by is distinct from actor or membership_role is null)) then
    raise exception using errcode='22023',message='Invitation expired or unavailable';
  end if;
  return jsonb_build_object('trip_name',t.document->>'name','owner_name',coalesce(daytrail_private.collab_name(t.owner_id),'Traveller'),
    'role',case when i.accepted_at is not null then membership_role else i.role end,'email',i.email,'expires_at',i.expires_at);
end;
$$;
revoke all on function public.daytrail_collab_preview_invite(uuid,text) from public,anon,authenticated;
grant execute on function public.daytrail_collab_preview_invite(uuid,text) to authenticated;
commit;
