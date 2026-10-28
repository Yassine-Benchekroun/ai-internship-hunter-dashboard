-- Phase 1 verification script.
-- Run this in Supabase SQL Editor after the migration. It is wrapped in a
-- transaction and rolls back all fixture rows, so it does not modify data.
-- It uses the existing project owner UUID only to satisfy the user foreign key.

begin;

do $$
declare
  owner_id uuid := '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid;
  fact_count integer;
  docker_fact_id uuid;
  docker_status text;
  docker_verified_at timestamptz;
  docker_reverified_at timestamptz;
  opportunity_id uuid;
  score_opportunity_id uuid;
  duplicate_opportunity_id uuid;
  opportunity_dedupe_key text;
  opportunity_count integer;
  application_id uuid;
  ingestion_event_id bigint;
  first_discovered timestamptz;
  last_checked timestamptz;
  current_classification text;
  current_application_status text;
  score_initial integer;
  score_current integer;
  score_match integer;
  score_active_sections text[];
  threshold_classification text;
  ready_sent boolean;
begin
  if not exists (select 1 from auth.users where id = owner_id) then
    raise exception 'The configured dashboard owner UUID does not exist in auth.users.';
  end if;

  if public.normalize_profile_name('skill', 'Python') <> public.normalize_profile_name('skills', ' python ')
     or public.normalize_profile_name('skills', 'PYTHON') <> 'python'
     or public.normalize_profile_name('technology', 'Open CV') <> public.normalize_profile_name('technology', 'opencv-python')
     or public.normalize_profile_name('skill', 'sklearn') <> 'scikit-learn' then
    raise exception 'Profile normalization test failed.';
  end if;

  if public.classify_opportunity_score(74, 70) <> 'top'
     or public.classify_opportunity_score(70, 70) <> 'top'
     or public.classify_opportunity_score(68, 70) <> 'lower'
     or public.classify_opportunity_score(62, 70) <> 'lower' then
    raise exception 'Threshold classification test failed.';
  end if;

  if not has_function_privilege('authenticated', 'public.classify_opportunity_score(integer,integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.opportunity_dedupe_key(text,text,text)', 'EXECUTE') then
    raise exception 'Authenticated trigger helper privileges are missing.';
  end if;

  insert into public.profile_facts (user_id, category, name, verification_status)
  values (owner_id, 'skills', 'Python', 'verified')
  on conflict (user_id, category, normalized_name) do nothing;
  insert into public.profile_facts (user_id, category, name, verification_status)
  values (owner_id, 'skills', 'python', 'verified')
  on conflict (user_id, category, normalized_name) do nothing;
  insert into public.profile_facts (user_id, category, name, verification_status)
  values (owner_id, 'skills', 'PYTHON', 'verified')
  on conflict (user_id, category, normalized_name) do nothing;
  select count(*) into fact_count
  from public.profile_facts
  where user_id = owner_id and category = 'skills' and normalized_name = 'python';
  if fact_count <> 1 then
    raise exception 'Python deduplication test failed; count was %.', fact_count;
  end if;

  insert into public.profile_facts (user_id, category, name, verification_status)
  values (owner_id, 'skills', 'FastAPI', 'verified')
  on conflict (user_id, category, normalized_name) do nothing;
  select count(*) into fact_count
  from public.profile_facts
  where user_id = owner_id and category = 'skills' and normalized_name = 'fastapi';
  if fact_count <> 1 then
    raise exception 'New FastAPI fact test failed; count was %.', fact_count;
  end if;

  insert into public.profile_facts (user_id, category, name, verification_status)
  values (owner_id, 'technologies', 'Docker', 'verified')
  on conflict (user_id, category, normalized_name)
  do update set verification_status = 'verified'
  returning id into docker_fact_id;
  select last_verified_at into docker_verified_at
  from public.profile_facts
  where id = docker_fact_id;
  update public.profile_facts
  set verification_status = 'source_missing'
  where id = docker_fact_id;
  select verification_status into docker_status
  from public.profile_facts
  where id = docker_fact_id;
  if docker_status <> 'source_missing' then
    raise exception 'Source-missing retention test failed.';
  end if;
  perform pg_sleep(0.01);
  update public.profile_facts
  set verification_status = 'verified'
  where id = docker_fact_id;
  select last_verified_at into docker_reverified_at
  from public.profile_facts
  where id = docker_fact_id;
  select count(*), max(verification_status) into fact_count, docker_status
  from public.profile_facts
  where id = docker_fact_id;
  -- now() is stable for the surrounding rollback transaction, so equality is
  -- valid here; separate production sync transactions receive fresh times.
  if fact_count <> 1 or docker_status <> 'verified'
     or docker_reverified_at is null or docker_verified_at is null
     or docker_reverified_at < docker_verified_at then
    raise exception 'Profile verification timestamp refresh test failed.';
  end if;

  -- Persisted score behavior: a bridge-style match_score-only insert fills
  -- the normalized score fields and derives classification from threshold 70.
  insert into public.opportunity_records (
    user_id, dedupe_key, organization, position, source_url, match_score
  ) values (
    owner_id,
    public.opportunity_dedupe_key('https://example.com/opportunity/score', 'Phase 1 Score Org', 'AI Score Intern'),
    'Phase 1 Score Org', 'AI Score Intern', 'https://example.com/opportunity/score', 74
  ) returning id, initial_score, current_score, match_score, classification, active_sections
  into score_opportunity_id, score_initial, score_current, score_match, current_classification, score_active_sections;
  if score_initial <> 74 or score_current <> 74 or score_match <> 74 or current_classification <> 'top'
     or score_active_sections <> array['top']::text[] then
    raise exception 'Persisted 74-point classification test failed.';
  end if;

  update public.opportunity_records
  set match_score = 70
  where id = score_opportunity_id
  returning current_score, classification, active_sections into score_current, current_classification, score_active_sections;
  if score_current <> 70 or current_classification <> 'top' or score_active_sections <> array['top']::text[] then
    raise exception 'Persisted 70-point classification test failed.';
  end if;

  update public.opportunity_records
  set match_score = 68
  where id = score_opportunity_id
  returning current_score, classification, active_sections into score_current, current_classification, score_active_sections;
  if score_current <> 68 or current_classification <> 'lower' or score_active_sections <> array['lower']::text[] then
    raise exception 'Persisted 68-point classification test failed.';
  end if;

  update public.opportunity_records
  set match_score = 62
  where id = score_opportunity_id
  returning current_score, classification into score_current, current_classification;
  if score_current <> 62 or current_classification <> 'lower' then
    raise exception 'Persisted 62-point classification test failed.';
  end if;

  insert into public.user_settings (user_id, match_threshold)
  values (owner_id, 80)
  on conflict (user_id) do update set match_threshold = excluded.match_threshold;
  insert into public.opportunity_records (
    user_id, dedupe_key, organization, position, source_url, match_score
  ) values (
    owner_id,
    public.opportunity_dedupe_key('https://example.com/opportunity/threshold', 'Phase 1 Threshold Org', 'AI Threshold Intern'),
    'Phase 1 Threshold Org', 'AI Threshold Intern', 'https://example.com/opportunity/threshold', 74
  ) returning classification into threshold_classification;
  if threshold_classification <> 'lower' then
    raise exception 'Backend threshold setting was ignored.';
  end if;

  -- "ready" is not a sent state in the compatibility boolean.
  insert into public.opportunity_records (
    user_id, dedupe_key, organization, position, source_url,
    match_score, application_status
  ) values (
    owner_id,
    public.opportunity_dedupe_key('https://example.com/opportunity/ready', 'Phase 1 Ready Org', 'AI Ready Intern'),
    'Phase 1 Ready Org', 'AI Ready Intern', 'https://example.com/opportunity/ready', 62, 'ready'
  ) returning sent into ready_sent;
  if ready_sent then
    raise exception 'Ready application was incorrectly marked sent.';
  end if;

  opportunity_dedupe_key := public.opportunity_dedupe_key('https://example.com/opportunity/phase1', 'Phase 1 Test Org', 'AI Intern');
  insert into public.opportunity_records (
    user_id, dedupe_key, organization, position, source_url,
    match_score,
    application_status, active, domain_relevant
  ) values (
    owner_id,
    opportunity_dedupe_key,
    'Phase 1 Test Org', 'AI Intern', 'https://example.com/opportunity/phase1',
    68, 'already_sent', true, true
  ) returning id, first_discovered_at, last_checked_at, classification, application_status
  into opportunity_id, first_discovered, last_checked, current_classification, current_application_status;

  if current_classification <> 'lower' or current_application_status <> 'already_sent' then
    raise exception 'Independent classification/application-status test failed.';
  end if;

  -- Constraints are enforced on the previously-existing table as well as on
  -- fresh installs.
  begin
    insert into public.opportunity_records (
      user_id, dedupe_key, organization, position, source_url, initial_score
    ) values (
      owner_id,
      public.opportunity_dedupe_key('https://example.com/opportunity/invalid-score', 'Invalid Score Org', 'AI Intern'),
      'Invalid Score Org', 'AI Intern', 'https://example.com/opportunity/invalid-score', 101
    );
    raise exception 'Out-of-range score was accepted.';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.opportunity_records (
      user_id, dedupe_key, organization, position, source_url, application_status
    ) values (
      owner_id,
      public.opportunity_dedupe_key('https://example.com/opportunity/invalid-status', 'Invalid Status Org', 'AI Intern'),
      'Invalid Status Org', 'AI Intern', 'https://example.com/opportunity/invalid-status', 'bogus'
    );
    raise exception 'Invalid application status was accepted.';
  exception when check_violation then
    null;
  end;

  perform pg_sleep(0.01);
  insert into public.opportunity_records (
    user_id, dedupe_key, organization, position, source_url,
    initial_score, current_score, match_score, classification,
    application_status, active, domain_relevant, description
  ) values (
    owner_id,
    opportunity_dedupe_key,
    'Phase 1 Test Org', 'AI Intern', 'https://example.com/opportunity/phase1',
    68, 68, 68, 'lower', 'already_sent', true, true, 'Updated duplicate fixture'
  )
  on conflict (user_id, dedupe_key)
  do update set last_checked_at = now(), description = excluded.description
  returning id into duplicate_opportunity_id;
  select count(*) into opportunity_count
  from public.opportunity_records
  where user_id = owner_id and dedupe_key = opportunity_dedupe_key;
  if opportunity_count <> 1 or duplicate_opportunity_id <> opportunity_id then
    raise exception 'Duplicate opportunity was inserted instead of updated.';
  end if;
  if not exists (
    select 1 from public.opportunity_records
    where id = opportunity_id
      and first_discovered_at = first_discovered
      and last_checked_at >= last_checked
      and description = 'Updated duplicate fixture'
  ) then
    raise exception 'Duplicate opportunity update/preservation test failed.';
  end if;

  insert into public.application_records (
    user_id, opportunity_id, organization, application_status, sent_at
  ) values (owner_id, opportunity_id, 'Phase 1 Test Org', 'already_sent', now())
  returning id into application_id;
  insert into public.opportunity_ingestion_events (
    request_id, user_id, opportunity_id, dedupe_key, action, source_url,
    status, opportunities_received, opportunities_inserted
  ) values (
    gen_random_uuid(), owner_id, opportunity_id, opportunity_dedupe_key, 'inserted',
    'https://example.com/opportunity/phase1', 'completed', 1, 1
  ) returning id into ingestion_event_id;
  delete from public.opportunity_records where id = opportunity_id;
  if not exists (
    select 1 from public.application_records ar
    where ar.id = application_id and ar.opportunity_id is null
  ) then
    raise exception 'Application history preservation test failed.';
  end if;
  if not exists (
    select 1 from public.opportunity_ingestion_events ie
    where ie.id = ingestion_event_id and ie.opportunity_id is null
  ) then
    raise exception 'Ingestion audit preservation test failed.';
  end if;
end;
$$;

rollback;
