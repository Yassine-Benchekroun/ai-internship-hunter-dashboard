-- Phase 3 — secure automation interfaces.
--
-- These interfaces are for server-side agents only. They are deliberately
-- exposed to service_role, not to anon/authenticated browser clients. The
-- service-role key must remain inside a server-side Edge Function or worker.
-- No schedule or mail sender is created here.

begin;

create or replace function public.automation_read_settings(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_settings public.user_settings%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  select * into v_settings
  from public.user_settings
  where user_id = p_user_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'match_threshold', coalesce(v_settings.match_threshold, 70),
    'daily_opportunity_target', coalesce(v_settings.daily_opportunity_target, 30),
    'domain_relevance_enabled', coalesce(v_settings.domain_relevance_enabled, true),
    'target_countries', coalesce(to_jsonb(v_settings.target_countries), to_jsonb(array['United States', 'France', 'Germany', 'Spain', 'United Arab Emirates', 'Saudi Arabia', 'China', 'Japan']::text[])),
    'opportunity_types', coalesce(to_jsonb(v_settings.opportunity_types), to_jsonb(array['internship', 'research']::text[])),
    'approved_profile_sources', coalesce(v_settings.approved_profile_sources, '[{"source_type":"github","source_name":"Yassine-Benchekroun","source_url":"https://github.com/Yassine-Benchekroun"},{"source_type":"portfolio","source_name":"Yassine Benchekroun Portfolio","source_url":"https://yassine-benchekroun.github.io"}]'::jsonb),
    'sender_identity_email', v_settings.sender_identity_email,
    'sender_identity_name', v_settings.sender_identity_name,
    'provider_connection_status', coalesce(v_settings.provider_connection_status, 'not_connected')
  );
end;
$$;

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

create or replace function public.automation_sync_profile(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid;
  v_run_id uuid := gen_random_uuid();
  v_run_user_id uuid;
  v_facts jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_fact jsonb;
  v_missing_fact jsonb;
  v_evidence jsonb;
  v_category text;
  v_name text;
  v_normalized_name text;
  v_description text;
  v_verification_status text;
  v_source_type text;
  v_source_name text;
  v_source_url text;
  v_evidence_text text;
  v_fact_id uuid;
  v_evidence_id uuid;
  v_existing_description text;
  v_existing_status text;
  v_existing_evidence text;
  v_existing_source_url text;
  v_source_approved boolean;
  v_changed boolean;
  v_started_at timestamptz := now();
  v_completed_at timestamptz;
  v_status text := coalesce(nullif(trim(p_payload->>'status'), ''), 'completed');
  v_summary text := nullif(trim(p_payload->>'summary'), '');
  v_errors jsonb := coalesce(p_payload->'errors', '[]'::jsonb);
  v_records_discovered integer := 0;
  v_records_inserted integer := 0;
  v_records_updated integer := 0;
  v_duplicates_ignored integer := 0;
  v_records_needing_review integer := 0;
begin
  if coalesce(jsonb_typeof(p_payload), '') <> 'object' then
    raise exception 'p_payload must be a JSON object';
  end if;

  v_user_id := nullif(trim(p_payload->>'user_id'), '')::uuid;
  if v_user_id is null then
    raise exception 'user_id is required';
  end if;
  if not exists (select 1 from auth.users where id = v_user_id) then
    raise exception 'user_id does not exist';
  end if;

  if p_payload ? 'run_id' then
    v_run_id := nullif(trim(p_payload->>'run_id'), '')::uuid;
  end if;
  if p_payload ? 'started_at' then
    v_started_at := nullif(trim(p_payload->>'started_at'), '')::timestamptz;
  end if;
  if p_payload ? 'completed_at' then
    v_completed_at := nullif(trim(p_payload->>'completed_at'), '')::timestamptz;
  end if;
  if v_status not in ('pending', 'running', 'completed', 'partial', 'failed') then
    raise exception 'invalid profile sync status';
  end if;
  if jsonb_typeof(v_errors) <> 'array' then
    raise exception 'errors must be an array';
  end if;

  if p_payload ? 'facts' then
    if jsonb_typeof(p_payload->'facts') <> 'array' then
      raise exception 'facts must be an array';
    end if;
    v_facts := p_payload->'facts';
  end if;
  if p_payload ? 'missing_facts' then
    if jsonb_typeof(p_payload->'missing_facts') <> 'array' then
      raise exception 'missing_facts must be an array';
    end if;
    v_missing := p_payload->'missing_facts';
  end if;
  if jsonb_array_length(v_facts) > 500 or jsonb_array_length(v_missing) > 500 then
    raise exception 'profile sync batch is too large';
  end if;
  v_records_discovered := jsonb_array_length(v_facts);

  select user_id into v_run_user_id
  from public.profile_sync_runs
  where run_id = v_run_id
  for update;
  if v_run_user_id is not null and v_run_user_id <> v_user_id then
    raise exception 'run_id belongs to another user';
  end if;
  if v_run_user_id is null then
    insert into public.profile_sync_runs (run_id, user_id, started_at, status)
    values (v_run_id, v_user_id, v_started_at, 'running');
  end if;

  for v_fact in select value from jsonb_array_elements(v_facts) loop
    if jsonb_typeof(v_fact) <> 'object' then
      raise exception 'each profile fact must be an object';
    end if;

    v_category := lower(regexp_replace(trim(coalesce(v_fact->>'category', '')), '\s+', ' ', 'g'));
    v_category := case v_category
      when 'skills' then 'skill'
      when 'technologies' then 'technology'
      when 'libraries' then 'library'
      when 'frameworks' then 'framework'
      else v_category
    end;
    v_name := trim(coalesce(v_fact->>'name', ''));
    v_description := nullif(trim(v_fact->>'description'), '');
    v_verification_status := coalesce(nullif(trim(v_fact->>'verification_status'), ''), 'verified');
    if v_category = '' or v_name = '' then
      raise exception 'profile facts require category and name';
    end if;
    if v_verification_status not in ('verified', 'needs_review', 'source_missing', 'unverified', 'rejected') then
      raise exception 'invalid profile verification status';
    end if;

    v_normalized_name := public.normalize_profile_name(v_category, v_name);
    if v_normalized_name is null then
      raise exception 'profile fact name cannot be empty';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || '|profile|' || v_category || '|' || v_normalized_name, 0));

    select id, description, verification_status
    into v_fact_id, v_existing_description, v_existing_status
    from public.profile_facts
    where user_id = v_user_id
      and category = v_category
      and normalized_name = v_normalized_name
    for update;

    if v_fact_id is null then
      insert into public.profile_facts (user_id, category, name, normalized_name, description, verification_status)
      values (v_user_id, v_category, v_name, v_normalized_name, v_description, v_verification_status)
      returning id into v_fact_id;
      v_records_inserted := v_records_inserted + 1;
    else
      v_changed := v_existing_description is distinct from v_description
        or v_existing_status is distinct from v_verification_status
        or exists (
          select 1 from public.profile_facts
          where id = v_fact_id and name is distinct from v_name
        );
      update public.profile_facts
      set name = v_name,
          description = case when v_fact ? 'description' then v_description else description end,
          verification_status = v_verification_status
      where id = v_fact_id;
      if v_changed then
        v_records_updated := v_records_updated + 1;
      else
        v_duplicates_ignored := v_duplicates_ignored + 1;
      end if;
    end if;

    if v_verification_status in ('needs_review', 'source_missing', 'unverified', 'rejected') then
      v_records_needing_review := v_records_needing_review + 1;
    end if;

    if v_fact ? 'evidence' then
      if jsonb_typeof(v_fact->'evidence') <> 'array' then
        raise exception 'profile evidence must be an array';
      end if;
      for v_evidence in select value from jsonb_array_elements(v_fact->'evidence') loop
        if jsonb_typeof(v_evidence) <> 'object' then
          raise exception 'each profile evidence item must be an object';
        end if;
        v_source_type := nullif(trim(v_evidence->>'source_type'), '');
        v_source_name := nullif(trim(v_evidence->>'source_name'), '');
        v_source_url := nullif(trim(v_evidence->>'source_url'), '');
        v_evidence_text := nullif(trim(v_evidence->>'evidence'), '');
        if v_source_type is null or v_source_name is null then
          raise exception 'profile evidence requires source_type and source_name';
        end if;
        v_source_approved := public.is_approved_profile_source(v_user_id, v_source_type, v_source_name, v_source_url);
        if not v_source_approved then
          raise exception 'profile evidence source is not approved';
        end if;

        select id, evidence, source_url
        into v_evidence_id, v_existing_evidence, v_existing_source_url
        from public.profile_fact_evidence
        where fact_id = v_fact_id
          and source_type = v_source_type
          and source_name = v_source_name
          and coalesce(public.normalize_opportunity_url(source_url), '') = coalesce(public.normalize_opportunity_url(v_source_url), '')
        for update;

        if v_evidence_id is null then
          insert into public.profile_fact_evidence (user_id, fact_id, source_type, source_name, source_url, evidence, last_verified_at)
          values (v_user_id, v_fact_id, v_source_type, v_source_name, v_source_url, v_evidence_text,
            case when v_verification_status = 'verified' then now() else null end);
        else
          update public.profile_fact_evidence
          set source_url = case when v_evidence ? 'source_url' then v_source_url else source_url end,
              evidence = case when v_evidence ? 'evidence' then v_evidence_text else evidence end,
              last_verified_at = case when v_verification_status = 'verified' then now() else last_verified_at end
          where id = v_evidence_id;
        end if;
      end loop;
    end if;
  end loop;

  -- The sync worker explicitly identifies facts that disappeared from an
  -- approved source. This marks them for review and never deletes them.
  for v_missing_fact in select value from jsonb_array_elements(v_missing) loop
    v_category := lower(regexp_replace(trim(coalesce(v_missing_fact->>'category', '')), '\s+', ' ', 'g'));
    v_category := case v_category
      when 'skills' then 'skill'
      when 'technologies' then 'technology'
      when 'libraries' then 'library'
      when 'frameworks' then 'framework'
      else v_category
    end;
    v_name := trim(coalesce(v_missing_fact->>'name', ''));
    v_normalized_name := public.normalize_profile_name(v_category, v_name);
    if v_category = '' or v_name = '' or v_normalized_name is null then
      raise exception 'missing profile facts require category and name';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || '|profile|' || v_category || '|' || v_normalized_name, 0));
    select id, verification_status into v_fact_id, v_existing_status
    from public.profile_facts
    where user_id = v_user_id and category = v_category and normalized_name = v_normalized_name
    for update;
    if v_fact_id is not null and v_existing_status <> 'source_missing' then
      update public.profile_facts set verification_status = 'source_missing' where id = v_fact_id;
      v_records_updated := v_records_updated + 1;
      v_records_needing_review := v_records_needing_review + 1;
    elsif v_fact_id is not null then
      v_duplicates_ignored := v_duplicates_ignored + 1;
    end if;
  end loop;

  if v_completed_at is null and v_status in ('completed', 'partial', 'failed') then
    v_completed_at := now();
  end if;

  update public.profile_sync_runs
  set completed_at = v_completed_at,
      status = v_status,
      sources_checked = case when p_payload ? 'sources_checked' then p_payload->'sources_checked' else sources_checked end,
      records_discovered = v_records_discovered,
      records_inserted = v_records_inserted,
      records_updated = v_records_updated,
      duplicates_ignored = v_duplicates_ignored,
      records_needing_review = v_records_needing_review,
      errors = v_errors,
      summary = v_summary
  where run_id = v_run_id and user_id = v_user_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'status', v_status,
    'records_discovered', v_records_discovered,
    'records_inserted', v_records_inserted,
    'records_updated', v_records_updated,
    'duplicates_ignored', v_duplicates_ignored,
    'records_needing_review', v_records_needing_review
  );
end;
$$;

-- This RPC is also kept as the narrow internal operation used by the existing
-- ingest-opportunities Edge Function. It remains service-role-only.
create or replace function public.ingest_opportunity_record(
  p_user_id uuid,
  p_record jsonb,
  p_request_id uuid default gen_random_uuid()
)
returns table(action text, opportunity_id uuid, dedupe_key text, request_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_source_url_raw text;
  v_source_url text;
  v_organization text;
  v_position text;
  v_dedupe_key text;
  v_existing_id uuid;
  v_opportunity_id uuid;
  v_action text;
  v_request_id uuid := coalesce(p_request_id, gen_random_uuid());
  v_score integer;
  v_threshold integer;
  v_classification text;
  v_requirements jsonb;
  v_verified_skills jsonb;
  v_missing_skills jsonb;
  v_projects jsonb;
  v_score_breakdown jsonb;
  v_cv jsonb;
  v_email jsonb;
  v_artifact_id uuid;
  v_version integer;
  v_is_current boolean;
  v_content text;
  v_file_reference text;
  v_change_summary text;
  v_recipient text;
  v_subject text;
  v_body text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'user_id does not exist';
  end if;
  if coalesce(jsonb_typeof(p_record), '') <> 'object' then
    raise exception 'p_record must be a JSON object';
  end if;
  if pg_column_size(p_record) > 500000 then
    raise exception 'opportunity payload is too large';
  end if;

  v_source_url_raw := trim(coalesce(p_record->>'source_url', p_record->>'sourceUrl', p_record->>'url', ''));
  v_organization := trim(coalesce(p_record->>'organization', p_record->>'company', p_record->>'university', ''));
  v_position := trim(coalesce(p_record->>'position', p_record->>'title', p_record->>'role', ''));
  if v_organization = '' or v_position = '' then
    raise exception 'organization and position are required';
  end if;
  if v_source_url_raw !~* '^https?://[^[:space:]]+$' then
    raise exception 'source_url must use http or https';
  end if;
  if lower(coalesce(p_record->>'domain_relevant', 'false')) not in ('true', 't', '1') then
    raise exception 'only domain-relevant opportunities can be ingested';
  end if;

  v_source_url := public.normalize_opportunity_url(v_source_url_raw);
  v_score := coalesce(nullif(trim(coalesce(p_record->>'match_score', p_record->>'matchScore', p_record->>'score', '')), '')::integer, 0);
  if v_score < 0 or v_score > 100 then
    raise exception 'match_score must be between 0 and 100';
  end if;
  v_threshold := coalesce((select match_threshold from public.user_settings where user_id = p_user_id), 70);
  v_classification := public.classify_opportunity_score(v_score, v_threshold);
  v_dedupe_key := public.opportunity_dedupe_key(v_source_url_raw, v_organization, v_position);
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_dedupe_key, 0));

  v_requirements := case when jsonb_typeof(p_record->'requirements') = 'array' then p_record->'requirements' else '[]'::jsonb end;
  v_verified_skills := case when jsonb_typeof(p_record->'verified_skills') = 'array' then p_record->'verified_skills' else '[]'::jsonb end;
  v_missing_skills := case when jsonb_typeof(p_record->'missing_skills') = 'array' then p_record->'missing_skills' else '[]'::jsonb end;
  v_projects := case when jsonb_typeof(p_record->'projects') = 'array' then p_record->'projects' else '[]'::jsonb end;
  v_score_breakdown := case when jsonb_typeof(p_record->'score_breakdown') = 'object' then p_record->'score_breakdown' else '{}'::jsonb end;

  select opportunities.id into v_existing_id
  from public.opportunity_records as opportunities
  where opportunities.user_id = p_user_id and opportunities.dedupe_key = v_dedupe_key
  for update;

  if v_existing_id is null then
    insert into public.opportunity_records (
      user_id, dedupe_key, origin, label, kind, organization, organization_type,
      contact, professor_researcher, position, research_area, lab, country, city,
      opportunity_type, external_id, source_url, description, requirements,
      first_discovered_at, last_checked_at, initial_score, current_score, match_score,
      score_breakdown, classification, application_status, active, active_sections,
      deadline, funding, funding_status, work_mode, availability, domain_relevant,
      domain_relevance_reason, verified_skills, missing_skills, projects, notes,
      status, sent, cv_version, email_version, summary, raw_payload
    )
    values (
      p_user_id, v_dedupe_key,
      coalesce(nullif(p_record->>'origin', ''), 'automation'),
      nullif(p_record->>'label', ''),
      coalesce(nullif(p_record->>'kind', ''), 'internship'),
      v_organization,
      nullif(p_record->>'organization_type', ''),
      nullif(coalesce(p_record->>'contact', p_record->>'recruiter', ''), ''),
      nullif(coalesce(p_record->>'professor_researcher', p_record->>'professor', p_record->>'researcher', ''), ''),
      v_position,
      nullif(p_record->>'research_area', ''),
      nullif(coalesce(p_record->>'lab', p_record->>'group', ''), ''),
      nullif(coalesce(p_record->>'country', p_record->>'location_country', ''), ''),
      nullif(coalesce(p_record->>'city', p_record->>'location_city', ''), ''),
      nullif(p_record->>'opportunity_type', ''),
      nullif(p_record->>'external_id', ''),
      v_source_url,
      nullif(coalesce(p_record->>'description', p_record->>'details', ''), ''),
      v_requirements, now(), now(), v_score, v_score, v_score, v_score_breakdown,
      v_classification, 'not_sent', true, array[v_classification]::text[],
      nullif(p_record->>'deadline', '')::date,
      nullif(coalesce(p_record->>'funding', p_record->>'salary', p_record->>'stipend', ''), ''),
      nullif(p_record->>'funding_status', ''),
      nullif(coalesce(p_record->>'work_mode', p_record->>'workMode', p_record->>'mode', ''), ''),
      nullif(p_record->>'availability', ''), true,
      nullif(p_record->>'domain_relevance_reason', ''),
      v_verified_skills, v_missing_skills, v_projects,
      nullif(p_record->>'notes', ''), 'Needs review', false,
      nullif(p_record->>'cv_version', ''), nullif(p_record->>'email_version', ''),
      nullif(p_record->>'summary', ''), p_record
    )
    returning id into v_opportunity_id;
    v_action := 'inserted';
  else
    update public.opportunity_records
    set origin = coalesce(nullif(p_record->>'origin', ''), origin),
        label = coalesce(nullif(p_record->>'label', ''), label),
        kind = coalesce(nullif(p_record->>'kind', ''), kind),
        organization = v_organization,
        organization_type = coalesce(nullif(p_record->>'organization_type', ''), organization_type),
        contact = coalesce(nullif(coalesce(p_record->>'contact', p_record->>'recruiter', ''), ''), contact),
        professor_researcher = coalesce(nullif(coalesce(p_record->>'professor_researcher', p_record->>'professor', p_record->>'researcher', ''), ''), professor_researcher),
        position = v_position,
        research_area = coalesce(nullif(p_record->>'research_area', ''), research_area),
        lab = coalesce(nullif(coalesce(p_record->>'lab', p_record->>'group', ''), ''), lab),
        country = coalesce(nullif(coalesce(p_record->>'country', p_record->>'location_country', ''), ''), country),
        city = coalesce(nullif(coalesce(p_record->>'city', p_record->>'location_city', ''), ''), city),
        opportunity_type = coalesce(nullif(p_record->>'opportunity_type', ''), opportunity_type),
        external_id = coalesce(nullif(p_record->>'external_id', ''), external_id),
        source_url = v_source_url,
        description = coalesce(nullif(coalesce(p_record->>'description', p_record->>'details', ''), ''), description),
        requirements = case when jsonb_typeof(p_record->'requirements') = 'array' then p_record->'requirements' else requirements end,
        current_score = v_score,
        match_score = v_score,
        score_breakdown = case when jsonb_typeof(p_record->'score_breakdown') = 'object' then p_record->'score_breakdown' else score_breakdown end,
        deadline = coalesce(nullif(p_record->>'deadline', '')::date, deadline),
        funding = coalesce(nullif(coalesce(p_record->>'funding', p_record->>'salary', p_record->>'stipend', ''), ''), funding),
        funding_status = coalesce(nullif(p_record->>'funding_status', ''), funding_status),
        work_mode = coalesce(nullif(coalesce(p_record->>'work_mode', p_record->>'workMode', p_record->>'mode', ''), ''), work_mode),
        availability = coalesce(nullif(p_record->>'availability', ''), availability),
        domain_relevant = true,
        domain_relevance_reason = coalesce(nullif(p_record->>'domain_relevance_reason', ''), domain_relevance_reason),
        verified_skills = case when jsonb_typeof(p_record->'verified_skills') = 'array' then p_record->'verified_skills' else verified_skills end,
        missing_skills = case when jsonb_typeof(p_record->'missing_skills') = 'array' then p_record->'missing_skills' else missing_skills end,
        projects = case when jsonb_typeof(p_record->'projects') = 'array' then p_record->'projects' else projects end,
        notes = coalesce(nullif(p_record->>'notes', ''), notes),
        cv_version = coalesce(nullif(p_record->>'cv_version', ''), cv_version),
        email_version = coalesce(nullif(p_record->>'email_version', ''), email_version),
        summary = coalesce(nullif(p_record->>'summary', ''), summary),
        raw_payload = p_record,
        last_checked_at = now()
    where id = v_existing_id
    returning id into v_opportunity_id;
    v_action := 'duplicate_updated';
  end if;

  -- Store targeted artifacts as immutable version rows. Replaying the same
  -- version is idempotent; a new version never replaces an older one.
  v_cv := case when jsonb_typeof(p_record->'cv') = 'object' then p_record->'cv' else null end;
  if v_cv is not null then
    v_version := nullif(trim(v_cv->>'version'), '')::integer;
    if v_version is null or v_version < 1 then raise exception 'cv.version must be a positive integer'; end if;
    v_is_current := case when v_cv ? 'is_current' then (v_cv->>'is_current')::boolean else true end;
    if v_is_current then
      update public.cv_versions as versions set is_current = false
      where versions.user_id = p_user_id and versions.opportunity_id = v_opportunity_id;
    end if;
    v_content := case when v_cv ? 'content' then v_cv->>'content' else null end;
    v_file_reference := case when v_cv ? 'file_reference' then v_cv->>'file_reference' else null end;
    v_change_summary := case when v_cv ? 'change_summary' then v_cv->>'change_summary' else null end;
    select versions.id into v_artifact_id from public.cv_versions as versions
    where versions.user_id = p_user_id and versions.opportunity_id = v_opportunity_id and versions.version = v_version for update;
    if v_artifact_id is null then
      insert into public.cv_versions (user_id, opportunity_id, version, is_current, change_summary, content, file_reference)
      values (p_user_id, v_opportunity_id, v_version, v_is_current, v_change_summary, v_content, v_file_reference);
    else
      update public.cv_versions
      set is_current = v_is_current,
          change_summary = case when v_cv ? 'change_summary' then v_change_summary else change_summary end,
          content = case when v_cv ? 'content' then v_content else content end,
          file_reference = case when v_cv ? 'file_reference' then v_file_reference else file_reference end
      where id = v_artifact_id;
    end if;
  end if;

  v_email := case when jsonb_typeof(p_record->'email_draft') = 'object' then p_record->'email_draft' else null end;
  if v_email is not null then
    v_version := nullif(trim(v_email->>'version'), '')::integer;
    if v_version is null or v_version < 1 then raise exception 'email_draft.version must be a positive integer'; end if;
    v_is_current := case when v_email ? 'is_current' then (v_email->>'is_current')::boolean else true end;
    if v_is_current then
      update public.email_drafts as drafts set is_current = false
      where drafts.user_id = p_user_id and drafts.opportunity_id = v_opportunity_id;
    end if;
    v_recipient := case when v_email ? 'recipient' then nullif(v_email->>'recipient', '') else null end;
    v_subject := case when v_email ? 'subject' then nullif(v_email->>'subject', '') else null end;
    v_body := coalesce(v_email->>'body', '');
    select drafts.id into v_artifact_id from public.email_drafts as drafts
    where drafts.user_id = p_user_id and drafts.opportunity_id = v_opportunity_id and drafts.version = v_version for update;
    if v_artifact_id is null then
      insert into public.email_drafts (user_id, opportunity_id, recipient, subject, body, version, is_current)
      values (p_user_id, v_opportunity_id, v_recipient, v_subject, v_body, v_version, v_is_current);
    else
      update public.email_drafts
      set is_current = v_is_current,
          recipient = case when v_email ? 'recipient' then v_recipient else recipient end,
          subject = case when v_email ? 'subject' then v_subject else subject end,
          body = case when v_email ? 'body' then v_body else body end
      where id = v_artifact_id;
    end if;
  end if;

  insert into public.opportunity_ingestion_events (
    request_id, user_id, opportunity_id, dedupe_key, action, source_url,
    run_id, source_name, status, opportunities_received, opportunities_inserted,
    opportunities_updated, duplicates_ignored, summary
  )
  values (
    v_request_id, p_user_id, v_opportunity_id, v_dedupe_key, v_action, v_source_url,
    v_request_id, nullif(p_record->>'source_name', ''), 'completed', 1,
    case when v_action = 'inserted' then 1 else 0 end,
    case when v_action = 'duplicate_updated' then 1 else 0 end,
    case when v_action = 'duplicate_updated' then 1 else 0 end,
    case when v_action = 'inserted' then 'opportunity inserted' else 'duplicate opportunity updated' end
  )
  on conflict on constraint opportunity_ingestion_events_request_id_dedupe_key_key do update
  set opportunity_id = excluded.opportunity_id,
      action = excluded.action,
      source_url = excluded.source_url,
      source_name = excluded.source_name,
      status = excluded.status,
      opportunities_received = excluded.opportunities_received,
      opportunities_inserted = excluded.opportunities_inserted,
      opportunities_updated = excluded.opportunities_updated,
      duplicates_ignored = excluded.duplicates_ignored,
      summary = excluded.summary;

  return query select v_action, v_opportunity_id, v_dedupe_key, v_request_id;
end;
$$;

create or replace function public.automation_ingest_opportunities(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid;
  v_items jsonb;
  v_item jsonb;
  v_request_id uuid := gen_random_uuid();
  v_source_name text := nullif(trim(p_payload->>'source_name'), '');
  v_action text;
  v_opportunity_id uuid;
  v_dedupe_key text;
  v_accepted jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_inserted integer := 0;
  v_updated integer := 0;
begin
  if coalesce(jsonb_typeof(p_payload), '') <> 'object' then raise exception 'p_payload must be a JSON object'; end if;
  v_user_id := nullif(trim(p_payload->>'user_id'), '')::uuid;
  if v_user_id is null then raise exception 'user_id is required'; end if;
  if not exists (select 1 from auth.users where id = v_user_id) then raise exception 'user_id does not exist'; end if;
  if p_payload ? 'request_id' then v_request_id := nullif(trim(p_payload->>'request_id'), '')::uuid; end if;
  v_items := p_payload->'opportunities';
  if coalesce(jsonb_typeof(v_items), '') <> 'array' then raise exception 'opportunities must be an array'; end if;
  if jsonb_array_length(v_items) < 1 or jsonb_array_length(v_items) > 100 then raise exception 'opportunities must contain between 1 and 100 items'; end if;

  for v_item in select value from jsonb_array_elements(v_items) loop
    begin
      if v_source_name is not null then v_item := v_item || jsonb_build_object('source_name', v_source_name); end if;
      select action, opportunity_id, dedupe_key
      into v_action, v_opportunity_id, v_dedupe_key
      from public.ingest_opportunity_record(v_user_id, v_item, v_request_id);
      if v_action = 'inserted' then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
      v_accepted := v_accepted || jsonb_build_array(jsonb_build_object('opportunity_id', v_opportunity_id, 'action', v_action, 'dedupe_key', v_dedupe_key));
    exception when others then
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('error', 'opportunity rejected by validation'));
    end;
  end loop;

  return jsonb_build_object(
    'request_id', v_request_id,
    'accepted_count', jsonb_array_length(v_accepted),
    'inserted_count', v_inserted,
    'updated_count', v_updated,
    'duplicate_count', v_updated,
    'rejected_count', jsonb_array_length(v_rejected),
    'accepted', v_accepted,
    'rejected', v_rejected
  );
end;
$$;

create or replace function public.automation_update_application(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid;
  v_application_id uuid;
  v_opportunity_id uuid;
  v_existing_opportunity_id uuid;
  v_status text;
  v_last_response_at timestamptz;
  v_follow_up_at timestamptz;
  v_notes text;
  v_draft jsonb;
  v_draft_id uuid;
  v_version integer;
  v_is_current boolean;
  v_recipient text;
  v_subject text;
  v_body text;
begin
  if coalesce(jsonb_typeof(p_payload), '') <> 'object' then raise exception 'p_payload must be a JSON object'; end if;
  v_user_id := nullif(trim(p_payload->>'user_id'), '')::uuid;
  v_application_id := nullif(trim(p_payload->>'application_id'), '')::uuid;
  v_status := lower(trim(coalesce(p_payload->>'application_status', p_payload->>'status', '')));
  if v_user_id is null or v_application_id is null then raise exception 'user_id and application_id are required'; end if;
  if v_status not in ('not_sent', 'ready', 'already_sent', 'sent', 'waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'closed') then
    raise exception 'invalid application status';
  end if;

  select opportunity_id into v_existing_opportunity_id
  from public.application_records
  where id = v_application_id and user_id = v_user_id
  for update;
  if not found then raise exception 'application not found'; end if;
  v_opportunity_id := v_existing_opportunity_id;
  if p_payload ? 'opportunity_id' then
    v_opportunity_id := nullif(trim(p_payload->>'opportunity_id'), '')::uuid;
    if v_opportunity_id is distinct from v_existing_opportunity_id then raise exception 'application opportunity link cannot change'; end if;
  end if;
  if p_payload ? 'last_response_at' then v_last_response_at := nullif(trim(p_payload->>'last_response_at'), '')::timestamptz; end if;
  if p_payload ? 'follow_up_at' then v_follow_up_at := nullif(trim(p_payload->>'follow_up_at'), '')::timestamptz; end if;
  if p_payload ? 'notes' then v_notes := nullif(trim(p_payload->>'notes'), ''); end if;

  update public.application_records
  set application_status = v_status,
      last_response_at = case when p_payload ? 'last_response_at' then v_last_response_at else last_response_at end,
      follow_up_at = case when p_payload ? 'follow_up_at' then v_follow_up_at else follow_up_at end,
      notes = case when p_payload ? 'notes' then v_notes else notes end
  where id = v_application_id and user_id = v_user_id;

  if v_opportunity_id is not null then
    update public.opportunity_records
    set application_status = v_status,
        sent = (v_status <> 'not_sent')
    where id = v_opportunity_id and user_id = v_user_id;
  end if;

  v_draft := case when jsonb_typeof(p_payload->'follow_up_draft') = 'object' then p_payload->'follow_up_draft' else null end;
  if v_draft is not null then
    if v_status <> 'follow_up_needed' then raise exception 'follow_up_draft requires follow_up_needed status'; end if;
    v_body := coalesce(v_draft->>'body', '');
    if btrim(v_body) = '' then raise exception 'follow_up_draft.body is required'; end if;
    v_version := nullif(trim(v_draft->>'version'), '')::integer;
    if v_version is null then
      select coalesce(max(version), 0) + 1 into v_version
      from public.email_drafts
      where user_id = v_user_id
        and opportunity_id is not distinct from v_opportunity_id;
    end if;
    if v_version < 1 then raise exception 'follow_up_draft.version must be positive'; end if;
    v_is_current := case when v_draft ? 'is_current' then (v_draft->>'is_current')::boolean else true end;
    v_recipient := case when v_draft ? 'recipient' then nullif(v_draft->>'recipient', '') else null end;
    v_subject := case when v_draft ? 'subject' then nullif(v_draft->>'subject', '') else null end;
    if v_is_current then
      update public.email_drafts set is_current = false
      where user_id = v_user_id and opportunity_id is not distinct from v_opportunity_id;
    end if;
    select id into v_draft_id
    from public.email_drafts
    where user_id = v_user_id
      and application_id = v_application_id
      and opportunity_id is not distinct from v_opportunity_id
      and version = v_version
    order by created_at desc
    limit 1
    for update;
    if v_draft_id is null then
      insert into public.email_drafts (user_id, opportunity_id, application_id, recipient, subject, body, version, is_current)
      values (v_user_id, v_opportunity_id, v_application_id, v_recipient, v_subject, v_body, v_version, v_is_current)
      returning id into v_draft_id;
    else
      update public.email_drafts
      set recipient = case when v_draft ? 'recipient' then v_recipient else recipient end,
          subject = case when v_draft ? 'subject' then v_subject else subject end,
          body = case when v_draft ? 'body' then v_body else body end,
          is_current = v_is_current
      where id = v_draft_id;
    end if;
  end if;

  return jsonb_build_object(
    'application_id', v_application_id,
    'opportunity_id', v_opportunity_id,
    'application_status', v_status,
    'follow_up_draft_id', v_draft_id
  );
end;
$$;

-- The live deployment already has this identity index; keep the migration
-- safe for older Phase 1 deployments as well.
create unique index if not exists opportunity_ingestion_events_request_id_dedupe_key_key
  on public.opportunity_ingestion_events (request_id, dedupe_key);

revoke all on function public.automation_read_settings(uuid) from public, anon, authenticated;
revoke all on function public.automation_sync_profile(jsonb) from public, anon, authenticated;
revoke all on function public.ingest_opportunity_record(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.automation_ingest_opportunities(jsonb) from public, anon, authenticated;
revoke all on function public.automation_update_application(jsonb) from public, anon, authenticated;

grant execute on function public.automation_read_settings(uuid) to service_role;
grant execute on function public.automation_sync_profile(jsonb) to service_role;
grant execute on function public.ingest_opportunity_record(uuid, jsonb, uuid) to service_role;
grant execute on function public.automation_ingest_opportunities(jsonb) to service_role;
grant execute on function public.automation_update_application(jsonb) to service_role;

comment on function public.automation_read_settings(uuid) is 'Server-side automation read contract for backend-driven settings; service_role only.';
comment on function public.automation_sync_profile(jsonb) is 'Server-side Verified Profile Sync contract; never deletes facts or sends mail.';
comment on function public.automation_ingest_opportunities(jsonb) is 'Server-side opportunity ingestion contract; deduplicates, classifies, and versions artifacts without sending mail.';
comment on function public.automation_update_application(jsonb) is 'Server-side Application Monitor contract; updates status and creates follow-up drafts without sending mail.';

commit;
