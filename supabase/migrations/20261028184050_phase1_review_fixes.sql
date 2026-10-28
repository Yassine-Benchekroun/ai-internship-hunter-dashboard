-- Phase 1 review fixes.
--
-- This follow-up is safe to apply after the two Phase 1 migrations. It
-- backfills existing rows before tightening constraints, corrects score and
-- application compatibility behavior, and preserves ingestion audit rows when
-- an opportunity is removed.

begin;

create or replace function public.prepare_opportunity_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  threshold integer := 70;
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

  -- The bridge historically writes match_score. Fill the normalized score
  -- fields when a caller leaves them at their compatibility default of zero.
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
    new.classification := public.classify_opportunity_score(new.current_score, threshold);
  else
    new.classification := 'new';
  end if;

  -- Keep the legacy boolean compatible without collapsing the normalized
  -- application status. "ready" explicitly means not sent yet.
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

-- Normalize legacy rows before adding constraints. Existing non-zero values
-- are preserved where possible; out-of-range scores are clamped to 0..100.
with normalized as (
  select
    id,
    least(100, greatest(0, coalesce(nullif(initial_score, 0), nullif(current_score, 0), nullif(match_score, 0), 0))) as normalized_initial,
    least(100, greatest(0, coalesce(nullif(current_score, 0), nullif(match_score, 0), nullif(initial_score, 0), 0))) as normalized_current
  from public.opportunity_records
)
update public.opportunity_records as opportunities
set initial_score = normalized.normalized_initial,
    current_score = normalized.normalized_current,
    match_score = normalized.normalized_current
from normalized
where opportunities.id = normalized.id;

update public.opportunity_records
set application_status = case
  when sent = true then 'already_sent'
  else 'not_sent'
end
where application_status is null
   or application_status not in ('not_sent', 'ready', 'already_sent', 'sent', 'waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'closed');

update public.opportunity_records
set active = coalesce(active, true),
    domain_relevant = coalesce(domain_relevant, false);

-- Recompute persisted classification from the normalized current score. A
-- zero-score row remains in the new bucket until it has been scored.
update public.opportunity_records as opportunities
set classification = case
  when coalesce(opportunities.current_score, 0) > 0 then public.classify_opportunity_score(
    opportunities.current_score,
    coalesce((select settings.match_threshold from public.user_settings settings where settings.user_id = opportunities.user_id), 70)
  )
  else 'new'
end;

alter table public.opportunity_records alter column initial_score set default 0;
alter table public.opportunity_records alter column current_score set default 0;
alter table public.opportunity_records alter column match_score set default 0;
alter table public.opportunity_records alter column classification set default 'new';
alter table public.opportunity_records alter column application_status set default 'not_sent';
alter table public.opportunity_records alter column active set default true;
alter table public.opportunity_records alter column domain_relevant set default false;

alter table public.opportunity_records alter column initial_score set not null;
alter table public.opportunity_records alter column current_score set not null;
alter table public.opportunity_records alter column match_score set not null;
alter table public.opportunity_records alter column classification set not null;
alter table public.opportunity_records alter column application_status set not null;
alter table public.opportunity_records alter column active set not null;
alter table public.opportunity_records alter column domain_relevant set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'opportunity_records_initial_score_check' and conrelid = 'public.opportunity_records'::regclass) then
    alter table public.opportunity_records add constraint opportunity_records_initial_score_check check (initial_score between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opportunity_records_current_score_check' and conrelid = 'public.opportunity_records'::regclass) then
    alter table public.opportunity_records add constraint opportunity_records_current_score_check check (current_score between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opportunity_records_match_score_check' and conrelid = 'public.opportunity_records'::regclass) then
    alter table public.opportunity_records add constraint opportunity_records_match_score_check check (match_score between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opportunity_records_classification_check' and conrelid = 'public.opportunity_records'::regclass) then
    alter table public.opportunity_records add constraint opportunity_records_classification_check check (classification in ('new', 'top', 'lower'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opportunity_records_application_status_check' and conrelid = 'public.opportunity_records'::regclass) then
    alter table public.opportunity_records add constraint opportunity_records_application_status_check check (application_status in ('not_sent', 'ready', 'already_sent', 'sent', 'waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'closed'));
  end if;
end;
$$;

-- Preserve ingestion audit rows if an opportunity is removed. Existing rows are
-- retained and their opportunity_id is nulled by the new FK action.
do $$
declare
  existing_delete_action text;
begin
  select case confdeltype when 'n' then 'set_null' else 'other' end
  into existing_delete_action
  from pg_constraint
  where conname = 'opportunity_ingestion_events_opportunity_id_fkey'
    and conrelid = 'public.opportunity_ingestion_events'::regclass;

  if existing_delete_action = 'other' then
    alter table public.opportunity_ingestion_events
      drop constraint opportunity_ingestion_events_opportunity_id_fkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.opportunity_ingestion_events'::regclass
      and confrelid = 'public.opportunity_records'::regclass
      and contype = 'f'
      and confdeltype = 'n'
  ) then
    alter table public.opportunity_ingestion_events
      add constraint opportunity_ingestion_events_opportunity_id_fkey
      foreign key (opportunity_id)
      references public.opportunity_records(id)
      on delete set null;
  end if;
end;
$$;

commit;
