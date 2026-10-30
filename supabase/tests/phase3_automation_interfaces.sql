-- Phase 3 rollback-safe contract tests.
-- Execute after the Phase 3 migration as a privileged SQL test. The final
-- rollback leaves the production project unchanged.

begin;

do $$
declare
  v_user_id uuid := '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid;
  v_opportunity_id uuid;
  v_sent_lower_opportunity_id uuid;
  v_application_id uuid;
  v_first_discovered_at timestamptz;
  v_result jsonb;
  v_status text;
  v_classification text;
  v_count integer;
begin
  if not exists (select 1 from auth.users where id = v_user_id) then
    raise exception 'phase3 test owner is missing';
  end if;

  insert into public.user_settings (user_id, match_threshold)
  values (v_user_id, 70)
  on conflict (user_id) do update set match_threshold = 70;
  update public.user_settings
  set approved_profile_sources = jsonb_build_array(jsonb_build_object(
    'source_type', 'github',
    'source_name', 'phase3-test',
    'source_url', 'https://github.com/phase3-test'
  ))
  where user_id = v_user_id;

  -- Profile normalization, new facts, evidence, and source_missing retention.
  v_result := public.automation_sync_profile(jsonb_build_object(
    'user_id', v_user_id,
    'status', 'completed',
    'sources_checked', jsonb_build_array(jsonb_build_object('source_type', 'github', 'source_name', 'phase3-test', 'source_url', 'https://github.com/phase3-test')),
    'facts', jsonb_build_array(
      jsonb_build_object('category', 'skill', 'name', 'Python', 'verification_status', 'verified', 'evidence', jsonb_build_array(jsonb_build_object('source_type', 'github', 'source_name', 'phase3-test', 'source_url', 'https://github.com/phase3-test', 'evidence', 'Python evidence'))),
      jsonb_build_object('category', 'skills', 'name', 'python', 'verification_status', 'verified'),
      jsonb_build_object('category', 'skill', 'name', 'Docker', 'verification_status', 'verified')
    )
  ));
  select count(*) into v_count from public.profile_facts where user_id = v_user_id and category = 'skill' and normalized_name = 'python';
  if v_count <> 1 then raise exception 'duplicate profile fact test failed'; end if;
  select count(*) into v_count from public.profile_fact_evidence where user_id = v_user_id and source_name = 'phase3-test';
  if v_count <> 1 then raise exception 'profile evidence test failed'; end if;

  v_result := public.automation_sync_profile(jsonb_build_object(
    'user_id', v_user_id,
    'status', 'completed',
    'facts', jsonb_build_array(jsonb_build_object('category', 'skill', 'name', 'FastAPI', 'verification_status', 'verified')),
    'missing_facts', jsonb_build_array(jsonb_build_object('category', 'skill', 'name', 'Docker'))
  ));
  select verification_status into v_status from public.profile_facts where user_id = v_user_id and category = 'skill' and normalized_name = 'docker';
  if v_status <> 'source_missing' then raise exception 'source_missing test failed'; end if;

  -- Ingest, deduplicate, threshold classification, and artifact preservation.
  v_result := public.automation_ingest_opportunities(jsonb_build_object(
    'user_id', v_user_id,
    'source_name', 'phase3-test',
    'opportunities', jsonb_build_array(
      jsonb_build_object(
        'organization', 'Phase 3 Test University', 'position', 'AI Research Intern',
        'source_url', 'https://example.org/phase3-opportunity', 'domain_relevant', true,
        'match_score', 68, 'score_breakdown', jsonb_build_object('technical', 20),
        'cv', jsonb_build_object('version', 1, 'is_current', true, 'content', 'CV v1'),
        'email_draft', jsonb_build_object('version', 1, 'is_current', true, 'recipient', 'research@example.org', 'subject', 'v1', 'body', 'Email v1')
      )
    )
  ));
  select id, first_discovered_at, classification into v_opportunity_id, v_first_discovered_at, v_classification
  from public.opportunity_records
  where user_id = v_user_id and source_url = 'example.org/phase3-opportunity';
  if v_classification <> 'lower' then raise exception '68 classification test failed'; end if;

  perform public.automation_ingest_opportunities(jsonb_build_object(
    'user_id', v_user_id,
    'source_name', 'phase3-test',
    'opportunities', jsonb_build_array(
      jsonb_build_object(
        'organization', 'Phase 3 Test University', 'position', 'AI Research Intern',
        'source_url', 'https://example.org/phase3-opportunity', 'domain_relevant', true,
        'match_score', 68,
        'cv', jsonb_build_object('version', 2, 'is_current', true, 'content', 'CV v2'),
        'email_draft', jsonb_build_object('version', 2, 'is_current', true, 'recipient', 'research@example.org', 'subject', 'v2', 'body', 'Email v2')
      )
    )
  ));
  select count(*) into v_count from public.opportunity_records where user_id = v_user_id and dedupe_key = public.opportunity_dedupe_key('https://example.org/phase3-opportunity', 'Phase 3 Test University', 'AI Research Intern');
  if v_count <> 1 then raise exception 'duplicate opportunity test failed'; end if;
  if (select first_discovered_at from public.opportunity_records where id = v_opportunity_id) <> v_first_discovered_at then raise exception 'first_discovered_at was not preserved'; end if;
  select count(*) into v_count from public.cv_versions where user_id = v_user_id and opportunity_id = v_opportunity_id;
  if v_count <> 2 then raise exception 'CV version preservation test failed'; end if;
  select count(*) into v_count from public.email_drafts where user_id = v_user_id and opportunity_id = v_opportunity_id;
  if v_count <> 2 then raise exception 'email version preservation test failed'; end if;

  perform public.automation_ingest_opportunities(jsonb_build_object(
    'user_id', v_user_id,
    'source_name', 'phase3-test',
    'opportunities', jsonb_build_array(
      jsonb_build_object('organization', 'Phase 3 Test University', 'position', 'AI Research Intern', 'source_url', 'https://example.org/phase3-opportunity', 'domain_relevant', true, 'match_score', 70),
      jsonb_build_object('organization', 'Phase 3 Top University', 'position', 'AI Intern', 'source_url', 'https://example.org/phase3-top', 'domain_relevant', true, 'match_score', 74),
      jsonb_build_object('organization', 'Phase 3 Lower University', 'position', 'AI Intern', 'source_url', 'https://example.org/phase3-lower', 'domain_relevant', true, 'match_score', 62),
      jsonb_build_object('organization', 'Phase 3 Sent Lower University', 'position', 'AI Intern', 'source_url', 'https://example.org/phase3-sent-lower', 'domain_relevant', true, 'match_score', 68)
    )
  ));
  if (select classification from public.opportunity_records where id = v_opportunity_id) <> 'top' then raise exception '70 classification test failed'; end if;
  if (select classification from public.opportunity_records where user_id = v_user_id and source_url = 'example.org/phase3-top') <> 'top' then raise exception '74 classification test failed'; end if;
  if (select classification from public.opportunity_records where user_id = v_user_id and source_url = 'example.org/phase3-lower') <> 'lower' then raise exception '62 classification test failed'; end if;

  select id into v_sent_lower_opportunity_id
  from public.opportunity_records
  where user_id = v_user_id and source_url = 'example.org/phase3-sent-lower';
  insert into public.application_records (user_id, opportunity_id, organization, application_status)
  values (v_user_id, v_sent_lower_opportunity_id, 'Phase 3 Sent Lower University', 'already_sent')
  returning id into v_application_id;
  perform public.automation_update_application(jsonb_build_object(
    'user_id', v_user_id, 'application_id', v_application_id,
    'application_status', 'already_sent'
  ));
  if (select classification from public.opportunity_records where id = v_sent_lower_opportunity_id) <> 'lower' then raise exception 'already-sent low-match classification changed'; end if;
  if (select application_status from public.opportunity_records where id = v_sent_lower_opportunity_id) <> 'already_sent' then raise exception 'already-sent low-match status update failed'; end if;

  insert into public.application_records (user_id, opportunity_id, organization, application_status)
  values (v_user_id, v_opportunity_id, 'Phase 3 Test University', 'already_sent')
  returning id into v_application_id;
  v_result := public.automation_update_application(jsonb_build_object(
    'user_id', v_user_id, 'application_id', v_application_id,
    'application_status', 'already_sent'
  ));
  if (select application_status from public.opportunity_records where id = v_opportunity_id) <> 'already_sent' then raise exception 'already_sent status update failed'; end if;
  if (select classification from public.opportunity_records where id = v_opportunity_id) <> 'top' then raise exception 'application status changed classification'; end if;

  v_result := public.automation_update_application(jsonb_build_object(
    'user_id', v_user_id, 'application_id', v_application_id,
    'application_status', 'follow_up_needed',
    'follow_up_draft', jsonb_build_object('is_current', true, 'recipient', 'research@example.org', 'subject', 'Follow up', 'body', 'Draft only')
  ));
  select count(*) into v_count from public.email_drafts where application_id = v_application_id;
  if v_count <> 1 then raise exception 'follow-up draft test failed'; end if;

  if has_function_privilege('anon', 'public.automation_sync_profile(jsonb)', 'execute') then raise exception 'anon profile RPC is callable'; end if;
  if has_function_privilege('authenticated', 'public.automation_ingest_opportunities(jsonb)', 'execute') then raise exception 'authenticated ingest RPC is callable'; end if;
  if has_function_privilege('authenticated', 'public.automation_update_application(jsonb)', 'execute') then raise exception 'authenticated monitor RPC is callable'; end if;
end;
$$;

rollback;
