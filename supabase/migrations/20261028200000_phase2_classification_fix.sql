-- Phase 2 runtime fix: keep classified zero-score opportunities aligned with
-- the threshold model while preserving New / Unreviewed records.

begin;

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

  if new.active_sections is null then
    new.active_sections := array['new']::text[];
  end if;

  threshold := coalesce(
    (select settings.match_threshold from public.user_settings settings where settings.user_id = new.user_id),
    70
  );
  if new.active_sections @> array['new']::text[] then
    -- A record remains unreviewed only while it is still in New. Once it has
    -- been classified, even a zero score follows the threshold model.
    calculated_classification := 'new';
  else
    calculated_classification := public.classify_opportunity_score(new.current_score, threshold);
  end if;
  new.classification := calculated_classification;

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

commit;
