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

-- automation_sync_profile already performs approved-source validation in the
-- Phase 3 migration. Keep this migration declarative; do not rewrite a
-- function body through dynamic text replacement.

comment on column public.application_records.position is 'Position retained independently of the opportunity link.';
comment on column public.application_records.source_url is 'Source URL retained independently of the opportunity link.';

commit;
