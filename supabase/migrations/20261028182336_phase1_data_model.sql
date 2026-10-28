-- AI Internship Hunter — Phase 1 additive data model
--
-- This migration is intentionally non-destructive. It creates the normalized
-- tables needed by future agents while leaving dashboard_state and all existing
-- JSON records intact. Run it after supabase-schema.sql.
--
-- The public dashboard owner is the same immutable UUID used by the existing
-- owner-only policies. No credentials or provider secrets belong in this file.

begin;

create or replace function public.is_dashboard_owner()
returns boolean
language sql
stable
security invoker
parallel safe
as $$
  select (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid;
$$;

revoke all on function public.is_dashboard_owner() from public;
grant execute on function public.is_dashboard_owner() to authenticated;

create or replace function public.normalize_profile_name(p_category text, p_name text)
returns text
language sql
immutable
parallel safe
as $$
  with input_value as (
    select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')) as value,
           lower(regexp_replace(btrim(coalesce(p_category, '')), '\s+', ' ', 'g')) as category
  ),
  compact_value as (
    select value,
           category,
           regexp_replace(value, '[\s_.-]+', '', 'g') as compact
    from input_value
  ),
  canonical_value as (
    select case
      when category in ('skill', 'skills', 'technology', 'technologies', 'library', 'libraries', 'framework', 'frameworks')
        and compact in ('sklearn', 'scikitlearn') then 'scikit-learn'
      when category in ('skill', 'skills', 'technology', 'technologies', 'library', 'libraries', 'framework', 'frameworks')
        and compact in ('opencv', 'opencvpython', 'opencvpy') then 'opencv'
      else value
    end as value
    from compact_value
  )
  select nullif(
    trim(both '-' from regexp_replace(regexp_replace(value, '[^a-z0-9]+', '-', 'g'), '-+', '-', 'g')),
    ''
  )
  from canonical_value;
$$;

create or replace function public.normalize_opportunity_url(p_url text)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(p_url, ''))), '#.*$', ''),
        '^https?://',
        ''
      ),
      '^www\.',
      ''
    ),
    '/+$',
    ''
  );
$$;

create or replace function public.opportunity_dedupe_key(
  p_source_url text,
  p_organization text,
  p_position text
)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions
as $$
  select encode(
    digest(
      public.normalize_opportunity_url(p_source_url)
      || '|' || lower(regexp_replace(btrim(coalesce(p_organization, '')), '\s+', ' ', 'g'))
      || '|' || lower(regexp_replace(btrim(coalesce(p_position, '')), '\s+', ' ', 'g')),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.classify_opportunity_score(
  p_score integer,
  p_threshold integer default 70
)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when coalesce(p_score, 0) >= greatest(0, least(100, coalesce(p_threshold, 70))) then 'top'
    else 'lower'
  end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.prepare_profile_fact()
returns trigger
language plpgsql
as $$
begin
  new.normalized_name := public.normalize_profile_name(new.category, new.name);
  if new.verification_status = 'verified' then
    new.verified := true;
    new.last_verified_at := coalesce(new.last_verified_at, now());
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
as $$
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

  if new.current_score is null then
    new.current_score := coalesce(new.match_score, new.initial_score, 0);
  end if;
  if new.match_score is null then
    new.match_score := coalesce(new.current_score, new.initial_score, 0);
  end if;
  if new.initial_score is null then
    new.initial_score := coalesce(new.current_score, new.match_score, 0);
  end if;

  -- sent is retained as a compatibility field for the current dashboard. The
  -- normalized application_status remains the independent source of truth.
  if new.sent = true and new.application_status = 'not_sent' then
    new.application_status := 'already_sent';
  elsif new.application_status <> 'not_sent' then
    new.sent := true;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- These helpers are implementation details for triggers and server-side
-- ingestion. Keep them out of the public Data API surface.
revoke all on function public.normalize_profile_name(text, text) from public, anon, authenticated;
revoke all on function public.normalize_opportunity_url(text) from public, anon, authenticated;
revoke all on function public.opportunity_dedupe_key(text, text, text) from public, anon, authenticated;
revoke all on function public.classify_opportunity_score(integer, integer) from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.prepare_profile_fact() from public, anon, authenticated;
revoke all on function public.prepare_opportunity_record() from public, anon, authenticated;

-- Opportunity History. Existing columns used by the current bridge are kept;
-- the normalized fields below are additive and are safe for future ingestion.
create table if not exists public.opportunity_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dedupe_key text not null,
  origin text not null default 'automation',
  label text,
  kind text not null default 'internship',
  organization text not null,
  organization_type text,
  contact text,
  professor_researcher text,
  position text not null,
  research_area text,
  lab text,
  country text,
  city text,
  opportunity_type text,
  external_id text,
  source_url text,
  description text,
  requirements jsonb not null default '[]'::jsonb,
  first_discovered_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  initial_score integer not null default 0 check (initial_score between 0 and 100),
  current_score integer not null default 0 check (current_score between 0 and 100),
  match_score integer not null default 0 check (match_score between 0 and 100),
  score_breakdown jsonb not null default '{"technical":0,"projects":0,"topic":0,"education":0,"eligibility":0,"access":0}'::jsonb,
  classification text not null default 'new' check (classification in ('new', 'top', 'lower')),
  application_status text not null default 'not_sent' check (application_status in ('not_sent', 'ready', 'already_sent', 'sent', 'waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'closed')),
  active boolean not null default true,
  active_sections text[] not null default array['new']::text[],
  deadline date,
  funding text,
  funding_status text,
  work_mode text,
  availability text,
  domain_relevant boolean not null default false,
  domain_relevance_reason text,
  verified_skills jsonb not null default '[]'::jsonb,
  missing_skills jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  status text not null default 'Needs review',
  sent boolean not null default false,
  sent_date date,
  cv_version text,
  email_version text,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.opportunity_records add column if not exists organization_type text;
alter table public.opportunity_records add column if not exists professor_researcher text;
alter table public.opportunity_records add column if not exists research_area text;
alter table public.opportunity_records add column if not exists external_id text;
alter table public.opportunity_records add column if not exists source_url text;
alter table public.opportunity_records add column if not exists requirements jsonb not null default '[]'::jsonb;
alter table public.opportunity_records add column if not exists deadline date;
alter table public.opportunity_records add column if not exists funding text;
alter table public.opportunity_records add column if not exists work_mode text;
alter table public.opportunity_records add column if not exists initial_score integer default 0;
alter table public.opportunity_records add column if not exists current_score integer default 0;
alter table public.opportunity_records add column if not exists match_score integer default 0;
alter table public.opportunity_records add column if not exists score_breakdown jsonb not null default '{"technical":0,"projects":0,"topic":0,"education":0,"eligibility":0,"access":0}'::jsonb;
alter table public.opportunity_records add column if not exists classification text default 'new';
alter table public.opportunity_records add column if not exists application_status text default 'not_sent';
alter table public.opportunity_records add column if not exists active boolean default true;
alter table public.opportunity_records add column if not exists active_sections text[] default array['new']::text[];
alter table public.opportunity_records add column if not exists funding_status text;
alter table public.opportunity_records add column if not exists availability text;
alter table public.opportunity_records add column if not exists domain_relevant boolean default false;
alter table public.opportunity_records add column if not exists domain_relevance_reason text;
alter table public.opportunity_records add column if not exists verified_skills jsonb not null default '[]'::jsonb;
alter table public.opportunity_records add column if not exists missing_skills jsonb not null default '[]'::jsonb;
alter table public.opportunity_records add column if not exists projects jsonb not null default '[]'::jsonb;
alter table public.opportunity_records add column if not exists raw_payload jsonb not null default '{}'::jsonb;
alter table public.opportunity_records add column if not exists status text default 'Needs review';
alter table public.opportunity_records add column if not exists sent boolean not null default false;
alter table public.opportunity_records add column if not exists sent_date date;
alter table public.opportunity_records add column if not exists cv_version text;
alter table public.opportunity_records add column if not exists email_version text;
alter table public.opportunity_records add column if not exists summary text;
alter table public.opportunity_records add column if not exists notes text;
alter table public.opportunity_records add column if not exists created_at timestamptz default now();
alter table public.opportunity_records add column if not exists updated_at timestamptz default now();

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
create index if not exists opportunity_records_user_source_url_idx
  on public.opportunity_records (user_id, source_url);
create index if not exists opportunity_records_user_external_id_idx
  on public.opportunity_records (user_id, external_id)
  where external_id is not null and btrim(external_id) <> '';
create index if not exists opportunity_records_user_classification_idx
  on public.opportunity_records (user_id, classification, active);

drop trigger if exists opportunity_records_prepare_trigger on public.opportunity_records;
create trigger opportunity_records_prepare_trigger
before insert or update on public.opportunity_records
for each row execute function public.prepare_opportunity_record();

drop trigger if exists opportunity_records_updated_at_trigger on public.opportunity_records;
create trigger opportunity_records_updated_at_trigger
before update on public.opportunity_records
for each row execute function public.set_updated_at();

-- Application / Sent History is deliberately independent. Removing an
-- opportunity nulls the link but preserves the application record.
create table if not exists public.application_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid references public.opportunity_records(id) on delete set null,
  organization text not null,
  contact text,
  recipient_email text,
  sent_at timestamptz,
  email_subject text,
  email_body text,
  cv_version text,
  email_version text,
  application_status text not null default 'already_sent' check (application_status in ('not_sent', 'ready', 'already_sent', 'sent', 'waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'closed')),
  last_response_at timestamptz,
  follow_up_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.application_records add column if not exists email_body text;
alter table public.application_records add column if not exists last_response_at timestamptz;
alter table public.application_records add column if not exists follow_up_at timestamptz;
alter table public.application_records add column if not exists created_at timestamptz default now();
alter table public.application_records add column if not exists updated_at timestamptz default now();

create index if not exists application_records_user_status_idx
  on public.application_records (user_id, application_status, sent_at desc);
create index if not exists application_records_opportunity_idx
  on public.application_records (user_id, opportunity_id);

drop trigger if exists application_records_updated_at_trigger on public.application_records;
create trigger application_records_updated_at_trigger
before update on public.application_records
for each row execute function public.set_updated_at();

-- Verified Profile Registry. A fact survives source disappearance; the sync
-- agent changes verification_status instead of deleting the fact.
create table if not exists public.profile_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  name text not null,
  normalized_name text not null,
  description text,
  verified boolean not null default false,
  verification_status text not null default 'needs_review' check (verification_status in ('verified', 'needs_review', 'source_missing', 'unverified', 'rejected')),
  first_detected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category, normalized_name)
);

create index if not exists profile_facts_user_status_idx
  on public.profile_facts (user_id, verification_status);

drop trigger if exists profile_facts_prepare_trigger on public.profile_facts;
create trigger profile_facts_prepare_trigger
before insert or update of category, name, verification_status, verified, last_verified_at
on public.profile_facts
for each row execute function public.prepare_profile_fact();

create table if not exists public.profile_fact_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact_id uuid not null references public.profile_facts(id) on delete cascade,
  source_type text not null,
  source_name text not null,
  source_url text,
  evidence text,
  first_detected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profile_fact_evidence_dedupe_uidx
  on public.profile_fact_evidence (fact_id, source_type, source_name, coalesce(source_url, ''));
create index if not exists profile_fact_evidence_user_fact_idx
  on public.profile_fact_evidence (user_id, fact_id);
create index if not exists profile_fact_evidence_fact_idx
  on public.profile_fact_evidence (fact_id);

drop trigger if exists profile_fact_evidence_updated_at_trigger on public.profile_fact_evidence;
create trigger profile_fact_evidence_updated_at_trigger
before update on public.profile_fact_evidence
for each row execute function public.set_updated_at();

create table if not exists public.profile_sync_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('pending', 'running', 'completed', 'partial', 'failed')),
  sources_checked jsonb not null default '[]'::jsonb,
  records_discovered integer not null default 0 check (records_discovered >= 0),
  records_inserted integer not null default 0 check (records_inserted >= 0),
  records_updated integer not null default 0 check (records_updated >= 0),
  duplicates_ignored integer not null default 0 check (duplicates_ignored >= 0),
  records_needing_review integer not null default 0 check (records_needing_review >= 0),
  errors jsonb not null default '[]'::jsonb,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profile_sync_runs_user_started_idx
  on public.profile_sync_runs (user_id, started_at desc);

drop trigger if exists profile_sync_runs_updated_at_trigger on public.profile_sync_runs;
create trigger profile_sync_runs_updated_at_trigger
before update on public.profile_sync_runs
for each row execute function public.set_updated_at();

-- Targeted CV and email artifacts are versioned rows, never overwrite-only
-- fields on an opportunity. A partial unique index permits one current version.
create table if not exists public.cv_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid references public.opportunity_records(id) on delete set null,
  version integer not null check (version > 0),
  is_current boolean not null default false,
  change_summary text,
  content text,
  file_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cv_versions_user_opportunity_version_uidx
  on public.cv_versions (user_id, opportunity_id, version)
  where opportunity_id is not null;
create unique index if not exists cv_versions_one_current_uidx
  on public.cv_versions (user_id, opportunity_id)
  where opportunity_id is not null and is_current = true;
create index if not exists cv_versions_opportunity_idx
  on public.cv_versions (opportunity_id);
create index if not exists cv_versions_user_idx
  on public.cv_versions (user_id);

drop trigger if exists cv_versions_updated_at_trigger on public.cv_versions;
create trigger cv_versions_updated_at_trigger
before update on public.cv_versions
for each row execute function public.set_updated_at();

create table if not exists public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid references public.opportunity_records(id) on delete set null,
  application_id uuid references public.application_records(id) on delete set null,
  recipient text,
  subject text,
  body text not null default '',
  version integer not null check (version > 0),
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists email_drafts_user_opportunity_version_uidx
  on public.email_drafts (user_id, opportunity_id, version)
  where opportunity_id is not null;
create unique index if not exists email_drafts_one_current_uidx
  on public.email_drafts (user_id, opportunity_id)
  where opportunity_id is not null and is_current = true;
create index if not exists email_drafts_application_idx
  on public.email_drafts (user_id, application_id);
create index if not exists email_drafts_opportunity_idx
  on public.email_drafts (opportunity_id);
create index if not exists email_drafts_application_id_idx
  on public.email_drafts (application_id);

drop trigger if exists email_drafts_updated_at_trigger on public.email_drafts;
create trigger email_drafts_updated_at_trigger
before update on public.email_drafts
for each row execute function public.set_updated_at();

-- Backend-driven settings. Sender identity is intentionally separate from a
-- real provider/API connection and cannot imply that mail is connected.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  match_threshold integer not null default 70 check (match_threshold between 0 and 100),
  daily_opportunity_target integer not null default 30 check (daily_opportunity_target between 0 and 1000),
  domain_relevance_enabled boolean not null default true,
  target_countries text[] not null default array['United States', 'France', 'Germany', 'Spain', 'United Arab Emirates', 'Saudi Arabia', 'China', 'Japan']::text[],
  opportunity_types text[] not null default array['internship', 'research']::text[],
  approved_profile_sources jsonb not null default '[{"source_type":"github","source_name":"Yassine-Benchekroun","source_url":"https://github.com/Yassine-Benchekroun"},{"source_type":"portfolio","source_name":"Yassine Benchekroun Portfolio","source_url":"https://yassine-benchekroun.github.io"}]'::jsonb,
  sender_identity_email text,
  sender_identity_name text,
  provider_connection_status text not null default 'not_connected' check (provider_connection_status in ('not_connected', 'connected', 'revoked', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists user_settings_updated_at_trigger on public.user_settings;
create trigger user_settings_updated_at_trigger
before update on public.user_settings
for each row execute function public.set_updated_at();

-- Ingestion audit records are readable by the owner, but browser clients do
-- not receive insert/update/delete grants. Future server-side functions write
-- these rows using their narrowly scoped service role.
create table if not exists public.opportunity_ingestion_events (
  id bigint generated by default as identity primary key,
  request_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid references public.opportunity_records(id) on delete cascade,
  dedupe_key text,
  action text check (action in ('inserted', 'duplicate_updated')),
  source_url text,
  run_id uuid,
  source_name text,
  received_at timestamptz not null default now(),
  status text not null default 'completed' check (status in ('received', 'completed', 'partial', 'failed')),
  opportunities_received integer not null default 0 check (opportunities_received >= 0),
  opportunities_inserted integer not null default 0 check (opportunities_inserted >= 0),
  opportunities_updated integer not null default 0 check (opportunities_updated >= 0),
  duplicates_ignored integer not null default 0 check (duplicates_ignored >= 0),
  errors jsonb not null default '[]'::jsonb,
  summary text,
  created_at timestamptz not null default now()
);

alter table public.opportunity_ingestion_events add column if not exists run_id uuid;
alter table public.opportunity_ingestion_events add column if not exists source_name text;
alter table public.opportunity_ingestion_events add column if not exists status text default 'completed';
alter table public.opportunity_ingestion_events add column if not exists opportunities_received integer not null default 0;
alter table public.opportunity_ingestion_events add column if not exists opportunities_inserted integer not null default 0;
alter table public.opportunity_ingestion_events add column if not exists opportunities_updated integer not null default 0;
alter table public.opportunity_ingestion_events add column if not exists duplicates_ignored integer not null default 0;
alter table public.opportunity_ingestion_events add column if not exists errors jsonb not null default '[]'::jsonb;
alter table public.opportunity_ingestion_events add column if not exists summary text;
alter table public.opportunity_ingestion_events add column if not exists created_at timestamptz default now();

create index if not exists opportunity_ingestion_events_opportunity_idx
  on public.opportunity_ingestion_events (opportunity_id);

-- Owner-only RLS for all normalized user data. Service-role Edge Functions
-- bypass RLS by design, but remain responsible for their own payload checks.
alter table public.opportunity_records enable row level security;
alter table public.application_records enable row level security;
alter table public.profile_facts enable row level security;
alter table public.profile_fact_evidence enable row level security;
alter table public.profile_sync_runs enable row level security;
alter table public.cv_versions enable row level security;
alter table public.email_drafts enable row level security;
alter table public.user_settings enable row level security;
alter table public.opportunity_ingestion_events enable row level security;

revoke all on table public.opportunity_records, public.application_records,
  public.profile_facts, public.profile_fact_evidence, public.profile_sync_runs,
  public.cv_versions, public.email_drafts, public.user_settings,
  public.opportunity_ingestion_events from anon;
revoke truncate, references, trigger on table public.opportunity_records,
  public.application_records, public.profile_facts, public.profile_fact_evidence,
  public.profile_sync_runs, public.cv_versions, public.email_drafts,
  public.user_settings, public.opportunity_ingestion_events from authenticated;

grant select, insert, update, delete on table public.opportunity_records to authenticated;
grant select, insert, update, delete on table public.application_records to authenticated;
grant select on table public.profile_facts, public.profile_fact_evidence, public.profile_sync_runs to authenticated;
grant select, insert, update, delete on table public.cv_versions, public.email_drafts, public.user_settings to authenticated;
grant select on table public.opportunity_ingestion_events to authenticated;

drop policy if exists "Owner can read their opportunities" on public.opportunity_records;
drop policy if exists "Owner can insert their opportunities" on public.opportunity_records;
drop policy if exists "Owner can update their opportunities" on public.opportunity_records;
drop policy if exists "Owner can delete their opportunities" on public.opportunity_records;
create policy "Owner can read their opportunities" on public.opportunity_records for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can insert their opportunities" on public.opportunity_records for insert to authenticated
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can update their opportunities" on public.opportunity_records for update to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can delete their opportunities" on public.opportunity_records for delete to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

drop policy if exists "Owner can read their applications" on public.application_records;
drop policy if exists "Owner can insert their applications" on public.application_records;
drop policy if exists "Owner can update their applications" on public.application_records;
drop policy if exists "Owner can delete their applications" on public.application_records;
create policy "Owner can read their applications" on public.application_records for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can insert their applications" on public.application_records for insert to authenticated
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can update their applications" on public.application_records for update to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can delete their applications" on public.application_records for delete to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

drop policy if exists "Owner can read their profile facts" on public.profile_facts;
create policy "Owner can read their profile facts" on public.profile_facts for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
drop policy if exists "Owner can read profile fact evidence" on public.profile_fact_evidence;
create policy "Owner can read profile fact evidence" on public.profile_fact_evidence for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
drop policy if exists "Owner can read profile sync runs" on public.profile_sync_runs;
create policy "Owner can read profile sync runs" on public.profile_sync_runs for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

drop policy if exists "Owner can read their CV versions" on public.cv_versions;
drop policy if exists "Owner can insert their CV versions" on public.cv_versions;
drop policy if exists "Owner can update their CV versions" on public.cv_versions;
drop policy if exists "Owner can delete their CV versions" on public.cv_versions;
create policy "Owner can read their CV versions" on public.cv_versions for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can insert their CV versions" on public.cv_versions for insert to authenticated
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can update their CV versions" on public.cv_versions for update to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can delete their CV versions" on public.cv_versions for delete to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

drop policy if exists "Owner can read their email drafts" on public.email_drafts;
drop policy if exists "Owner can insert their email drafts" on public.email_drafts;
drop policy if exists "Owner can update their email drafts" on public.email_drafts;
drop policy if exists "Owner can delete their email drafts" on public.email_drafts;
create policy "Owner can read their email drafts" on public.email_drafts for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can insert their email drafts" on public.email_drafts for insert to authenticated
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can update their email drafts" on public.email_drafts for update to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can delete their email drafts" on public.email_drafts for delete to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

drop policy if exists "Owner can read their settings" on public.user_settings;
drop policy if exists "Owner can insert their settings" on public.user_settings;
drop policy if exists "Owner can update their settings" on public.user_settings;
drop policy if exists "Owner can delete their settings" on public.user_settings;
create policy "Owner can read their settings" on public.user_settings for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can insert their settings" on public.user_settings for insert to authenticated
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can update their settings" on public.user_settings for update to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()))
  with check ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));
create policy "Owner can delete their settings" on public.user_settings for delete to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

drop policy if exists "Owner can read their ingestion events" on public.opportunity_ingestion_events;
create policy "Owner can read their ingestion events" on public.opportunity_ingestion_events for select to authenticated
  using ((select public.is_dashboard_owner()) and user_id = (select auth.uid()));

commit;
