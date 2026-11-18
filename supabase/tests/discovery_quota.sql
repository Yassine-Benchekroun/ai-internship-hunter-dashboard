begin;

do $$
declare
  owner_id uuid := gen_random_uuid();
  another_owner_id uuid := gen_random_uuid();
  request_key uuid := gen_random_uuid();
  run_id_first uuid;
  run_id_retry uuid;
  run_id_preview uuid := gen_random_uuid();
  run_id_other uuid := gen_random_uuid();
  payload jsonb;
  record_id uuid;
  record_id_retry uuid;
  unrelated_record_id uuid;
  other_owner_record_id uuid;
  classification text;
  sections text[];
  midday timestamptz := '2030-01-02 12:00:00+00';
begin
  if public.classify_opportunity_score(69, 1) <> 'lower'
    or public.classify_opportunity_score(70, 99) <> 'top' then
    raise exception 'incorrect_fixed_score_boundaries';
  end if;
  if has_function_privilege('anon', 'public.automation_discovery_daily_count(uuid,timestamptz)', 'execute')
    or has_function_privilege('authenticated', 'public.automation_discovery_daily_count(uuid,timestamptz)', 'execute')
    or not has_function_privilege('service_role', 'public.automation_discovery_daily_count(uuid,timestamptz)', 'execute') then
    raise exception 'discovery_count_incorrect_grants';
  end if;

  insert into auth.users(id, email) values (owner_id,'quota@example.test'), (another_owner_id,'other-quota@example.test');
  insert into public.user_settings(user_id) values (owner_id), (another_owner_id) on conflict do nothing;
  insert into public.schedule_configuration(user_id,timezone) values (owner_id,'Asia/Tokyo'), (another_owner_id,'Asia/Tokyo')
  on conflict (user_id) do update set timezone=excluded.timezone;

  run_id_first := (public.automation_begin_schedule(owner_id,'opportunity_discovery',request_key,false)->>'run_id')::uuid;
  payload := jsonb_build_object('user_id',owner_id,'request_id',run_id_first,'source_name','opportunity_discovery',
    'opportunities', jsonb_build_array(jsonb_build_object('organization','Quota Fixture','position','AI Research Intern',
      'source_url','https://example.org/quota-one','domain_relevant',true,'match_score',69)));
  record_id := (public.automation_ingest_opportunities(payload)->'accepted'->0->>'opportunity_id')::uuid;
  perform public.automation_ingest_opportunities(payload);
  if record_id is null then raise exception 'discovery_test_ingest_failed'; end if;
  -- Tokyo January 2 starts at January 1 15:00 UTC.
  update public.opportunity_ingestion_events set received_at='2030-01-01 15:00:00+00' where request_id=run_id_first;
  perform public.automation_finish_schedule(run_id_first,'failed','{"processed_records":1}','["daily_target_not_reached"]');

  run_id_retry := (public.automation_begin_schedule(owner_id,'opportunity_discovery',request_key,false)->>'run_id')::uuid;
  perform public.automation_ingest_opportunities(payload || jsonb_build_object('request_id',run_id_retry));
  payload := jsonb_set(payload,'{opportunities,0,source_url}','"https://example.org/quota-two"')
    || jsonb_build_object('request_id',run_id_retry);
  record_id_retry := (public.automation_ingest_opportunities(payload)->'accepted'->0->>'opportunity_id')::uuid;
  if record_id_retry is null or record_id_retry = record_id then raise exception 'second_discovery_test_ingest_failed'; end if;
  update public.opportunity_ingestion_events set received_at='2030-01-02 14:59:59+00' where request_id=run_id_retry;

  insert into public.schedule_runs(run_id,user_id,schedule_type,request_id,dry_run,status)
  values (run_id_preview,owner_id,'opportunity_discovery',gen_random_uuid(),true,'completed'),
         (run_id_other,another_owner_id,'opportunity_discovery',gen_random_uuid(),false,'completed');
  insert into public.opportunity_records(user_id,organization,position,source_url)
  values(owner_id,'Quota Fixture','Manually added posting','https://example.org/quota-manual')
  returning id into unrelated_record_id;
  insert into public.opportunity_records(user_id,organization,position,source_url)
  values(another_owner_id,'Quota Fixture','Other owner posting','https://example.org/quota-other')
  returning id into other_owner_record_id;
  insert into public.opportunity_ingestion_events(request_id,user_id,opportunity_id,dedupe_key,action,source_name,received_at)
  values (run_id_preview,owner_id,unrelated_record_id,'dry-run','inserted','opportunity_discovery',midday),
         (gen_random_uuid(),owner_id,unrelated_record_id,'foreign-run','inserted','opportunity_discovery',midday),
         (run_id_other,owner_id,unrelated_record_id,'mismatched-owner','inserted','opportunity_discovery',midday),
         (run_id_other,another_owner_id,other_owner_record_id,'other-owner','inserted','opportunity_discovery',midday),
         (run_id_retry,owner_id,record_id_retry,'outside-local-day','inserted','opportunity_discovery','2030-01-02 15:00:00+00');

  if public.automation_discovery_daily_count(owner_id,midday) <> 2
    or public.automation_discovery_daily_count(another_owner_id,midday) <> 1
    or public.automation_discovery_daily_count(owner_id,'2030-01-01 14:59:59+00') <> 0
    or public.automation_discovery_daily_count(owner_id,'2030-01-02 15:00:00+00') <> 1 then
    raise exception 'incorrect_local_day_distinct_discovery_count';
  end if;

  update public.opportunity_records
  set active_sections=array['top']::text[], application_status='already_sent'
  where id=record_id returning opportunity_records.classification,active_sections into classification,sections;
  if classification <> 'lower' or sections <> array['lower']::text[] then
    raise exception 'score_69_was_not_lower';
  end if;
  update public.opportunity_records
  set active_sections=array['lower']::text[], current_score=70
  where id=record_id returning opportunity_records.classification,active_sections into classification,sections;
  if classification <> 'top' or sections <> array['top']::text[]
    or (select application_status from public.opportunity_records where id=record_id) <> 'already_sent' then
    raise exception 'score_70_was_not_top_or_application_status_was_changed';
  end if;
end;
$$;

rollback;
