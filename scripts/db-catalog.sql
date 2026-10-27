-- Catalog metadata only: never read trips, travel marks, auth users or secrets.
-- NOT NULL is checked via attnotnull for compatibility with PostgreSQL 17/18;
-- PostgreSQL 18 additionally duplicates it as a named pg_constraint entry.
select jsonb_build_object(
  'functions',coalesce((select jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
    'returns',pg_get_function_result(p.oid),'language',l.lanname,'volatility',p.provolatile,
    'securityDefiner',p.prosecdef,'config',p.proconfig,
    'sourceHash',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),
    'grants',(select coalesce(jsonb_agg(jsonb_build_object('role',case when a.grantee=0 then 'public' else r.rolname end,'privilege',a.privilege_type,'grantable',a.is_grantable) order by case when a.grantee=0 then 'public' else r.rolname end,a.privilege_type),'[]'::jsonb)
      from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles r on r.oid=a.grantee
      where a.grantee=0 or r.rolname in ('anon','authenticated'))
  ) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where n.nspname='daytrail_private' or n.nspname='public' and p.proname like 'daytrail\_%' escape '\'),'[]'::jsonb),
  'tables',coalesce((select jsonb_agg(jsonb_build_object(
    'name',c.relname,'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,
    'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,false),'validated',k.convalidated) order by k.conname) from pg_constraint k where k.conrelid=c.oid and k.contype<>'n'),
    'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
      'roles',(select jsonb_agg(case when role_oid=0 then 'public' else r.rolname end order by r.rolname) from unnest(p.polroles) role_oid left join pg_roles r on r.oid=role_oid),
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname),'[]'::jsonb) from pg_policy p where p.polrelid=c.oid),
    'grants',(select coalesce(jsonb_agg(jsonb_build_object('role',case when a.grantee=0 then 'public' else r.rolname end,'privilege',a.privilege_type,'grantable',a.is_grantable) order by case when a.grantee=0 then 'public' else r.rolname end,a.privilege_type),'[]'::jsonb)
      from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a left join pg_roles r on r.oid=a.grantee where a.grantee=0 or r.rolname in ('anon','authenticated'))
  ) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'daytrail\_%' escape '\'),'[]'::jsonb)
) as daytrail_catalog, to_regclass('supabase_migrations.schema_migrations') is not null as has_migration_history;
