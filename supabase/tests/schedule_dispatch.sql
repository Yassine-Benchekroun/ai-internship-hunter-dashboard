-- LOCAL ONLY: mocks pg_cron registration, uses real due/lease/gate logic.
begin;
create schema cron;
create table cron.test_jobs(jobid bigint generated always as identity primary key,name text unique,schedule text,command text);
create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
declare result bigint; begin
  insert into cron.test_jobs(name,schedule,command) values($1,$2,$3)
    on conflict(name) do update set schedule=excluded.schedule,command=excluded.command returning jobid into result;
  return result;
end; $$;
do $$
declare owner_id uuid; result jsonb; request uuid; profile_run uuid; crashed_run uuid; discovery_run uuid; job_count integer;
begin
  select user_id into owner_id from public.user_settings order by created_at limit 1;
  perform public.automation_read_schedule_config(owner_id);
  result:=private.run_due_schedule(owner_id,'profile_sync');
  if result->>'status'<>'disabled' then raise exception 'recurrence_started_without_validation'; end if;
  insert into private.provider_connections(user_id,provider,account_email,status,access_token,scopes)
    values(owner_id,'gmail','fixture@example.org','connected','local-test-token',array['https://www.googleapis.com/auth/gmail.readonly'])
    on conflict(user_id,provider) do update set status='connected',access_token='local-test-token',scopes=excluded.scopes;
  update public.user_settings set provider_connection_status='connected' where user_id=owner_id;
  update public.schedule_configuration set manual_validations='{"profile_sync":{},"opportunity_discovery":{},"application_monitor":{}}',
    timezone=case when extract(hour from now() at time zone 'UTC')<12 then 'Etc/GMT-12' else 'UTC' end,
    profile_time='00:00',discovery_time='00:01',monitor_times=array['00:02'::time]
    where user_id=owner_id;
  result:=private.enable_recurring_schedules(owner_id);
  select count(*) into job_count from cron.test_jobs;
  if job_count<>3 then raise exception 'three_separate_jobs_required'; end if;
  perform private.enable_recurring_schedules(owner_id);
  if (select count(*) from cron.test_jobs)<>3 then raise exception 'recurrence_registration_duplicated'; end if;
  result:=private.run_due_schedule(owner_id,'opportunity_discovery');
  if result->>'status'<>'awaiting_profile' then raise exception 'daily_profile_dependency_ignored'; end if;
  result:=private.run_due_schedule(owner_id,'profile_sync');
  if result->>'status'<>'dispatched' then raise exception 'profile_due_not_dispatched'; end if;
  request:=(result->>'request_id')::uuid;
  result:=private.run_due_schedule(owner_id,'profile_sync');
  if result->>'status'<>'retry_backoff' then raise exception 'duplicate_dispatch'; end if;
  result:=public.automation_begin_schedule(owner_id,'profile_sync',request,false,'[]');
  profile_run:=(result->>'run_id')::uuid;
  perform public.automation_finish_schedule(profile_run,'completed','{"processed_records":2}','[]');
  result:=private.run_due_schedule(owner_id,'opportunity_discovery');
  if result->>'status'<>'dispatched' then raise exception 'discovery_not_independent_dispatch'; end if;
  result:=private.run_due_schedule(owner_id,'application_monitor');
  if result->>'status'<>'dispatched' then raise exception 'monitor_not_independent'; end if;
  result:=private.run_due_schedule(owner_id,'profile_sync');
  if result->>'status'<>'completed' then raise exception 'successful_daily_run_repeated'; end if;

  -- Disconnecting Gmail after activation cannot break another worker's finish.
  update public.user_settings set provider_connection_status='revoked' where user_id=owner_id;
  update private.provider_connections set status='revoked',access_token=null where user_id=owner_id and provider='gmail';
  result:=public.automation_begin_schedule(owner_id,'profile_sync',gen_random_uuid(),false,'[]');
  perform public.automation_finish_schedule((result->>'run_id')::uuid,'completed','{"processed_records":2}','[]');
  if (select status from public.schedule_runs where run_id=(result->>'run_id')::uuid)<>'completed' then raise exception 'mailbox_outage_blocked_profile_health'; end if;
  result:=public.automation_begin_schedule(owner_id,'opportunity_discovery',gen_random_uuid(),false,'[]');
  discovery_run:=(result->>'run_id')::uuid;
  perform public.automation_finish_schedule(discovery_run,'completed','{"processed_records":1}','[]');
  if (select status from public.schedule_runs where run_id=discovery_run)<>'completed' then raise exception 'mailbox_outage_blocked_discovery_health'; end if;
  -- Activation itself remains forbidden without a connected provider.
  begin
    update public.schedule_configuration set recurrence_enabled=false where user_id=owner_id;
    update public.schedule_configuration set recurrence_enabled=true where user_id=owner_id;
    raise exception 'disconnected_provider_activation_accepted';
  exception when others then if sqlerrm='disconnected_provider_activation_accepted' then raise; end if; end;

  -- A third-attempt worker that claimed a run then died must reach a terminal
  -- state, including its legacy profile log, and release Discovery's daily gate.
  update public.schedule_runs set started_at=now()-interval '2 days',finished_at=now()-interval '2 days'
    where user_id=owner_id and schedule_type='profile_sync' and status='completed';
  request:=gen_random_uuid();
  update private.schedule_dispatches set request_id=request,attempts=3,last_attempt_at=now()-interval '1 hour'
    where user_id=owner_id and schedule_type='profile_sync';
  result:=public.automation_begin_schedule(owner_id,'profile_sync',request,false,'[]');
  crashed_run:=(result->>'run_id')::uuid;
  update public.schedule_runs set lease_expires_at=now()-interval '1 second' where run_id=crashed_run;
  result:=private.run_due_schedule(owner_id,'opportunity_discovery');
  if result->>'status'<>'awaiting_profile' then raise exception 'crashed_profile_fixture_not_waiting'; end if;
  result:=private.run_due_schedule(owner_id,'profile_sync');
  if result->>'status'<>'retry_exhausted' or (select status from public.schedule_runs where run_id=crashed_run)<>'failed' or
     (select status from public.profile_sync_runs where run_id=crashed_run)<>'failed' then raise exception 'exhausted_worker_left_running'; end if;
  result:=private.run_due_schedule(owner_id,'opportunity_discovery');
  if result->>'status'='awaiting_profile' then raise exception 'exhausted_profile_blocked_discovery_fallback'; end if;

  -- Worker transport never responded: a bounded retry exhaustion becomes visible.
  update private.schedule_dispatches set attempts=3,last_attempt_at=now()-interval '1 hour'
    where user_id=owner_id and schedule_type='application_monitor';
  result:=private.run_due_schedule(owner_id,'application_monitor');
  if result->>'status'<>'retry_exhausted' or not exists(select 1 from public.schedule_runs where user_id=owner_id and schedule_type='application_monitor' and errors ? 'worker_dispatch_failed') then raise exception 'dispatch_failure_not_recorded'; end if;
end $$;
rollback;
