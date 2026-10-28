-- Phase 4 — close the browser/data-contract and source-trust review findings.
-- This migration is additive and keeps all automation functions service-role-only.

begin;

alter table public.application_records add column if not exists position text;
alter table public.application_records add column if not exists country text;
alter table public.application_records add column if not exists source_url text;

create or replace function public.is_approved_profile_source(
  p_user_id uuid,
  p_source_type text,
  p_source_name text,
  p_source_url text
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  with configured as (
    select coalesce(
      (select approved_profile_sources from public.user_settings where user_id = p_user_id),
      '[{"source_type":"github","source_name":"Yassine-Benchekroun","source_url":"https://github.com/Yassine-Benchekroun"},{"source_type":"portfolio","source_name":"Yassine Benchekroun Portfolio","source_url":"https://yassine-benchekroun.github.io"}]'::jsonb
    ) as sources
  )
  select exists (
    select 1
    from configured,
      jsonb_array_elements(case when jsonb_typeof(configured.sources) = 'array' then configured.sources else '[]'::jsonb end) as source
    where lower(trim(coalesce(source->>'source_type', ''))) = lower(trim(coalesce(p_source_type, '')))
      and lower(trim(coalesce(source->>'source_name', ''))) = lower(trim(coalesce(p_source_name, '')))
      and coalesce(public.normalize_opportunity_url(source->>'source_url'), '') = coalesce(public.normalize_opportunity_url(p_source_url), '')
  );
$$;

revoke all on function public.is_approved_profile_source(uuid, text, text, text) from public, anon, authenticated;

do $$
declare
  v_definition text;
  v_updated_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'automation_sync_profile'
    and pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb';

  if v_definition is null then
    raise exception 'automation_sync_profile function is missing';
  end if;

  v_updated_definition := replace(
    v_definition,
    $needle$  v_existing_source_url text;$needle$,
    $replacement$  v_existing_source_url text;
  v_source_approved boolean;$replacement$
  );
  v_updated_definition := replace(
    v_updated_definition,
    $needle$        v_evidence_text := nullif(trim(v_evidence->>'evidence'), '');$needle$,
    $replacement$        v_evidence_text := nullif(trim(v_evidence->>'evidence'), '');
        v_source_approved := public.is_approved_profile_source(v_user_id, v_source_type, v_source_name, v_source_url);
        if not v_source_approved then
          raise exception 'profile evidence source is not approved';
        end if;$replacement$
  );

  if v_updated_definition = v_definition then
    raise exception 'automation_sync_profile source validation patch did not match';
  end if;
  execute v_updated_definition;
end;
$$;

comment on column public.application_records.position is 'Position retained independently of the opportunity link.';
comment on column public.application_records.source_url is 'Source URL retained independently of the opportunity link.';

commit;
