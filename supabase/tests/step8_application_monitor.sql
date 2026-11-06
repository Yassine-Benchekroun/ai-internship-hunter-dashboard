-- Step 8 rollback-safe Application Monitor contract tests.
-- Execute after the Step 8 migration as a privileged SQL test. The final
-- rollback leaves the production project unchanged.

begin;

do $$
declare
  v_user_id uuid := '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid;
  v_opportunity_id uuid;
  v_application_id uuid;
  v_run_id uuid := gen_random_uuid();
  v_result jsonb;
  v_count integer;
begin
  if not exists (select 1 from auth.users where id = v_user_id) then
    raise exception 'step8 test owner is missing';
  end if;

  insert into public.opportunity_records (
    user_id, dedupe_key, organization, position, source_url,
    domain_relevant, initial_score, current_score, match_score, classification,
    active_sections, application_status
  ) values (
    v_user_id, 'step8-monitor-test', 'Step 8 Test University', 'AI Research Internship',
    'https://example.org/step8-monitor-test', true, 74, 74, 74, 'top', array['top']::text[], 'already_sent'
  ) returning id into v_opportunity_id;

  insert into public.application_records (
    user_id, opportunity_id, organization, position, recipient_email,
    email_subject, application_status, sent_at
  ) values (
    v_user_id, v_opportunity_id, 'Step 8 Test University', 'AI Research Internship',
    'recruiter@example.org', 'AI Research Internship application', 'waiting', now() - interval '2 days'
  ) returning id into v_application_id;

  v_result := public.automation_update_application(jsonb_build_object(
    'user_id', v_user_id,
    'application_id', v_application_id,
    'application_status', 'replied',
    'last_response_at', now(),
    'provider', 'gmail',
    'provider_message_id', 'step8-message-1',
    'provider_thread_id', 'step8-thread-1',
    'message_received_at', now()
  ));
  if coalesce((v_result->>'duplicate')::boolean, true) then raise exception 'first monitor message was treated as duplicate'; end if;
  if v_result->>'application_status' <> 'replied' then raise exception 'reply status update failed'; end if;
  if (select application_status from public.application_records where id = v_application_id) <> 'replied' then raise exception 'application status was not persisted'; end if;
  if (select application_status from public.opportunity_records where id = v_opportunity_id) <> 'replied' then raise exception 'linked opportunity status was not persisted'; end if;

  v_result := public.automation_update_application(jsonb_build_object(
    'user_id', v_user_id,
    'application_id', v_application_id,
    'application_status', 'replied',
    'provider', 'gmail',
    'provider_message_id', 'step8-message-1',
    'provider_thread_id', 'step8-thread-1'
  ));
  if coalesce((v_result->>'duplicate')::boolean, false) <> true then raise exception 'duplicate provider message must be ignored'; end if;
  select count(*) into v_count from public.application_monitor_events
  where user_id = v_user_id and application_id = v_application_id and provider_message_id = 'step8-message-1';
  if v_count <> 1 then raise exception 'duplicate provider message created more than one event'; end if;

  v_result := public.automation_update_application(jsonb_build_object(
    'user_id', v_user_id,
    'application_id', v_application_id,
    'application_status', 'follow_up_needed',
    'follow_up_draft', jsonb_build_object(
      'version', 1, 'is_current', true, 'recipient', 'recruiter@example.org',
      'subject', 'Re: AI Research Internship application', 'body', 'Draft only'
    )
  ));
  select count(*) into v_count from public.email_drafts where application_id = v_application_id and is_current;
  if v_count <> 1 then raise exception 'follow-up draft was not created'; end if;

  v_result := public.automation_log_application_monitor_run(jsonb_build_object(
    'run_id', v_run_id,
    'user_id', v_user_id,
    'provider', 'gmail',
    'dry_run', false,
    'status', 'completed',
    'messages_scanned', 1,
    'applications_considered', 1,
    'applications_updated', 1,
    'follow_up_drafts_created', 0,
    'duplicates_ignored', 1,
    'errors', jsonb_build_array(),
    'summary', 'Controlled Step 8 test run'
  ));
  if v_result->>'run_id' <> v_run_id::text then raise exception 'monitor run was not logged'; end if;
  if (select status from public.application_monitor_runs where run_id = v_run_id) <> 'completed' then raise exception 'monitor run status was not persisted'; end if;

  if has_table_privilege('anon', 'public.application_monitor_runs', 'select')
     or has_table_privilege('anon', 'public.application_monitor_events', 'select') then
    raise exception 'anonymous monitor history access is open';
  end if;
  if has_table_privilege('authenticated', 'public.application_monitor_runs', 'insert')
     or has_table_privilege('authenticated', 'public.application_monitor_events', 'insert') then
    raise exception 'authenticated monitor history writes are open';
  end if;
  if has_function_privilege('anon', 'public.automation_update_application(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.automation_update_application(jsonb)', 'execute') then
    raise exception 'browser roles can execute the application update RPC';
  end if;
  if has_function_privilege('authenticated', 'public.automation_log_application_monitor_run(jsonb)', 'execute') then
    raise exception 'authenticated monitor run logging is open';
  end if;
end;
$$;

rollback;
