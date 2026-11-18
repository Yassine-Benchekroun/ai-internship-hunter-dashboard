-- Transactional acceptance checks: all fixture changes are rolled back.
-- Run before starting any real worker; never count these fixtures as live validation.
begin;
do $$
declare
  owner_id uuid; request_id uuid:=gen_random_uuid(); run_a uuid; run_b uuid; opp uuid; app uuid; app_two uuid;
  result jsonb; result_two jsonb; fixture text:='schedule-test-'||gen_random_uuid()::text;
  first_seen timestamptz; first_checked timestamptz; first_response timestamptz:=now()-interval '1 hour';
  original_score integer; original_class text; payload jsonb; fact_payload jsonb; fact_total integer;
  legacy_opp uuid; legacy_cv uuid; legacy_email uuid; legacy_cv_snapshot jsonb; legacy_email_snapshot jsonb;
begin
  select user_id into owner_id from public.user_settings order by created_at limit 1;
  if owner_id is null then raise exception 'configured_owner_required_for_test'; end if;

  if has_function_privilege('anon','public.automation_begin_schedule(uuid,text,uuid,boolean,jsonb)','EXECUTE') or
     has_function_privilege('authenticated','public.automation_update_application(jsonb)','EXECUTE') or
     has_function_privilege('authenticated','public.automation_consume_schedule_ticket(text,text)','EXECUTE') or
     has_function_privilege('authenticated','public.automation_record_schedule_validation(uuid,text,uuid[])','EXECUTE') or
     has_table_privilege('authenticated','public.schedule_runs','INSERT') then raise exception 'privileged_contract_is_public'; end if;
  if has_table_privilege('authenticated','private.schedule_tickets','SELECT') then raise exception 'tickets_are_public'; end if;

  -- Each schedule has a separate lease. Completed request replays are no-ops.
  result:=public.automation_begin_schedule(owner_id,'profile_sync',request_id,false,'[]');
  if not (result->>'acquired')::boolean then raise exception 'profile_worker_already_running_stop_before_test'; end if;
  run_a:=(result->>'run_id')::uuid;
  result_two:=public.automation_begin_schedule(owner_id,'profile_sync',gen_random_uuid(),false,'[]');
  if (result_two->>'acquired')::boolean then raise exception 'overlap_not_blocked'; end if;
  result_two:=public.automation_begin_schedule(owner_id,'application_monitor',request_id,true,'[]');
  if not (result_two->>'acquired')::boolean then raise exception 'monitor_worker_already_running_stop_before_test'; end if;
  perform public.automation_finish_schedule((result_two->>'run_id')::uuid,'blocked','{}','["provider_not_connected"]');
  if (select status from public.application_monitor_runs where run_id=(result_two->>'run_id')::uuid)<>'blocked' then raise exception 'blocked_monitor_not_persisted'; end if;
  perform public.automation_finish_schedule(run_a,'partial','{"processed_records":1,"inserted_count":1}','[]');
  result:=public.automation_begin_schedule(owner_id,'profile_sync',request_id,false,'[]');
  run_b:=(result->>'run_id')::uuid;
  if not (result->>'acquired')::boolean or run_b=run_a then raise exception 'partial_retry_missing_new_attempt'; end if;
  perform public.automation_finish_schedule(run_b,'completed','{"processed_records":1,"duplicate_count":1}','[]');
  result:=public.automation_begin_schedule(owner_id,'profile_sync',request_id,false,'[]');
  if (result->>'acquired')::boolean or (result->>'run_id')::uuid<>run_b then raise exception 'completed_replay_not_idempotent'; end if;
  result:=public.automation_begin_schedule(owner_id,'profile_sync',gen_random_uuid(),true,'[]');
  run_a:=(result->>'run_id')::uuid;
  update public.schedule_runs set lease_expires_at=now()-interval '1 second' where run_id=run_a;
  result:=public.automation_begin_schedule(owner_id,'profile_sync',gen_random_uuid(),true,'[]');
  if not (result->>'acquired')::boolean or (select status from public.schedule_runs where run_id=run_a)<>'failed' or (select status from public.profile_sync_runs where run_id=run_a)<>'failed' then raise exception 'expired_lease_not_reclaimed'; end if;
  perform public.automation_finish_schedule((result->>'run_id')::uuid,'blocked','{}','["sources_unavailable"]');

  -- Do not permit activation while any live manual validation is missing.
  begin
    update public.schedule_configuration set recurrence_enabled=true,manual_validations='{}' where user_id=owner_id;
    raise exception 'activation_gate_missing';
  exception when others then
    if sqlerrm='activation_gate_missing' then raise; end if;
  end;

  -- Profile aliases and evidence are reverified, not duplicated.
  update public.user_settings set approved_profile_sources=approved_profile_sources||jsonb_build_array(jsonb_build_object('source_type','portfolio','source_name',fixture,'source_url','https://example.org/'||fixture)) where user_id=owner_id;
  fact_payload:=jsonb_build_object('user_id',owner_id,'status','completed','facts',jsonb_build_array(jsonb_build_object(
    'category','project','name',fixture,'description','Controlled evidence fixture','verification_status','verified','evidence',jsonb_build_array(jsonb_build_object(
      'source_type','portfolio','source_name',fixture,'source_url','https://example.org/'||fixture,'evidence','Controlled project description')))));
  result:=public.automation_sync_profile(fact_payload);
  result_two:=public.automation_sync_profile(fact_payload);
  if result->>'run_id'=result_two->>'run_id' then raise exception 'profile_replay_missing_new_run'; end if;
  select count(*) into fact_total from public.profile_facts where user_id=owner_id and name=fixture;
  if fact_total<>1 or (result_two->>'records_inserted')::integer<>0 then raise exception 'profile_replay_duplicate'; end if;
  if (select count(*) from public.profile_fact_evidence where user_id=owner_id and source_name=fixture)<>1 then raise exception 'profile_evidence_duplicate'; end if;

  -- Permanent opportunity precedes preparation; lower matches remain lower.
  payload:=jsonb_build_object('user_id',owner_id,'source_name','controlled_test','opportunities',jsonb_build_array(jsonb_build_object(
    'organization','Controlled Test Lab','position',fixture,'source_url','https://example.org/'||fixture,
    'country','France','opportunity_type','research','source_is_single_posting',true,'domain_relevant',true,'match_score',68,'score_breakdown',jsonb_build_object('technical',25,'projects',20,'topic',15,'education',8,'eligibility',0,'access',0))));
  update public.user_settings set match_threshold=70 where user_id=owner_id;
  result:=public.automation_ingest_opportunities(payload);
  opp:=(result->'accepted'->0->>'opportunity_id')::uuid;
  if opp is null then
    perform * from public.ingest_opportunity_record(owner_id,payload->'opportunities'->0,gen_random_uuid());
    raise exception 'fixture_opportunity_rejected';
  end if;
  select first_discovered_at,last_checked_at,current_score,classification into first_seen,first_checked,original_score,original_class from public.opportunity_records where id=opp;
  result_two:=public.automation_ingest_opportunities(payload);
  if (result_two->'accepted'->0->>'opportunity_id')::uuid<>opp or (result_two->>'inserted_count')::integer<>0 then raise exception 'opportunity_replay_duplicate'; end if;
  if (select first_discovered_at from public.opportunity_records where id=opp)<>first_seen or (select last_checked_at from public.opportunity_records where id=opp)<first_checked then raise exception 'discovery_timestamps_regressed'; end if;
  payload:=jsonb_set(payload,'{opportunities,0,position}',to_jsonb(fixture||' corrected title'));
  result_two:=public.automation_ingest_opportunities(payload);
  if (result_two->'accepted'->0->>'opportunity_id')::uuid is distinct from opp or (result_two->>'inserted_count')::integer<>0 or (select first_discovered_at from public.opportunity_records where id=opp)<>first_seen then raise exception 'changed_title_duplicated_single_posting'; end if;
  result:=public.automation_prepare_artifacts(owner_id,opp,'{"content":"Verified fixture CV","change_summary":"Initial fixture"}','{"recipient":null,"subject":"Controlled application","body":"Controlled draft"}','fixture-key');
  result_two:=public.automation_prepare_artifacts(owner_id,opp,'{"content":"Verified fixture CV","change_summary":"Initial fixture"}','{"recipient":null,"subject":"Controlled application","body":"Controlled draft"}','fixture-key');
  if not (result->>'cv_created')::boolean or (result_two->>'cv_created')::boolean or (result_two->>'email_created')::boolean then raise exception 'artifact_replay_not_idempotent'; end if;
  result_two:=public.automation_prepare_artifacts(owner_id,opp,'{"content":"Verified fixture CV, reordered","change_summary":"Changed ordering"}',null,'fixture-key-2');
  if (select count(*) from public.cv_versions where opportunity_id=opp)<>2 or (select content from public.cv_versions where opportunity_id=opp and version=1)<>'Verified fixture CV' then raise exception 'artifact_version_history_lost'; end if;
  begin
    update public.cv_versions set content='Overwritten' where id=(result->>'cv_id')::uuid;
    raise exception 'immutable_artifact_guard_missing';
  exception when others then if sqlerrm='immutable_artifact_guard_missing' then raise; end if; end;

  -- Exact legacy artifacts have no automation key. Replaying them must reuse
  -- their IDs without changing any stored field or marking a new version current.
  insert into public.opportunity_records(user_id,dedupe_key,organization,position,source_url,domain_relevant,current_score)
    values(owner_id,fixture||'-legacy','Controlled Test Lab',fixture||'-legacy','https://example.org/'||fixture||'-legacy',true,68)
    returning id into legacy_opp;
  insert into public.cv_versions(user_id,opportunity_id,version,is_current,content,change_summary)
    values(owner_id,legacy_opp,1,true,'Legacy verified CV','Existing human-reviewed version') returning id into legacy_cv;
  insert into public.email_drafts(user_id,opportunity_id,version,is_current,recipient,subject,body)
    values(owner_id,legacy_opp,1,true,null,'Legacy subject','Legacy verified draft') returning id into legacy_email;
  select to_jsonb(c) into legacy_cv_snapshot from public.cv_versions c where id=legacy_cv;
  select to_jsonb(d) into legacy_email_snapshot from public.email_drafts d where id=legacy_email;
  result:=public.automation_prepare_artifacts(owner_id,legacy_opp,'{"content":"Legacy verified CV","change_summary":"Ignored for identical content"}','{"recipient":null,"subject":"Legacy subject","body":"Legacy verified draft"}','legacy-replay');
  result_two:=public.automation_prepare_artifacts(owner_id,legacy_opp,'{"content":"Legacy verified CV"}','{"recipient":"","subject":"Legacy subject","body":"Legacy verified draft"}','legacy-replay');
  if (result->>'cv_id')::uuid<>legacy_cv or (result->>'email_draft_id')::uuid<>legacy_email or not (result->>'duplicate')::boolean or
     (result_two->>'cv_id')::uuid<>legacy_cv or (result_two->>'email_draft_id')::uuid<>legacy_email or not (result_two->>'duplicate')::boolean then raise exception 'legacy_artifact_replay_duplicated'; end if;
  if (select count(*) from public.cv_versions where opportunity_id=legacy_opp)<>1 or (select count(*) from public.email_drafts where opportunity_id=legacy_opp)<>1 or
     (select to_jsonb(c) from public.cv_versions c where id=legacy_cv) is distinct from legacy_cv_snapshot or
     (select to_jsonb(d) from public.email_drafts d where id=legacy_email) is distinct from legacy_email_snapshot then raise exception 'legacy_artifact_reuse_mutated_history'; end if;
  -- Genuine CV content or email subject changes append hashed versions; replay
  -- of those versions is also idempotent and legacy content/keys stay untouched.
  result:=public.automation_prepare_artifacts(owner_id,legacy_opp,'{"content":"Legacy verified CV, reordered"}','{"recipient":null,"subject":"Improved subject","body":"Legacy verified draft"}','legacy-new-version');
  result_two:=public.automation_prepare_artifacts(owner_id,legacy_opp,'{"content":"Legacy verified CV, reordered"}','{"recipient":null,"subject":"Improved subject","body":"Legacy verified draft"}','legacy-new-version');
  if not (result->>'cv_created')::boolean or not (result->>'email_created')::boolean or not (result_two->>'duplicate')::boolean or
     (select count(*) from public.cv_versions where opportunity_id=legacy_opp)<>2 or (select count(*) from public.email_drafts where opportunity_id=legacy_opp)<>2 then raise exception 'legacy_genuine_change_versioning_failed'; end if;
  if (select content from public.cv_versions where id=legacy_cv)<>'Legacy verified CV' or
     (select subject from public.email_drafts where id=legacy_email)<>'Legacy subject' or
     (select automation_content_key from public.cv_versions where id=legacy_cv) is not null or
     (select automation_content_key from public.email_drafts where id=legacy_email) is not null or
     (select automation_content_key from public.cv_versions where id=(result->>'cv_id')::uuid) is null or
     (select automation_content_key from public.email_drafts where id=(result->>'email_draft_id')::uuid) is null then raise exception 'legacy_content_or_future_hash_incorrect'; end if;

  insert into public.application_records(user_id,opportunity_id,organization,position,recipient_email,email_subject,application_status,sent_at,follow_up_at)
    values(owner_id,opp,'Controlled Test Lab',fixture,'recruiter@example.org','Controlled application','waiting',now()-interval '10 days',now()-interval '3 days') returning id into app;
  -- One follow-up draft per due event, including retries with no explicit artifact version.
  payload:=jsonb_build_object('user_id',owner_id,'application_id',app,'application_status','follow_up_needed','follow_up_key','fixture-due-1',
    'follow_up_draft',jsonb_build_object('recipient','recruiter@example.org','subject','Re: Controlled application','body','Controlled follow-up'));
  result:=public.automation_update_application(payload);
  result_two:=public.automation_update_application(payload);
  if (result->>'follow_up_draft_id') is null or not (result_two->>'duplicate')::boolean or (select count(*) from public.email_drafts where application_id=app)<>1 then raise exception 'follow_up_replay_duplicate'; end if;

  -- A threshold edit must not cause monitoring to change classification.
  update public.user_settings set match_threshold=1 where user_id=owner_id;
  payload:=jsonb_build_object('user_id',owner_id,'application_id',app,'application_status','interview','provider','gmail','provider_message_id',fixture||'-message','provider_thread_id',fixture||'-thread','message_received_at',first_response,'last_response_at',first_response);
  result:=public.automation_update_application(payload);
  result_two:=public.automation_update_application(payload);
  if not (result->>'status_updated')::boolean or not (result_two->>'duplicate')::boolean then raise exception 'reply_replay_not_idempotent'; end if;
  if (select count(*) from public.application_monitor_events where user_id=owner_id and provider_message_id=fixture||'-message')<>1 then raise exception 'reply_event_duplicate'; end if;
  if (select current_score from public.opportunity_records where id=opp)<>original_score or (select classification from public.opportunity_records where id=opp)<>original_class then raise exception 'monitor_changed_matching'; end if;
  result:=public.automation_update_application(payload||jsonb_build_object('provider_message_id',fixture||'-older','application_status','replied','message_received_at',first_response-interval '1 hour','last_response_at',first_response-interval '1 hour'));
  if not (result->>'stale')::boolean or (select application_status from public.application_records where id=app)<>'interview' or (select last_response_at from public.application_records where id=app)<>first_response then raise exception 'older_reply_regressed_application'; end if;

  insert into public.application_records(user_id,organization,position,recipient_email,email_subject,application_status,sent_at)
    values(owner_id,'Controlled Test Lab',fixture||'-second','recruiter@example.org','Controlled application','waiting',now()-interval '10 days') returning id into app_two;
  result:=public.automation_update_application(payload||jsonb_build_object('application_id',app_two));
  if not (result->>'duplicate')::boolean or not (result->>'ambiguous')::boolean or (select application_status from public.application_records where id=app_two)<>'waiting' then raise exception 'message_matched_multiple_applications'; end if;
end $$;
select 'Independent schedule contracts passed; fixtures rolled back' as result;
rollback;
