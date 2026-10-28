-- Phase 1 runtime fixes for already-applied deployments.
--
-- This migration is additive and keeps existing rows. It repairs the helper
-- privileges used by browser writes, completes the legacy opportunity columns,
-- keeps classification and active visibility aligned, and refreshes profile
-- verification timestamps.

begin;

alter table public.opportunity_records add column if not exists organization text;
alter table public.opportunity_records add column if not exists position text;
alter table public.opportunity_records add column if not exists source_url text;
alter table public.opportunity_records add column if not exists first_discovered_at timestamptz default now();
alter table public.opportunity_records add column if not exists last_checked_at timestamptz default now();
alter table public.opportunity_records add column if not exists initial_score integer default 0;
alter table public.opportunity_records add column if not exists current_score integer default 0;
alter table public.opportunity_records add column if not exists match_score integer default 0;
alter table public.opportunity_records add column if not exists classification text default 'new';
alter table public.opportunity_records add column if not exists application_status text default 'not_sent';
alter table public.opportunity_records add column if not exists sent boolean default false;
alter table public.opportunity_records add column if not exists active_sections text[] default array['new']::text[];
alter table public.opportunity_records add column if not exists dedupe_key text;

update public.opportunity_records
set dedupe_key = public.opportunity_dedupe_key(source_url, organization, position)
where dedupe_key is null or btrim(dedupe_key) = '';

-- Preserve every existing row while making the identity key unique. The
-- earliest row keeps the canonical key; later legacy duplicates receive a
-- stable suffix and can be merged deliberately later.
with ranked as (
  select
    id,
    dedupe_key,
    row_number() over (
      partition by user_id, dedupe_key
      order by first_discovered_at nulls last, id
    ) as duplicate_rank
  from public.opportunity_records
)
update public.opportunity_records as opportunities
set dedupe_key = ranked.dedupe_key || ':legacy:' || ranked.id::text
from ranked
where opportunities.id = ranked.id
  and ranked.duplicate_rank > 1;

alter table public.opportunity_records alter column dedupe_key set not null;

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'opportunity_records'
      and indexdef ilike '%(user_id, dedupe_key)%'
      and indexdef ilike '%unique%'
  ) then
    create unique index opportunity_records_user_dedupe_key_uidx
      on public.opportunity_records (user_id, dedupe_key);
  end if;
end;
$$;

create or replace function public.prepare_profile_fact()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.normalized_name := public.normalize_profile_name(new.category, new.name);
  if new.verification_status = 'verified' then
    new.verified := true;
    if tg_op = 'UPDATE' then
      new.last_verified_at := now();
    else
      new.last_verified_at := coalesce(new.last_verified_at, now());
    end if;
  elsif new.verification_status in ('needs_review', 'source_missing', 'unverified', 'rejected') then
    new.verified := false;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.prepare_opportunity_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  threshold integer := 70;
  calculated_classification text;
begin
  if new.dedupe_key is null or btrim(new.dedupe_key) = '' then
    new.dedupe_key := public.opportunity_dedupe_key(new.source_url, new.organization, new.position);
  end if;

  if new.first_discovered_at is null then
    new.first_discovered_at := now();
  end if;
  if new.last_checked_at is null then
    new.last_checked_at := now();
  end if;

  -- The browser bridge writes match_score. On updates, treat a changed
  -- match_score as the incoming current score; direct current_score changes
  -- are mirrored back to the compatibility field.
  if tg_op = 'UPDATE' and new.match_score is distinct from old.match_score
     and new.current_score is not distinct from old.current_score then
    new.current_score := new.match_score;
  elsif tg_op = 'UPDATE' and new.current_score is distinct from old.current_score then
    new.match_score := new.current_score;
  end if;

  if new.current_score is null or (new.current_score = 0 and coalesce(new.match_score, 0) > 0) then
    new.current_score := coalesce(new.match_score, new.initial_score, 0);
  end if;
  if new.initial_score is null or (new.initial_score = 0 and coalesce(new.current_score, 0) > 0) then
    new.initial_score := coalesce(new.match_score, new.current_score, 0);
  end if;
  if new.match_score is null or (new.match_score = 0 and coalesce(new.current_score, 0) > 0) then
    new.match_score := coalesce(new.current_score, new.initial_score, 0);
  end if;

  threshold := coalesce(
    (select settings.match_threshold from public.user_settings settings where settings.user_id = new.user_id),
    70
  );
  if coalesce(new.current_score, 0) > 0 then
    calculated_classification := public.classify_opportunity_score(new.current_score, threshold);
  else
    calculated_classification := 'new';
  end if;
  new.classification := calculated_classification;

  if new.active_sections is null then
    new.active_sections := array['new']::text[];
  end if;
  if tg_op = 'INSERT' and new.active_sections = array['new']::text[] then
    new.active_sections := array[calculated_classification]::text[];
  elsif tg_op = 'UPDATE' then
    if calculated_classification is distinct from old.classification
       and (
         new.active_sections = array['new']::text[]
         or new.active_sections = array[old.classification]::text[]
       ) then
      new.active_sections := array[calculated_classification]::text[];
    end if;
  end if;

  if new.application_status = 'ready' then
    new.sent := false;
  elsif new.sent = true and new.application_status = 'not_sent' then
    new.application_status := 'already_sent';
  elsif new.application_status <> 'not_sent' then
    new.sent := true;
  else
    new.sent := false;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.normalize_opportunity_url(text) from public, anon, authenticated;
revoke all on function public.opportunity_dedupe_key(text, text, text) from public, anon, authenticated;
revoke all on function public.classify_opportunity_score(integer, integer) from public, anon, authenticated;
grant execute on function public.normalize_opportunity_url(text) to authenticated;
grant execute on function public.opportunity_dedupe_key(text, text, text) to authenticated;
grant execute on function public.classify_opportunity_score(integer, integer) to authenticated;

commit;
