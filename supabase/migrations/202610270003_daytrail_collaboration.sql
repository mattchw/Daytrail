-- Shared plans use explicit membership, private booking sidecars and revisioned writes.
-- Existing private trips keep the previous save protocol until their owner enables sharing.
begin;
alter table public.daytrail_trips add column cloud_trip_id uuid not null default gen_random_uuid();
alter table public.daytrail_trips add constraint daytrail_cloud_trip_unique unique(cloud_trip_id);
alter table public.daytrail_trips add column collaboration_enabled boolean not null default false;
alter table public.daytrail_trips add column channel_epoch uuid not null default gen_random_uuid();

create table daytrail_private.members (
  cloud_trip_id uuid not null references public.daytrail_trips(cloud_trip_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check(role in ('editor','viewer')),
  created_at timestamptz not null default now(), primary key(cloud_trip_id,user_id)
);
create index daytrail_members_user on daytrail_private.members(user_id,cloud_trip_id);
create table daytrail_private.invites (
  id uuid primary key default gen_random_uuid(),
  cloud_trip_id uuid not null references public.daytrail_trips(cloud_trip_id) on delete cascade,
  email text not null, role text not null check(role in ('editor','viewer')),
  token_hash text not null unique, created_at timestamptz not null default now(),
  expires_at timestamptz not null default(now()+interval '7 days'),
  accepted_by uuid references auth.users(id) on delete set null, accepted_at timestamptz, cancelled_at timestamptz
);
create index daytrail_invites_trip on daytrail_private.invites(cloud_trip_id);
create table daytrail_private.booking_secrets (
  cloud_trip_id uuid primary key references public.daytrail_trips(cloud_trip_id) on delete cascade,
  document jsonb not null default '{}'::jsonb
);
create table daytrail_private.collab_receipts (
  cloud_trip_id uuid not null references public.daytrail_trips(cloud_trip_id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null, request_hash text not null, committed_revision bigint not null,
  created_at timestamptz not null default now(), primary key(cloud_trip_id,actor_id,mutation_id)
);
create table daytrail_private.collab_activity (
  id uuid primary key default gen_random_uuid(),
  cloud_trip_id uuid not null references public.daytrail_trips(cloud_trip_id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null check(kind in ('sharing_enabled','saved','deleted','restored','member_joined','member_changed','member_removed','member_left')),
  revision bigint not null, created_at timestamptz not null default clock_timestamp()
);
create index daytrail_collab_activity_recent on daytrail_private.collab_activity(cloud_trip_id,created_at desc);
-- No client grants exist on these tables, including to their owner through REST.
revoke all on all tables in schema daytrail_private from public,anon,authenticated;

create function daytrail_private.assert_actor(expected uuid) returns uuid language plpgsql stable set search_path='' as $$
declare actor uuid:=auth.uid();
begin
  if actor is null or actor is distinct from expected then raise exception using errcode='42501',message='Daytrail account mismatch'; end if;
  return actor;
end; $$;
create function daytrail_private.collab_role(actor uuid,t public.daytrail_trips) returns text language sql stable set search_path='' as $$
  select case when actor=t.owner_id then 'owner' else (select m.role from daytrail_private.members m where m.cloud_trip_id=t.cloud_trip_id and m.user_id=actor) end;
$$;
create function daytrail_private.lock_shared_trip(actor uuid,id uuid) returns public.daytrail_trips language plpgsql set search_path='' as $$
declare t public.daytrail_trips%rowtype; owner uuid;
begin
  perform daytrail_private.assert_actor(actor);
  select owner_id into owner from public.daytrail_trips where cloud_trip_id=id and collaboration_enabled;
  if owner is null then raise exception using errcode='42501',message='You no longer have access to this shared trip'; end if;
  -- Same account lock as private writes makes the owner's total storage quota atomic.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,0));
  select * into t from public.daytrail_trips where cloud_trip_id=id and collaboration_enabled for update;
  if not found or daytrail_private.collab_role(actor,t) is null then raise exception using errcode='42501',message='You no longer have access to this shared trip'; end if;
  return t;
end; $$;
create function daytrail_private.strip_booking_secrets(v jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb:=v;
begin
  if v ? 'flights' then result:=jsonb_set(result,'{flights}',(select coalesce(jsonb_agg(f-array['bookingReference','privateNotes','departureGate','arrivalGate']),'[]'::jsonb) from jsonb_array_elements(v->'flights') f)); end if;
  if v ? 'stays' then result:=jsonb_set(result,'{stays}',(select coalesce(jsonb_agg(s-array['bookingReference','privateNotes','contact','bookingUrl']),'[]'::jsonb) from jsonb_array_elements(v->'stays') s)); end if;
  return result;
end; $$;
create function daytrail_private.extract_booking_secrets(v jsonb) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('flights',coalesce((select jsonb_object_agg(f->>'id',f-(select array_agg(k) from jsonb_object_keys(f) k where k<>all(array['bookingReference','privateNotes','departureGate','arrivalGate']))) from jsonb_array_elements(coalesce(v->'flights','[]')) f),'{}'::jsonb),
    'stays',coalesce((select jsonb_object_agg(s->>'id',s-(select array_agg(k) from jsonb_object_keys(s) k where k<>all(array['bookingReference','privateNotes','contact','bookingUrl']))) from jsonb_array_elements(coalesce(v->'stays','[]')) s),'{}'::jsonb));
$$;
create function daytrail_private.with_booking_secrets(v jsonb,secrets jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb:=v;
begin
  if v ? 'flights' then result:=jsonb_set(result,'{flights}',(select coalesce(jsonb_agg(f||coalesce(secrets->'flights'->(f->>'id'),'{}')),'[]') from jsonb_array_elements(v->'flights') f)); end if;
  if v ? 'stays' then result:=jsonb_set(result,'{stays}',(select coalesce(jsonb_agg(s||coalesce(secrets->'stays'->(s->>'id'),'{}')),'[]') from jsonb_array_elements(v->'stays') s)); end if;
  return result;
end; $$;
create function daytrail_private.collab_projection(t public.daytrail_trips,actor uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare r text:=daytrail_private.collab_role(actor,t); doc jsonb:=t.document;
begin
  if r is null then raise exception using errcode='42501',message='You no longer have access to this shared trip'; end if;
  if r='owner' then doc:=daytrail_private.with_booking_secrets(doc,(select document from daytrail_private.booking_secrets where cloud_trip_id=t.cloud_trip_id)); end if;
  return jsonb_build_object('cloud_trip_id',t.cloud_trip_id,'owner_id',t.owner_id,'trip_id',t.trip_id,'schema_version',2,'document',doc,'revision',t.revision,'updated_at',t.updated_at,'deleted_at',t.deleted_at,'role',r,'channel_epoch',t.channel_epoch);
end; $$;
create function daytrail_private.collab_name(actor uuid) returns text language sql stable set search_path='' as $$
  select left(coalesce(nullif(btrim(raw_user_meta_data->>'full_name'),''),nullif(split_part(email,'@',1),''),'Traveller'),120) from auth.users where id=actor;
$$;
create function daytrail_private.collab_event(t public.daytrail_trips,actor uuid,kind text) returns void language plpgsql set search_path='' as $$
begin
  insert into daytrail_private.collab_activity(cloud_trip_id,actor_id,kind,revision) values(t.cloud_trip_id,actor,kind,t.revision);
  -- The visible activity feed is bounded and contains no user-entered trip data.
  delete from daytrail_private.collab_activity where id in (select a.id from daytrail_private.collab_activity a where a.cloud_trip_id=t.cloud_trip_id order by a.created_at desc,a.id desc offset 100);
end; $$;

create function public.daytrail_collab_enable(p_expected_actor_id uuid,p_trip_id text,p_expected_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=daytrail_private.assert_actor(p_expected_actor_id); t public.daytrail_trips%rowtype;
begin
  -- Match the previous save protocol's lock order to prevent an old tab racing enable.
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into t from public.daytrail_trips where owner_id=actor and trip_id=p_trip_id for update;
  if not found or t.deleted_at is not null then raise exception using errcode='22023',message='Save this trip to your account before sharing'; end if;
  if t.collaboration_enabled then return jsonb_build_object('status','ok','trip',daytrail_private.collab_projection(t,actor)); end if;
  if p_expected_revision is null or t.revision<>p_expected_revision then return jsonb_build_object('status','conflict','trip',daytrail_private.collab_projection(t,actor)); end if;
  if t.revision>=9007199254740991 then raise exception using errcode='22023',message='Trip revision limit reached'; end if;
  insert into daytrail_private.booking_secrets(cloud_trip_id,document) values(t.cloud_trip_id,daytrail_private.extract_booking_secrets(t.document));
  update public.daytrail_trips set document=daytrail_private.strip_booking_secrets(document),collaboration_enabled=true,schema_version=2,revision=revision+1,updated_at=clock_timestamp() where cloud_trip_id=t.cloud_trip_id returning * into t;
  perform daytrail_private.collab_event(t,actor,'sharing_enabled');
  return jsonb_build_object('status','ok','trip',daytrail_private.collab_projection(t,actor));
end; $$;
create function public.daytrail_collab_list(p_expected_actor_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=daytrail_private.assert_actor(p_expected_actor_id);
begin
  return (select coalesce(jsonb_agg(daytrail_private.collab_projection(t,actor) order by t.updated_at desc,t.cloud_trip_id),'[]') from public.daytrail_trips t where t.collaboration_enabled and (t.owner_id=actor or exists(select 1 from daytrail_private.members m where m.cloud_trip_id=t.cloud_trip_id and m.user_id=actor)));
end; $$;
create function public.daytrail_collab_get(p_expected_actor_id uuid,p_cloud_trip_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
begin return daytrail_private.collab_projection(t,p_expected_actor_id); end; $$;
create function public.daytrail_collab_mutate(p_expected_actor_id uuid,p_cloud_trip_id uuid,p_expected_revision bigint,p_mutation_id uuid,p_operation text,p_document jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
  r text:=daytrail_private.collab_role(p_expected_actor_id,t); receipt daytrail_private.collab_receipts%rowtype; hash text; shared jsonb; secrets jsonb;
begin
  -- Check current permission before acknowledging even an exact retry.
  if r='viewer' or (p_operation in ('delete','restore') and r<>'owner') then raise exception using errcode='42501',message='You do not have permission to edit this shared trip'; end if;
  if p_mutation_id is null or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740990 or p_operation is null or p_operation not in ('save','delete','restore')
    or (p_operation='save' and not daytrail_private.valid_document(p_document,t.trip_id)) or (p_operation<>'save' and p_document is not null) then raise exception using errcode='22023',message='Invalid shared trip update'; end if;
  if p_operation='save' then
    shared:=daytrail_private.strip_booking_secrets(p_document);
    if r<>'owner' and shared is distinct from p_document then raise exception using errcode='42501',message='Private booking fields belong to the trip owner'; end if;
  end if;
  hash:=encode(sha256(convert_to(jsonb_build_object('revision',p_expected_revision,'operation',p_operation,'document',p_document)::text,'UTF8')),'hex');
  select * into receipt from daytrail_private.collab_receipts where cloud_trip_id=p_cloud_trip_id and actor_id=p_expected_actor_id and mutation_id=p_mutation_id;
  if found then
    if receipt.request_hash<>hash then raise exception using errcode='22023',message='Mutation ID was reused'; end if;
    return jsonb_build_object('status','ok','trip',daytrail_private.collab_projection(t,p_expected_actor_id),'committed_revision',receipt.committed_revision,'replayed',true);
  end if;
  if t.revision<>p_expected_revision or (p_operation in ('save','delete') and t.deleted_at is not null) or (p_operation='restore' and t.deleted_at is null) then
    return jsonb_build_object('status','conflict','trip',daytrail_private.collab_projection(t,p_expected_actor_id));
  end if;
  if p_operation='save' then
    if r='owner' then secrets:=daytrail_private.extract_booking_secrets(p_document);
    else select document into secrets from daytrail_private.booking_secrets where cloud_trip_id=t.cloud_trip_id;
      -- Keep only still-existing booking IDs; a later re-created ID must not resurrect old private fields.
      secrets:=daytrail_private.extract_booking_secrets(daytrail_private.with_booking_secrets(shared,secrets));
    end if;
    if (select coalesce(sum(octet_length(p.document::text)),0) from public.daytrail_trips p where p.owner_id=t.owner_id and p.cloud_trip_id<>t.cloud_trip_id)
      +(select coalesce(sum(octet_length(s.document::text)),0) from daytrail_private.booking_secrets s join public.daytrail_trips p using(cloud_trip_id) where p.owner_id=t.owner_id and p.cloud_trip_id<>t.cloud_trip_id)
      +octet_length(shared::text)+octet_length(secrets::text)>4194304 then raise exception using errcode='22023',message='Daytrail cloud quota exceeded'; end if;
    update daytrail_private.booking_secrets set document=secrets where cloud_trip_id=t.cloud_trip_id;
  end if;
  update public.daytrail_trips set document=case when p_operation='save' then shared else document end,revision=revision+1,updated_at=clock_timestamp(),deleted_at=case when p_operation='delete' then clock_timestamp() when p_operation='restore' then null else deleted_at end where cloud_trip_id=t.cloud_trip_id returning * into t;
  insert into daytrail_private.collab_receipts(cloud_trip_id,actor_id,mutation_id,request_hash,committed_revision) values(t.cloud_trip_id,p_expected_actor_id,p_mutation_id,hash,t.revision);
  perform daytrail_private.collab_event(t,p_expected_actor_id,case p_operation when 'save' then 'saved' when 'delete' then 'deleted' else 'restored' end);
  return jsonb_build_object('status','ok','trip',daytrail_private.collab_projection(t,p_expected_actor_id),'committed_revision',t.revision,'replayed',false);
end; $$;

-- Keep the old function available only behind a gate. Its receipts cannot bypass sharing.
alter function public.daytrail_mutate_trip(uuid,text,bigint,uuid,text,jsonb,integer) rename to mutate_private_trip_v2;
alter function public.mutate_private_trip_v2(uuid,text,bigint,uuid,text,jsonb,integer) set schema daytrail_private;
create function public.daytrail_mutate_trip(p_expected_owner_id uuid,p_trip_id text,p_expected_revision bigint,p_mutation_id uuid,p_operation text,p_document jsonb default null,p_schema_version integer default 1) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=daytrail_private.assert_actor(p_expected_owner_id); t public.daytrail_trips%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  select * into t from public.daytrail_trips where owner_id=actor and trip_id=p_trip_id for update;
  if found and t.collaboration_enabled then raise exception using errcode='0A000',message='Reload Daytrail to use collaborative saving for this trip'; end if;
  if p_operation in ('create','save') and p_document is not null and
    (select coalesce(sum(octet_length(document::text)),0) from public.daytrail_trips where owner_id=actor and trip_id<>p_trip_id)
    +(select coalesce(sum(octet_length(s.document::text)),0) from daytrail_private.booking_secrets s join public.daytrail_trips p using(cloud_trip_id) where p.owner_id=actor)
    +octet_length(p_document::text)>4194304 then raise exception using errcode='22023',message='Daytrail cloud quota exceeded'; end if;
  return daytrail_private.mutate_private_trip_v2(p_expected_owner_id,p_trip_id,p_expected_revision,p_mutation_id,p_operation,p_document,p_schema_version);
end; $$;

create function public.daytrail_collab_people(p_expected_actor_id uuid,p_cloud_trip_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id); members jsonb; invitations jsonb:='[]';
begin
  select jsonb_agg(v order by v->>'role',v->>'display_name',v->>'user_id') into members from (
    select jsonb_build_object('user_id',t.owner_id,'role','owner','display_name',daytrail_private.collab_name(t.owner_id)) v
    union all select jsonb_build_object('user_id',m.user_id,'role',m.role,'display_name',daytrail_private.collab_name(m.user_id)) from daytrail_private.members m where m.cloud_trip_id=t.cloud_trip_id) people;
  if t.owner_id=p_expected_actor_id then select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'expires_at',i.expires_at,'created_at',i.created_at) order by i.created_at desc),'[]') into invitations from daytrail_private.invites i where i.cloud_trip_id=t.cloud_trip_id and i.accepted_at is null and i.cancelled_at is null and i.expires_at>now(); end if;
  return jsonb_build_object('members',members,'invitations',invitations);
end; $$;
create function public.daytrail_collab_invite(p_expected_actor_id uuid,p_cloud_trip_id uuid,p_email text,p_role text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
  address text:=lower(btrim(p_email)); token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''); i daytrail_private.invites%rowtype;
begin
  if t.owner_id<>p_expected_actor_id then raise exception using errcode='42501',message='Only the owner can invite people'; end if;
  if t.deleted_at is not null or p_role is null or p_role not in ('editor','viewer') or address is null or length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception using errcode='22023',message='Enter an email address and a viewer or editor role'; end if;
  if exists(select 1 from auth.users u where u.id=t.owner_id and lower(u.email)=address) then raise exception using errcode='22023',message='You already own this trip'; end if;
  if exists(select 1 from daytrail_private.members m join auth.users u on u.id=m.user_id where m.cloud_trip_id=t.cloud_trip_id and lower(u.email)=address) then raise exception using errcode='22023',message='This person is already a member'; end if;
  if (select count(*) from daytrail_private.members where cloud_trip_id=t.cloud_trip_id)>=100 or (select count(*) from daytrail_private.invites where cloud_trip_id=t.cloud_trip_id and cancelled_at is null and accepted_at is null and expires_at>now())>=100 then raise exception using errcode='22023',message='This trip has reached its invitation limit'; end if;
  -- Reissuing a link for one address cancels all older pending links for that address.
  update daytrail_private.invites set cancelled_at=clock_timestamp() where cloud_trip_id=t.cloud_trip_id and email=address and accepted_at is null and cancelled_at is null;
  insert into daytrail_private.invites(cloud_trip_id,email,role,token_hash) values(t.cloud_trip_id,address,p_role,encode(sha256(convert_to(token,'UTF8')),'hex')) returning * into i;
  return jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'expires_at',i.expires_at,'token',token);
end; $$;
create function public.daytrail_collab_cancel_invite(p_expected_actor_id uuid,p_cloud_trip_id uuid,p_invitation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
begin
  if t.owner_id<>p_expected_actor_id then raise exception using errcode='42501',message='Only the owner can cancel invitations'; end if;
  update daytrail_private.invites set cancelled_at=coalesce(cancelled_at,clock_timestamp()) where cloud_trip_id=t.cloud_trip_id and id=p_invitation_id and accepted_at is null;
  return jsonb_build_object('status','ok');
end; $$;
create function public.daytrail_collab_accept(p_expected_actor_id uuid,p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=daytrail_private.assert_actor(p_expected_actor_id); i daytrail_private.invites%rowtype; t public.daytrail_trips%rowtype; address text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='Invitation expired or unavailable'; end if;
  select * into i from daytrail_private.invites where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  if not found then raise exception using errcode='22023',message='Invitation expired or unavailable'; end if;
  -- Lock the trip before its invitation so acceptance, revocation and saves serialize.
  perform pg_advisory_xact_lock(hashtextextended((select owner_id::text from public.daytrail_trips where cloud_trip_id=i.cloud_trip_id),0));
  select * into t from public.daytrail_trips where cloud_trip_id=i.cloud_trip_id and collaboration_enabled for update;
  if not found or t.deleted_at is not null then raise exception using errcode='22023',message='Invitation expired or unavailable'; end if;
  select * into i from daytrail_private.invites where id=i.id for update;
  select lower(email) into address from auth.users where id=actor and email_confirmed_at is not null;
  if address is null or address<>i.email then raise exception using errcode='42501',message='Sign in with the invited Google account'; end if;
  if i.accepted_by=actor and i.accepted_at is not null and daytrail_private.collab_role(actor,t) is not null then return daytrail_private.collab_projection(t,actor); end if;
  if i.cancelled_at is not null or i.expires_at<=now() or i.accepted_at is not null then raise exception using errcode='22023',message='Invitation expired or unavailable'; end if;
  if actor=t.owner_id or (select count(*) from daytrail_private.members where cloud_trip_id=t.cloud_trip_id)>=100 then raise exception using errcode='22023',message='This trip cannot accept another member'; end if;
  insert into daytrail_private.members(cloud_trip_id,user_id,role) values(t.cloud_trip_id,actor,i.role) on conflict(cloud_trip_id,user_id) do nothing;
  update daytrail_private.invites set accepted_by=actor,accepted_at=clock_timestamp() where id=i.id;
  update public.daytrail_trips set channel_epoch=gen_random_uuid() where cloud_trip_id=t.cloud_trip_id returning * into t;
  perform daytrail_private.collab_event(t,actor,'member_joined');
  return daytrail_private.collab_projection(t,actor);
end; $$;
create function public.daytrail_collab_member(p_expected_actor_id uuid,p_cloud_trip_id uuid,p_user_id uuid,p_role text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
begin
  if t.owner_id<>p_expected_actor_id then raise exception using errcode='42501',message='Only the owner can manage people'; end if;
  if p_user_id is null or p_user_id=t.owner_id or (p_role is not null and p_role not in ('editor','viewer')) then raise exception using errcode='22023',message='The owner cannot be removed or downgraded'; end if;
  if p_role is null then delete from daytrail_private.members where cloud_trip_id=t.cloud_trip_id and user_id=p_user_id;
  else update daytrail_private.members set role=p_role where cloud_trip_id=t.cloud_trip_id and user_id=p_user_id; end if;
  if found then
    update public.daytrail_trips set channel_epoch=gen_random_uuid() where cloud_trip_id=t.cloud_trip_id returning * into t;
    perform daytrail_private.collab_event(t,p_expected_actor_id,case when p_role is null then 'member_removed' else 'member_changed' end);
  end if;
  return jsonb_build_object('status','ok');
end; $$;
create function public.daytrail_collab_leave(p_expected_actor_id uuid,p_cloud_trip_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
begin
  if t.owner_id=p_expected_actor_id then raise exception using errcode='22023',message='The trip owner cannot leave their own trip'; end if;
  delete from daytrail_private.members where cloud_trip_id=t.cloud_trip_id and user_id=p_expected_actor_id;
  update public.daytrail_trips set channel_epoch=gen_random_uuid() where cloud_trip_id=t.cloud_trip_id returning * into t;
  perform daytrail_private.collab_event(t,p_expected_actor_id,'member_left');
  return jsonb_build_object('status','ok');
end; $$;
create function public.daytrail_collab_activity(p_expected_actor_id uuid,p_cloud_trip_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'actor_id',a.actor_id,'actor_name',coalesce(daytrail_private.collab_name(a.actor_id),'Traveller'),'kind',a.kind,'revision',a.revision,'created_at',a.created_at) order by a.created_at desc,a.id desc),'[]') from daytrail_private.collab_activity a where a.cloud_trip_id=t.cloud_trip_id);
end; $$;

-- Personal travel marks are keyed by traveller, not the trip owner's identity.
create table daytrail_private.collab_travel_marks (
  cloud_trip_id uuid not null references public.daytrail_trips(cloud_trip_id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  target_id text not null check(daytrail_private.valid_travel_target(target_id)),
  place_id text not null check(daytrail_private.valid_id(place_id)),
  state text not null check(state in ('planned','done','skipped')),
  revision bigint not null check(revision between 1 and 9007199254740991),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(cloud_trip_id,actor_id,target_id), check(split_part(target_id,':',1)<>'end' or state<>'skipped')
);
create table daytrail_private.collab_travel_receipts (
  cloud_trip_id uuid not null references public.daytrail_trips(cloud_trip_id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null, request_hash text not null, mark jsonb not null,
  primary key(cloud_trip_id,actor_id,mutation_id)
);
create function daytrail_private.collab_mark_projection(m daytrail_private.collab_travel_marks) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('owner_id',m.actor_id,'trip_id','collab-'||m.cloud_trip_id::text,'target_id',m.target_id,'place_id',m.place_id,'state',m.state,'revision',m.revision,'updated_at',m.updated_at);
$$;
create function daytrail_private.copy_owner_marks(t public.daytrail_trips) returns void language plpgsql set search_path='' as $$
begin
  insert into daytrail_private.collab_travel_marks(cloud_trip_id,actor_id,target_id,place_id,state,revision,updated_at)
    select t.cloud_trip_id,t.owner_id,target_id,place_id,state,revision,updated_at from public.daytrail_travel_marks where owner_id=t.owner_id and trip_id=t.trip_id on conflict do nothing;
end; $$;
create function public.daytrail_collab_list_travel_marks(p_expected_actor_id uuid,p_cloud_trip_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
begin
  if t.deleted_at is not null then raise exception using errcode='22023',message='Daytrail trip is unavailable'; end if;
  if t.owner_id=p_expected_actor_id then perform daytrail_private.copy_owner_marks(t); end if;
  return (select coalesce(jsonb_agg(daytrail_private.collab_mark_projection(m) order by m.target_id),'[]') from daytrail_private.collab_travel_marks m where m.cloud_trip_id=t.cloud_trip_id and m.actor_id=p_expected_actor_id);
end; $$;
create function public.daytrail_collab_mutate_travel_mark(p_expected_actor_id uuid,p_cloud_trip_id uuid,p_target_id text,p_place_id text,p_state text,p_expected_revision bigint,p_mutation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.daytrail_trips%rowtype:=daytrail_private.lock_shared_trip(p_expected_actor_id,p_cloud_trip_id);
  m daytrail_private.collab_travel_marks%rowtype; receipt daytrail_private.collab_travel_receipts%rowtype; present boolean; actual text; hash text; target text:=split_part(p_target_id,':',2);
begin
  if t.deleted_at is not null then raise exception using errcode='22023',message='Daytrail trip is unavailable'; end if;
  if not daytrail_private.valid_travel_target(p_target_id) or not daytrail_private.valid_id(p_place_id) or p_state is null or p_state not in ('planned','done','skipped') or (split_part(p_target_id,':',1)='end' and p_state='skipped') or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990 or p_mutation_id is null then raise exception using errcode='22023',message='Invalid travel update'; end if;
  if split_part(p_target_id,':',1)='activity' then select a->>'placeId' into actual from jsonb_array_elements(t.document->'days') d cross join lateral jsonb_array_elements(d->'items') a where a->>'aid'=target;
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

-- Only minimal invalidations go through Realtime; clients refetch through the authorised RPC.
create function public.daytrail_collab_can_receive(p_topic text) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.daytrail_trips t where t.collaboration_enabled and 'daytrail:'||t.cloud_trip_id::text||':'||t.channel_epoch::text=p_topic and daytrail_private.collab_role(auth.uid(),t) is not null);
$$;
create function daytrail_private.broadcast_collab_change() returns trigger language plpgsql security definer set search_path='' as $$
declare topic text; payload jsonb;
begin
  if not new.collaboration_enabled then return new; end if;
  payload:=jsonb_build_object('cloud_trip_id',new.cloud_trip_id,'revision',new.revision);
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    topic:='daytrail:'||new.cloud_trip_id::text||':'||new.channel_epoch::text;
    execute 'select realtime.send($1,$2,$3,$4)' using payload,'trip_changed',topic,true;
    if tg_op='UPDATE' and old.channel_epoch is distinct from new.channel_epoch and old.collaboration_enabled then
      -- One final invalidation moves remaining members onto the new channel and tells removed members to refresh access.
      execute 'select realtime.send($1,$2,$3,$4)' using payload,'trip_changed','daytrail:'||old.cloud_trip_id::text||':'||old.channel_epoch::text,true;
    end if;
  end if;
  return new;
end; $$;
create trigger daytrail_shared_changed after insert or update on public.daytrail_trips for each row execute function daytrail_private.broadcast_collab_change();
do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute 'create policy daytrail_private_broadcast_read on realtime.messages for select to authenticated using (extension = ''broadcast'' and public.daytrail_collab_can_receive(realtime.topic()))';
  end if;
end; $$;

revoke all on all tables in schema daytrail_private from public,anon,authenticated;
revoke all on all functions in schema daytrail_private from public,anon,authenticated;
-- Private-schema tables also default-deny through RLS if a future grant is added.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='daytrail_private' loop
    execute format('alter table daytrail_private.%I enable row level security',t.tablename);
  end loop;
end; $$;
-- Only explicit, actor-checking RPCs are available to browser clients.
do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'daytrail_collab_%' or proname='daytrail_mutate_trip') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end; $$;
comment on column public.daytrail_trips.collaboration_enabled is 'Permanent protocol boundary: legacy whole-trip saves must not modify shared plans.';
commit;
