-- Three independent workers. Recurrence is disabled until explicit live validation.
-- No provider credential, mailbox body, or outbound email operation is stored here.
begin;

create schema if not exists private;
create extension if not exists pg_net;

-- The hosted project deliberately removed default table grants. Explicit worker
-- grants are needed even for BYPASSRLS roles; browser privileges are unchanged.
grant select on public.user_settings,public.profile_facts,public.profile_fact_evidence,public.master_cv_versions,public.opportunity_ingestion_events to service_role;
grant select,insert,update on public.profile_sync_runs,public.opportunity_records,public.cv_versions,public.email_drafts to service_role;
grant select,update on public.application_records to service_role;
grant select,insert on public.application_monitor_events to service_role;

-- Older bootstrap migrations created an index while the RPC names a constraint.
-- Attach the existing index without rebuilding it or changing stored history.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.opportunity_ingestion_events'::regclass and conname='opportunity_ingestion_events_request_id_dedupe_key_key') then
    alter table public.opportunity_ingestion_events add constraint opportunity_ingestion_events_request_id_dedupe_key_key unique using index opportunity_ingestion_events_request_id_dedupe_key_key;
  end if;
end $$;

create table public.schedule_configuration (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'Africa/Casablanca',
  profile_time time not null default '07:00',
  discovery_time time not null default '08:00',
  monitor_times time[] not null default array['08:30'::time,'12:30'::time,'16:30'::time,'20:30'::time],
  max_profile_age_hours integer not null default 168 check (max_profile_age_hours between 1 and 2160),
  follow_up_days integer not null default 7 check (follow_up_days between 1 and 90),
  monitor_terminal boolean not null default false,
  approved_search_sources jsonb not null default '[]'::jsonb check (jsonb_typeof(approved_search_sources) = 'array'),
  search_queries jsonb not null default '[]'::jsonb check (jsonb_typeof(search_queries) = 'array'),
  recurrence_enabled boolean not null default false,
  automatic_sending_enabled boolean not null default false check (automatic_sending_enabled = false),
  manual_validations jsonb not null default '{}'::jsonb,
  last_successful_runs jsonb not null default '{}'::jsonb,
  project_url text not null default 'https://cjwsyitmoussjnjjgdsv.supabase.co',
  updated_at timestamptz not null default now(),
  check (profile_time < discovery_time)
);
insert into public.schedule_configuration(user_id) select user_id from public.user_settings on conflict do nothing;

create table public.schedule_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  schedule_type text not null check (schedule_type in ('profile_sync','opportunity_discovery','application_monitor')),
  request_id uuid not null,
  attempt integer not null default 1 check (attempt > 0),
  dry_run boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
  status text not null default 'running' check (status in ('running','completed','partial','blocked','failed')),
  sources jsonb not null default '[]'::jsonb,
  processed_records integer not null default 0 check (processed_records >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  counts jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  last_successful_run_at timestamptz,
  unique(user_id, schedule_type, request_id, attempt)
);
create index schedule_runs_user_type_started_idx on public.schedule_runs(user_id,schedule_type,started_at desc);
create unique index schedule_runs_one_running_idx on public.schedule_runs(user_id,schedule_type) where status = 'running';
alter table public.schedule_configuration enable row level security;
alter table public.schedule_runs enable row level security;
revoke all on public.schedule_configuration,public.schedule_runs from public,anon,authenticated;
grant select on public.schedule_configuration,public.schedule_runs to authenticated;
grant select,insert,update on public.schedule_configuration,public.schedule_runs to service_role;
create policy schedule_config_owner_read on public.schedule_configuration for select to authenticated using ((select auth.uid()) = user_id);
create policy schedule_runs_owner_read on public.schedule_runs for select to authenticated using ((select auth.uid()) = user_id);

create function public.automation_read_schedule_config(p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if not exists(select 1 from public.user_settings where user_id=p_user_id) then raise exception 'settings_unavailable'; end if;
  insert into public.schedule_configuration(user_id) values(p_user_id) on conflict do nothing;
  select to_jsonb(c) into v_result from public.schedule_configuration c where c.user_id=p_user_id;
  return v_result;
end; $$;

-- Owner may change operational preferences, never proof of validation or activation.
create function public.save_schedule_configuration(p_configuration jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_timezone text; v_times time[];
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(p_configuration) <> 'object' or exists(select 1 from jsonb_object_keys(p_configuration) k where k not in
    ('timezone','profile_time','discovery_time','monitor_times','max_profile_age_hours','follow_up_days','monitor_terminal','approved_search_sources','search_queries'))
    then raise exception 'unsupported_configuration_field'; end if;
  v_timezone := p_configuration->>'timezone';
  if v_timezone is not null and not exists(select 1 from pg_timezone_names where name=v_timezone) then raise exception 'invalid_timezone'; end if;
  if p_configuration ? 'monitor_times' then
    select array_agg(value::time order by value::time) into v_times from jsonb_array_elements_text(p_configuration->'monitor_times');
    if coalesce(cardinality(v_times),0) not between 1 and 6 then raise exception 'invalid_monitor_times'; end if;
    if exists(select 1 from unnest(v_times) with ordinality t(value,ord) where ord>1 and value-v_times[ord-1] < interval '2 hours')
      then raise exception 'monitor_interval_too_short'; end if;
    if cardinality(v_times)>1 and interval '24 hours'-(v_times[cardinality(v_times)]-v_times[1])<interval '2 hours' then raise exception 'monitor_interval_too_short'; end if;
    if interval '24 hours'-(v_times[cardinality(v_times)]-v_times[1]) < interval '2 hours' then raise exception 'monitor_interval_too_short'; end if;
  end if;
  insert into public.schedule_configuration(user_id) values(v_user) on conflict do nothing;
  update public.schedule_configuration set
    timezone=coalesce(v_timezone,timezone),
    profile_time=coalesce((p_configuration->>'profile_time')::time,profile_time),
    discovery_time=coalesce((p_configuration->>'discovery_time')::time,discovery_time),
    monitor_times=coalesce(v_times,monitor_times),
    max_profile_age_hours=coalesce((p_configuration->>'max_profile_age_hours')::integer,max_profile_age_hours),
    follow_up_days=coalesce((p_configuration->>'follow_up_days')::integer,follow_up_days),
    monitor_terminal=coalesce((p_configuration->>'monitor_terminal')::boolean,monitor_terminal),
    approved_search_sources=coalesce(p_configuration->'approved_search_sources',approved_search_sources),
    search_queries=coalesce(p_configuration->'search_queries',search_queries),
    recurrence_enabled=false, manual_validations='{}'::jsonb, updated_at=now()
    where user_id=v_user;
  return (select to_jsonb(c)-'project_url' from public.schedule_configuration c where c.user_id=v_user);
end; $$;

create function public.automation_begin_schedule(p_user_id uuid,p_schedule_type text,p_request_id uuid,p_dry_run boolean,p_sources jsonb default '[]') returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_run public.schedule_runs%rowtype; v_attempt integer; v_last timestamptz; v_sources jsonb:=p_sources; v_expired uuid[];
begin
  if p_schedule_type not in ('profile_sync','opportunity_discovery','application_monitor') or p_request_id is null then raise exception 'invalid_schedule_request'; end if;
  if jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)>100 then raise exception 'invalid_source_list'; end if;
  perform public.automation_read_schedule_config(p_user_id);
  if jsonb_array_length(v_sources)=0 then
    if p_schedule_type='profile_sync' then select approved_profile_sources into v_sources from public.user_settings where user_id=p_user_id;
    elsif p_schedule_type='opportunity_discovery' then select approved_search_sources into v_sources from public.schedule_configuration where user_id=p_user_id;
    else v_sources:='[{"provider":"gmail"}]'::jsonb; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||'|schedule|'||p_schedule_type,0));
  -- Each retry gets its own history row; completed requests are replay-safe.
  select * into v_run from public.schedule_runs where user_id=p_user_id and schedule_type=p_schedule_type and request_id=p_request_id order by attempt desc limit 1;
  if found and v_run.dry_run is distinct from p_dry_run then raise exception 'request_id_reused_with_different_mode'; end if;
  if v_run.status='completed' then return jsonb_build_object('run_id',v_run.run_id,'acquired',false,'status',v_run.status,'duplicate',true); end if;
  v_attempt:=coalesce(v_run.attempt,0)+1;
  with expired as (
    update public.schedule_runs set status='failed',finished_at=now(),errors='["lease_expired"]'::jsonb
      where user_id=p_user_id and schedule_type=p_schedule_type and status='running' and lease_expires_at<=now() returning run_id
  ) select array_agg(run_id) into v_expired from expired;
  if p_schedule_type='profile_sync' then
    update public.profile_sync_runs set status='failed',completed_at=now(),errors='["lease_expired"]'::jsonb where run_id=any(v_expired) and status='running';
  elsif p_schedule_type='application_monitor' then
    update public.application_monitor_runs set status='failed',completed_at=now(),errors='["lease_expired"]'::jsonb where run_id=any(v_expired) and status='running';
  end if;
  select * into v_run from public.schedule_runs where user_id=p_user_id and schedule_type=p_schedule_type and status='running';
  if found then return jsonb_build_object('run_id',v_run.run_id,'acquired',false,'status','running','duplicate',false); end if;
  select max(finished_at) into v_last from public.schedule_runs where user_id=p_user_id and schedule_type=p_schedule_type and status in ('completed','partial') and not dry_run and processed_records>0;
  insert into public.schedule_runs(user_id,schedule_type,request_id,attempt,dry_run,sources,last_successful_run_at)
    values(p_user_id,p_schedule_type,p_request_id,v_attempt,p_dry_run,v_sources,v_last) returning * into v_run;
  if p_schedule_type='profile_sync' then
    insert into public.profile_sync_runs(run_id,user_id,started_at,status,sources_checked) values(v_run.run_id,p_user_id,v_run.started_at,'running',v_sources);
  elsif p_schedule_type='application_monitor' then
    insert into public.application_monitor_runs(run_id,user_id,started_at,status,dry_run) values(v_run.run_id,p_user_id,v_run.started_at,'running',p_dry_run);
  end if;
  return jsonb_build_object('run_id',v_run.run_id,'acquired',true,'started_at',v_run.started_at,'dry_run',v_run.dry_run,'attempt',v_attempt);
end; $$;

create function public.automation_finish_schedule(p_run_id uuid,p_status text,p_counts jsonb,p_errors jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_run public.schedule_runs%rowtype; v_counts jsonb:='{}'; v_errors jsonb:='[]'; v_key text; v_value jsonb;
begin
  if p_status not in ('completed','partial','blocked','failed') then raise exception 'invalid_final_status'; end if;
  if jsonb_typeof(p_counts)<>'object' or jsonb_typeof(p_errors)<>'array' then raise exception 'invalid_run_summary'; end if;
  -- Only numeric counters and bounded error codes cross the operational logging boundary.
  for v_key,v_value in select * from jsonb_each(p_counts) loop
    if v_key ~ '^[a-z][a-z0-9_]{0,63}$' and jsonb_typeof(v_value)='number' and v_value::text ~ '^[0-9]{1,8}$' then v_counts:=v_counts||jsonb_build_object(v_key,v_value); end if;
  end loop;
  for v_value in select value from jsonb_array_elements(p_errors) limit 100 loop
    if jsonb_typeof(v_value)='string' and (v_value#>>'{}') ~ '^[a-z][a-z0-9_]{0,79}$' then v_errors:=v_errors||jsonb_build_array(v_value);
    else v_errors:=v_errors||'"worker_error"'::jsonb; end if;
  end loop;
  select * into v_run from public.schedule_runs where run_id=p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if v_run.status<>'running' then return jsonb_build_object('run_id',v_run.run_id,'status',v_run.status,'duplicate',true); end if;
  update public.schedule_runs set status=p_status,finished_at=now(),counts=v_counts,errors=v_errors,
    processed_records=coalesce((v_counts->>'processed_records')::integer,(v_counts->>'records_discovered')::integer,(v_counts->>'applications_considered')::integer,0),
    inserted_count=coalesce((v_counts->>'inserted_count')::integer,(v_counts->>'records_inserted')::integer,0),
    updated_count=coalesce((v_counts->>'updated_count')::integer,(v_counts->>'records_updated')::integer,(v_counts->>'applications_updated')::integer,0),
    duplicate_count=coalesce((v_counts->>'duplicate_count')::integer,(v_counts->>'duplicates_ignored')::integer,0),
    warning_count=coalesce((v_counts->>'warning_count')::integer,jsonb_array_length(v_errors))
    where run_id=p_run_id returning * into v_run;
  if v_run.schedule_type='profile_sync' then
    update public.profile_sync_runs set status=p_status,completed_at=now(),errors=v_errors where run_id=p_run_id;
  elsif v_run.schedule_type='application_monitor' then
    update public.application_monitor_runs set status=p_status,completed_at=now(),errors=v_errors,
      messages_scanned=coalesce((v_counts->>'messages_scanned')::integer,0),
      applications_considered=coalesce((v_counts->>'applications_inspected')::integer,v_run.processed_records),
      applications_updated=coalesce((v_counts->>'statuses_updated')::integer,v_run.updated_count),
      follow_up_drafts_created=coalesce((v_counts->>'follow_up_drafts_created')::integer,(v_counts->>'drafts_created')::integer,0),
      duplicates_ignored=v_run.duplicate_count where run_id=p_run_id;
  end if;
  if p_status in ('completed','partial') and not v_run.dry_run and v_run.processed_records>0 then
    update public.schedule_configuration set last_successful_runs=jsonb_set(last_successful_runs,array[v_run.schedule_type],to_jsonb(v_run.finished_at)),updated_at=now() where user_id=v_run.user_id;
    update public.schedule_runs set last_successful_run_at=finished_at where run_id=p_run_id;
  end if;
  return jsonb_build_object('run_id',p_run_id,'status',p_status,'counts',v_counts,'errors',v_errors);
end; $$;

-- Existing profile/monitor logs accept the same blocked state as the shared history.
alter table public.profile_sync_runs drop constraint if exists profile_sync_runs_status_check;
alter table public.profile_sync_runs add constraint profile_sync_runs_status_check check(status in ('pending','running','completed','partial','blocked','failed'));
alter table public.application_monitor_runs drop constraint if exists application_monitor_runs_status_check;
alter table public.application_monitor_runs add constraint application_monitor_runs_status_check check(status in ('running','completed','partial','blocked','failed','skipped'));
do $$ declare definition text; begin
  select pg_get_functiondef('public.automation_sync_profile(jsonb)'::regprocedure) into definition;
  definition:=replace(definition,'''pending'', ''running'', ''completed'', ''partial'', ''failed''','''pending'', ''running'', ''completed'', ''partial'', ''blocked'', ''failed''');
  definition:=replace(definition,'''completed'', ''partial'', ''failed''','''completed'', ''partial'', ''blocked'', ''failed''');
  execute definition;
  select pg_get_functiondef('public.automation_log_application_monitor_run(jsonb)'::regprocedure) into definition;
  execute replace(definition,'''running'', ''completed'', ''partial'', ''failed'', ''skipped''','''running'', ''completed'', ''partial'', ''blocked'', ''failed'', ''skipped''');
end $$;

alter table public.cv_versions add column automation_content_key text;
alter table public.email_drafts add column automation_content_key text;
alter table public.email_drafts add column follow_up_key text;
alter table public.application_records add column monitoring_needs_review boolean not null default false;
alter table public.application_records add column provider_thread_id text check(provider_thread_id is null or length(provider_thread_id)<=512);
alter table public.application_records add column provider_message_id text check(provider_message_id is null or length(provider_message_id)<=512);
create unique index cv_versions_automation_content_uidx on public.cv_versions(user_id,opportunity_id,automation_content_key) where automation_content_key is not null;
create unique index email_drafts_automation_content_uidx on public.email_drafts(user_id,opportunity_id,automation_content_key) where automation_content_key is not null;
create unique index email_drafts_follow_up_key_uidx on public.email_drafts(user_id,application_id,follow_up_key) where follow_up_key is not null;

-- Only artifacts created by automation become immutable; existing human draft editing remains available.
create function private.protect_automation_artifact() returns trigger language plpgsql set search_path='' as $$
begin
  if old.automation_content_key is not null or (to_jsonb(old)->>'follow_up_key') is not null then
    if (to_jsonb(new)-array['is_current','updated_at']) is distinct from (to_jsonb(old)-array['is_current','updated_at']) then
      raise exception 'automation_artifacts_are_immutable_create_a_new_version';
    end if;
  end if;
  return new;
end; $$;
create trigger protect_automation_cv before update on public.cv_versions for each row execute function private.protect_automation_artifact();
create trigger protect_automation_draft before update on public.email_drafts for each row execute function private.protect_automation_artifact();

create function public.automation_prepare_artifacts(p_user_id uuid,p_opportunity_id uuid,p_cv jsonb,p_email jsonb,p_content_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_cv_id uuid; v_email_id uuid; v_version integer; v_cv_key text; v_email_key text; v_cv_created boolean:=false; v_email_created boolean:=false;
begin
  if nullif(p_content_key,'') is null or length(p_content_key)>128 then raise exception 'invalid_content_key'; end if;
  perform 1 from public.opportunity_records where id=p_opportunity_id and user_id=p_user_id for update;
  if not found then raise exception 'opportunity_not_found'; end if;
  if p_cv is not null and jsonb_typeof(p_cv)<>'null' then
    if jsonb_typeof(p_cv)<>'object' or nullif(btrim(p_cv->>'content'),'') is null then raise exception 'invalid_cv'; end if;
    v_cv_key:=encode(extensions.digest(convert_to(p_cv->>'content','UTF8'),'sha256'),'hex');
    select id into v_cv_id from public.cv_versions where user_id=p_user_id and opportunity_id=p_opportunity_id and automation_content_key=v_cv_key;
    if v_cv_id is null then
      select coalesce(max(version),0)+1 into v_version from public.cv_versions where user_id=p_user_id and opportunity_id=p_opportunity_id;
      update public.cv_versions set is_current=false where user_id=p_user_id and opportunity_id=p_opportunity_id and is_current;
      insert into public.cv_versions(user_id,opportunity_id,version,is_current,change_summary,content,automation_content_key)
        values(p_user_id,p_opportunity_id,v_version,true,left(p_cv->>'change_summary',500),p_cv->>'content',v_cv_key) returning id into v_cv_id;
      v_cv_created:=true;
    end if;
  end if;
  if p_email is not null and jsonb_typeof(p_email)<>'null' then
    if jsonb_typeof(p_email)<>'object' or nullif(btrim(p_email->>'body'),'') is null then raise exception 'invalid_email_draft'; end if;
    v_email_key:=encode(extensions.digest(convert_to(jsonb_build_object('recipient',p_email->>'recipient','subject',p_email->>'subject','body',p_email->>'body')::text,'UTF8'),'sha256'),'hex');
    select id into v_email_id from public.email_drafts where user_id=p_user_id and opportunity_id=p_opportunity_id and automation_content_key=v_email_key;
    if v_email_id is null then
      select coalesce(max(version),0)+1 into v_version from public.email_drafts where user_id=p_user_id and opportunity_id=p_opportunity_id;
      update public.email_drafts set is_current=false where user_id=p_user_id and opportunity_id=p_opportunity_id and is_current;
      insert into public.email_drafts(user_id,opportunity_id,version,is_current,recipient,subject,body,automation_content_key)
        values(p_user_id,p_opportunity_id,v_version,true,nullif(p_email->>'recipient',''),p_email->>'subject',p_email->>'body',v_email_key) returning id into v_email_id;
      v_email_created:=true;
    end if;
  end if;
  -- Preparation readiness does not imply a sent application or alter match classification.
  update public.opportunity_records set status='Needs review' where id=p_opportunity_id and user_id=p_user_id and application_status='not_sent';
  return jsonb_build_object('cv_id',v_cv_id,'email_draft_id',v_email_id,'cv_created',v_cv_created,'email_created',v_email_created,'duplicate',not v_cv_created and not v_email_created);
end; $$;

-- Application transitions are independent of score recalculation, including after a threshold change.
-- A verified single-posting URL remains the same opportunity when its title is
-- corrected. Multi-posting feeds retain organization/position/external identity.
do $$ declare definition text; updated text; begin
  select pg_get_functiondef('public.ingest_opportunity_record(uuid,jsonb,uuid)'::regprocedure) into definition;
  definition:=replace(definition,chr(13),'');
  updated:=replace(definition,
    $needle$perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_dedupe_key, 0));$needle$,
    $replacement$perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || case when p_record->>'source_is_single_posting'='true' then 'url|'||v_source_url else v_dedupe_key end, 0));$replacement$);
  updated:=replace(updated,
    $needle$where opportunities.user_id = p_user_id and opportunities.dedupe_key = v_dedupe_key
  for update;$needle$,
    $replacement$where opportunities.user_id = p_user_id and (opportunities.dedupe_key = v_dedupe_key or
      (p_record->>'source_is_single_posting'='true' and public.normalize_opportunity_url(opportunities.source_url)=v_source_url and
       (nullif(p_record->>'external_id','') is null or opportunities.external_id is null or opportunities.external_id=p_record->>'external_id')))
  order by case when opportunities.dedupe_key=v_dedupe_key then 0 else 1 end, opportunities.created_at
  limit 1 for update;$replacement$);
  if updated=definition or position('order by case when opportunities.dedupe_key=v_dedupe_key' in updated)=0 then raise exception 'ingestion_identity_patch_missing'; end if;
  execute updated;
end $$;

do $$ declare definition text; begin
  select pg_get_functiondef('public.prepare_opportunity_record()'::regprocedure) into definition;
  if position('begin' in definition)=0 then raise exception 'opportunity_trigger_definition_unavailable'; end if;
  definition:=regexp_replace(definition,'begin',
    E'begin\n  if TG_OP = ''UPDATE'' and (to_jsonb(new)-array[''application_status'',''sent'',''updated_at'']) = (to_jsonb(old)-array[''application_status'',''sent'',''updated_at'']) then\n    return new;\n  end if;');
  execute definition;
end $$;

alter table public.application_monitor_events drop constraint if exists application_monitor_events_detected_status_check;
alter table public.application_monitor_events add constraint application_monitor_events_detected_status_check check(detected_status in ('replied','interview','offer','rejected','no_response','follow_up_needed','closed'));
create index application_monitor_events_message_idx on public.application_monitor_events(user_id,provider,provider_message_id);

create or replace function public.automation_update_application(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  v_user uuid; v_app uuid; v_row public.application_records%rowtype; v_status text;
  v_provider text:=coalesce(p_payload->>'provider','gmail'); v_message text:=nullif(p_payload->>'provider_message_id','');
  v_received timestamptz; v_event uuid; v_event_app uuid; v_draft jsonb:=p_payload->'follow_up_draft';
  v_draft_id uuid; v_key text; v_version integer; v_stale boolean:=false; v_changed boolean:=false;
  v_response timestamptz; v_followup timestamptz; v_notes text; v_review boolean;
begin
  if jsonb_typeof(p_payload)<>'object' then raise exception 'invalid_application_payload'; end if;
  v_user:=(p_payload->>'user_id')::uuid; v_app:=(p_payload->>'application_id')::uuid;
  if v_user is null or v_app is null then raise exception 'application_owner_required'; end if;
  -- Lock provider message before application, preventing cross-application races and deadlocks.
  if v_message is not null then
    if v_provider<>'gmail' or length(v_message)>512 then raise exception 'invalid_provider_message'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_user::text||'|message|'||v_provider||'|'||v_message,0));
  end if;
  select * into v_row from public.application_records where user_id=v_user and id=v_app for update;
  if not found then raise exception 'application_not_found'; end if;
  if p_payload ? 'opportunity_id' and (p_payload->>'opportunity_id')::uuid is distinct from v_row.opportunity_id then raise exception 'application_link_cannot_change'; end if;
  v_status:=coalesce(nullif(p_payload->>'application_status',''),v_row.application_status);
  if v_status not in ('not_sent','ready','already_sent','sent','waiting','replied','interview','offer','rejected','no_response','follow_up_needed','closed') then raise exception 'invalid_application_status'; end if;
  if v_message is not null then
    if v_row.sent_at is null then raise exception 'sent_evidence_required'; end if;
    select id,application_id into v_event,v_event_app from public.application_monitor_events where user_id=v_user and provider=v_provider and provider_message_id=v_message order by created_at limit 1;
    if v_event is not null then
      return jsonb_build_object('application_id',v_app,'opportunity_id',v_row.opportunity_id,'application_status',v_row.application_status,'event_id',v_event,'duplicate',true,'ambiguous',v_event_app<>v_app,'status_updated',false);
    end if;
    v_received:=coalesce((p_payload->>'message_received_at')::timestamptz,(p_payload->>'last_response_at')::timestamptz);
    if v_received is null or v_received<v_row.sent_at or v_received>now()+interval '5 minutes' then raise exception 'invalid_reply_timestamp'; end if;
    v_stale:=v_row.last_response_at is not null and v_received<=v_row.last_response_at;
  end if;
  if v_draft is not null and jsonb_typeof(v_draft)<>'null' then
    if jsonb_typeof(v_draft)<>'object' or nullif(btrim(v_draft->>'body'),'') is null or v_status<>'follow_up_needed' then raise exception 'invalid_follow_up_draft'; end if;
    if v_row.sent_at is null or v_row.last_response_at is not null or v_row.application_status not in ('already_sent','sent','waiting','no_response','follow_up_needed') then raise exception 'follow_up_not_eligible'; end if;
    v_key:=coalesce(nullif(p_payload->>'follow_up_key',''),nullif(v_draft->>'follow_up_key',''),encode(extensions.digest(convert_to(v_app::text||'|'||v_row.sent_at::text||'|'||coalesce(v_row.follow_up_at::text,''),'UTF8'),'sha256'),'hex'));
    if length(v_key)>160 then raise exception 'invalid_follow_up_key'; end if;
    select id into v_draft_id from public.email_drafts where user_id=v_user and application_id=v_app and follow_up_key=v_key;
    if v_draft_id is not null then return jsonb_build_object('application_id',v_app,'application_status',v_row.application_status,'follow_up_draft_id',v_draft_id,'duplicate',true,'status_updated',false); end if;
    -- Lock linked opportunity to serialize all version allocators, including discovery.
    if v_row.opportunity_id is not null then perform 1 from public.opportunity_records where user_id=v_user and id=v_row.opportunity_id for update; end if;
    select coalesce(max(version),0)+1 into v_version from public.email_drafts where user_id=v_user and opportunity_id is not distinct from v_row.opportunity_id;
    update public.email_drafts set is_current=false where user_id=v_user and opportunity_id is not distinct from v_row.opportunity_id and is_current;
    insert into public.email_drafts(user_id,opportunity_id,application_id,recipient,subject,body,version,is_current,follow_up_key)
      values(v_user,v_row.opportunity_id,v_app,nullif(v_draft->>'recipient',''),v_draft->>'subject',v_draft->>'body',v_version,true,v_key) returning id into v_draft_id;
  end if;
  if v_message is not null then
    insert into public.application_monitor_events(user_id,application_id,provider,provider_message_id,provider_thread_id,message_received_at,event_type,detected_status)
      values(v_user,v_app,v_provider,v_message,nullif(p_payload->>'provider_thread_id',''),v_received,'reply_detected',v_status) returning id into v_event;
  end if;
  if v_stale then return jsonb_build_object('application_id',v_app,'application_status',v_row.application_status,'event_id',v_event,'duplicate',false,'stale',true,'status_updated',false); end if;
  -- Uncertain replies do not regress a known interview/terminal outcome.
  if v_status='replied' and v_row.application_status in ('interview','offer','rejected','closed') then v_status:=v_row.application_status; end if;
  v_response:=greatest(v_row.last_response_at,v_received,(p_payload->>'last_response_at')::timestamptz);
  v_followup:=case when p_payload ? 'follow_up_at' then (p_payload->>'follow_up_at')::timestamptz else v_row.follow_up_at end;
  v_notes:=case when p_payload ? 'notes' then left(p_payload->>'notes',2000) else v_row.notes end;
  v_review:=coalesce((p_payload->>'needs_review')::boolean,v_row.monitoring_needs_review);
  v_changed:=v_status is distinct from v_row.application_status or v_response is distinct from v_row.last_response_at or v_followup is distinct from v_row.follow_up_at or v_review is distinct from v_row.monitoring_needs_review or v_notes is distinct from v_row.notes or (v_message is not null and v_row.provider_thread_id is null and nullif(p_payload->>'provider_thread_id','') is not null);
  if v_changed then
    update public.application_records set application_status=v_status,last_response_at=v_response,follow_up_at=v_followup,notes=v_notes,monitoring_needs_review=v_review,
      provider_thread_id=case when v_message is not null then coalesce(provider_thread_id,nullif(p_payload->>'provider_thread_id','')) else provider_thread_id end where id=v_app and user_id=v_user;
    if v_row.opportunity_id is not null and v_status is distinct from v_row.application_status then
      update public.opportunity_records set application_status=v_status where id=v_row.opportunity_id and user_id=v_user;
    end if;
  end if;
  return jsonb_build_object('application_id',v_app,'opportunity_id',v_row.opportunity_id,'application_status',v_status,'follow_up_draft_id',v_draft_id,'event_id',v_event,'duplicate',false,'status_updated',v_changed);
end; $$;
revoke all on function public.automation_update_application(jsonb) from public,anon,authenticated;
grant execute on function public.automation_update_application(jsonb) to service_role;

create table private.schedule_tickets (
  ticket_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  schedule_type text not null check(schedule_type in ('profile_sync','opportunity_discovery','application_monitor')),
  expires_at timestamptz not null default(now()+interval '5 minutes'),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index schedule_tickets_user_idx on private.schedule_tickets(user_id);
alter table private.schedule_tickets enable row level security;
revoke all on private.schedule_tickets from public,anon,authenticated,service_role;

create function public.automation_consume_schedule_ticket(p_ticket text,p_schedule_type text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
  if length(p_ticket)<>64 then return null; end if;
  update private.schedule_tickets set consumed_at=now()
    where ticket_hash=encode(extensions.digest(convert_to(p_ticket,'UTF8'),'sha256'),'hex') and schedule_type=p_schedule_type and consumed_at is null and expires_at>now()
    returning user_id into v_user;
  return case when v_user is null then null else jsonb_build_object('user_id',v_user) end;
end; $$;

create function private.dispatch_schedule(p_user_id uuid,p_schedule_type text,p_dry_run boolean default true,p_request_id uuid default null) returns bigint
language plpgsql security definer set search_path='' as $$
declare v_ticket text:=encode(extensions.gen_random_bytes(32),'hex'); v_url text; v_slug text; v_request bigint;
begin
  v_slug:=case p_schedule_type when 'profile_sync' then 'sync-profile' when 'opportunity_discovery' then 'discover-opportunities' when 'application_monitor' then 'application-monitor' end;
  if v_slug is null then raise exception 'invalid_schedule_type'; end if;
  perform public.automation_read_schedule_config(p_user_id);
  select project_url into v_url from public.schedule_configuration where user_id=p_user_id;
  if v_url !~ '^https://[a-z0-9]+\.supabase\.co$' then raise exception 'invalid_project_url'; end if;
  insert into private.schedule_tickets(ticket_hash,user_id,schedule_type)
    values(encode(extensions.digest(convert_to(v_ticket,'UTF8'),'sha256'),'hex'),p_user_id,p_schedule_type);
  select net.http_post(url:=v_url||'/functions/v1/'||v_slug,
    headers:=jsonb_build_object('Content-Type','application/json','x-schedule-ticket',v_ticket),
    body:=jsonb_build_object('dry_run',p_dry_run,'request_id',coalesce(p_request_id,gen_random_uuid())),timeout_milliseconds:=120000) into v_request;
  return v_request;
end; $$;

-- Manual attestation can only reference two successful, real worker runs of this owner/type.
create function public.automation_record_schedule_validation(p_user_id uuid,p_schedule_type text,p_run_ids uuid[]) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_count integer;
begin
  if p_schedule_type not in ('profile_sync','opportunity_discovery','application_monitor') or cardinality(p_run_ids)<2 then raise exception 'two_manual_runs_required'; end if;
  select count(distinct run_id) into v_count from public.schedule_runs where run_id=any(p_run_ids) and user_id=p_user_id and schedule_type=p_schedule_type and status in ('completed','partial') and not dry_run and processed_records>0 and jsonb_array_length(errors)=0;
  if v_count<>cardinality(p_run_ids) then raise exception 'successful_live_validation_required'; end if;
  update public.schedule_configuration set manual_validations=jsonb_set(manual_validations,array[p_schedule_type],jsonb_build_object('validated_at',now(),'run_ids',to_jsonb(p_run_ids))),updated_at=now() where user_id=p_user_id;
  return jsonb_build_object('validated',true,'schedule_type',p_schedule_type);
end; $$;

create function private.guard_schedule_activation() returns trigger language plpgsql set search_path='' as $$
begin
  -- Check dependencies when recurrence is activated. A later mailbox outage
  -- must not prevent independent profile/discovery health updates from finishing.
  if new.recurrence_enabled and (TG_OP='INSERT' or not coalesce(old.recurrence_enabled,false)) and
    (not (new.manual_validations ?& array['profile_sync','opportunity_discovery','application_monitor']) or
    not exists(select 1 from public.user_settings where user_id=new.user_id and provider_connection_status='connected') or
    not exists(select 1 from private.provider_connections where user_id=new.user_id and provider='gmail' and status='connected' and access_token is not null and 'https://www.googleapis.com/auth/gmail.readonly'=any(scopes))) then
    raise exception 'all_manual_validations_and_mailbox_authorization_required';
  end if;
  return new;
end; $$;
create trigger guard_schedule_activation before insert or update on public.schedule_configuration for each row execute function private.guard_schedule_activation();

-- Dispatch slots are independent per worker. Merely installing these functions
-- creates NO recurring jobs; enable_recurring_schedules must be called later.
create table private.schedule_dispatches (
  user_id uuid not null references auth.users(id) on delete cascade,
  schedule_type text not null check(schedule_type in ('profile_sync','opportunity_discovery','application_monitor')),
  local_slot timestamp not null,
  request_id uuid not null default gen_random_uuid(),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  http_request_id bigint,
  primary key(user_id,schedule_type,local_slot)
);
alter table private.schedule_dispatches enable row level security;
revoke all on private.schedule_dispatches from public,anon,authenticated,service_role;

create function private.run_due_schedule(p_user_id uuid,p_schedule_type text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.schedule_configuration%rowtype; slot timestamp; local_now timestamp;
  dispatch private.schedule_dispatches%rowtype; prior public.schedule_runs%rowtype; result jsonb; http_id bigint;
begin
  if p_schedule_type not in ('profile_sync','opportunity_discovery','application_monitor') then raise exception 'invalid_schedule_type'; end if;
  select * into c from public.schedule_configuration where user_id=p_user_id;
  if not found or not c.recurrence_enabled then return '{"status":"disabled"}'::jsonb; end if;
  local_now:=now() at time zone c.timezone;
  if p_schedule_type='profile_sync' then slot:=local_now::date+c.profile_time;
  elsif p_schedule_type='opportunity_discovery' then slot:=local_now::date+c.discovery_time;
  else select max(local_now::date+t) into slot from unnest(c.monitor_times) t where local_now::date+t<=local_now; end if;
  if slot is null or slot>local_now then return '{"status":"not_due"}'::jsonb; end if;
  if p_schedule_type='opportunity_discovery' and exists(select 1 from public.schedule_runs where user_id=p_user_id and schedule_type='profile_sync' and status='running' and lease_expires_at>now()) then return '{"status":"awaiting_profile"}'::jsonb; end if;
  if p_schedule_type='opportunity_discovery' and not exists(select 1 from public.schedule_runs where user_id=p_user_id and schedule_type='profile_sync' and started_at >= (local_now::date::timestamp at time zone c.timezone) and status in ('completed','partial','blocked','failed')) then return '{"status":"awaiting_profile"}'::jsonb; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||'|dispatch|'||p_schedule_type,0));
  insert into private.schedule_dispatches(user_id,schedule_type,local_slot) values(p_user_id,p_schedule_type,slot) on conflict do nothing;
  select * into dispatch from private.schedule_dispatches where user_id=p_user_id and schedule_type=p_schedule_type and local_slot=slot for update;
  select * into prior from public.schedule_runs where user_id=p_user_id and schedule_type=p_schedule_type and request_id=dispatch.request_id order by attempt desc limit 1;
  if prior.status='completed' then return '{"status":"completed"}'::jsonb; end if;
  if prior.status='running' and prior.lease_expires_at>now() then return '{"status":"running"}'::jsonb; end if;
  if dispatch.last_attempt_at>now()-interval '15 minutes' then return '{"status":"retry_backoff"}'::jsonb; end if;
  if dispatch.attempts>=3 then
    if prior.status='running' and prior.lease_expires_at<=now() then
      -- The final dispatched worker may have died after claiming its run.
      -- Finish both the shared row and its legacy log so dependents can fall back.
      perform public.automation_finish_schedule(prior.run_id,'failed',prior.counts,prior.errors||'["lease_expired"]'::jsonb);
    elsif prior.run_id is null then
      result:=public.automation_begin_schedule(p_user_id,p_schedule_type,dispatch.request_id,false,'[]');
      if (result->>'acquired')::boolean then perform public.automation_finish_schedule((result->>'run_id')::uuid,'failed','{}','["worker_dispatch_failed"]'); end if;
    end if;
    return '{"status":"retry_exhausted"}'::jsonb;
  end if;
  http_id:=private.dispatch_schedule(p_user_id,p_schedule_type,false,dispatch.request_id);
  update private.schedule_dispatches set attempts=attempts+1,last_attempt_at=now(),http_request_id=http_id where user_id=p_user_id and schedule_type=p_schedule_type and local_slot=slot;
  return jsonb_build_object('status','dispatched','request_id',dispatch.request_id);
end; $$;

create function private.enable_recurring_schedules(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare kind text; job_id bigint; jobs jsonb:='{}';
begin
  -- The table trigger verifies all three live manual validations and real OAuth.
  update public.schedule_configuration set recurrence_enabled=true where user_id=p_user_id;
  if not found then raise exception 'owner_configuration_missing'; end if;
  if to_regnamespace('cron') is null then raise exception 'enable_pg_cron_after_manual_validation'; end if;
  foreach kind in array array['profile_sync','opportunity_discovery','application_monitor'] loop
    execute 'select cron.schedule($1,$2,$3)' into job_id using
      'aih_'||p_user_id::text||'_'||kind,'* * * * *',
      format('select private.run_due_schedule(%L::uuid,%L);',p_user_id,kind);
    jobs:=jobs||jsonb_build_object(kind,job_id);
  end loop;
  return jsonb_build_object('enabled',true,'jobs',jobs);
end; $$;

revoke all on function public.save_schedule_configuration(jsonb) from public,anon;
grant execute on function public.save_schedule_configuration(jsonb) to authenticated;
revoke all on function private.protect_automation_artifact(),private.guard_schedule_activation(),private.dispatch_schedule(uuid,text,boolean,uuid),private.run_due_schedule(uuid,text),private.enable_recurring_schedules(uuid) from public,anon,authenticated;
grant execute on function private.dispatch_schedule(uuid,text,boolean,uuid),private.run_due_schedule(uuid,text),private.enable_recurring_schedules(uuid) to service_role;
revoke all on function public.automation_read_schedule_config(uuid),public.automation_begin_schedule(uuid,text,uuid,boolean,jsonb),public.automation_finish_schedule(uuid,text,jsonb,jsonb),public.automation_prepare_artifacts(uuid,uuid,jsonb,jsonb,text),public.automation_consume_schedule_ticket(text,text),public.automation_record_schedule_validation(uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.automation_read_schedule_config(uuid),public.automation_begin_schedule(uuid,text,uuid,boolean,jsonb),public.automation_finish_schedule(uuid,text,jsonb,jsonb),public.automation_prepare_artifacts(uuid,uuid,jsonb,jsonb,text),public.automation_consume_schedule_ticket(text,text),public.automation_record_schedule_validation(uuid,text,uuid[]) to service_role;

commit;
