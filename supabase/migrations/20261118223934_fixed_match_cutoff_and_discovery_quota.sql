begin;

-- Keep the legacy settings field and function signature for existing callers.
update public.user_settings set match_threshold = 70 where match_threshold <> 70;
alter table public.user_settings add constraint user_settings_fixed_match_threshold check (match_threshold = 70);

create or replace function public.classify_opportunity_score(p_score integer, p_threshold integer default 70)
returns text
language sql immutable parallel safe set search_path = ''
as $$
  select case when coalesce(p_score, 0) >= 70 then 'top' else 'lower' end;
$$;

create or replace function public.prepare_opportunity_record()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.dedupe_key is null or btrim(new.dedupe_key) = '' then
    new.dedupe_key := public.opportunity_dedupe_key(new.source_url, new.organization, new.position);
  end if;
  new.first_discovered_at := coalesce(new.first_discovered_at, now());
  new.last_checked_at := coalesce(new.last_checked_at, now());

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

  new.active_sections := coalesce(new.active_sections, array['new']::text[]);
  if new.active_sections @> array['new']::text[] then
    new.classification := 'new';
  else
    new.classification := public.classify_opportunity_score(new.current_score);
  end if;
  if new.active_sections && array['top','lower']::text[] then
    new.active_sections := array_remove(array_remove(new.active_sections, 'top'), 'lower');
    if new.classification <> 'new' then
      new.active_sections := array_append(new.active_sections, new.classification);
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

-- Reclassify stored scores without changing the scores or restoring hidden cards.
update public.opportunity_records
set classification = public.classify_opportunity_score(current_score)
where not (active_sections @> array['new']::text[])
  and (classification is distinct from public.classify_opportunity_score(current_score)
    or (active_sections @> array['top']::text[] and current_score < 70)
    or (active_sections @> array['lower']::text[] and current_score >= 70));

-- A second ingestion of the same posting in one run shares the event's
-- uniqueness key. Retain the original insertion as proof for the daily count.
create function private.preserve_discovery_insertion_event() returns trigger
language plpgsql set search_path = ''
as $$
begin
  return old;
end;
$$;
revoke all on function private.preserve_discovery_insertion_event() from public, anon, authenticated;

create trigger preserve_discovery_insertion_event before update on public.opportunity_ingestion_events
for each row when (old.source_name = 'opportunity_discovery' and old.action = 'inserted'
  and new.opportunity_id = old.opportunity_id and new.action = 'duplicate_updated')
execute function private.preserve_discovery_insertion_event();

create function public.automation_discovery_daily_count(p_user_id uuid, p_started_at timestamptz)
returns integer
language sql stable security invoker set search_path = ''
as $$
  with local_day as (
    select c.timezone, (p_started_at at time zone c.timezone)::date as day
    from public.schedule_configuration c where c.user_id = p_user_id
  )
  select count(distinct e.opportunity_id)::integer
  from local_day d
  join public.opportunity_ingestion_events e on e.user_id = p_user_id
    and e.received_at >= (d.day::timestamp at time zone d.timezone)
    and e.received_at < ((d.day + 1)::timestamp at time zone d.timezone)
  join public.schedule_runs r on r.run_id = e.request_id and r.user_id = e.user_id
    and r.schedule_type = 'opportunity_discovery' and not r.dry_run
  where e.source_name = 'opportunity_discovery' and e.action = 'inserted';
$$;
revoke all on function public.automation_discovery_daily_count(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.automation_discovery_daily_count(uuid, timestamptz) to service_role;

commit;
