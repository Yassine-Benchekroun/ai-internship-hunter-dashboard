-- Step 8 — backend-only Application Monitor support.
--
-- The monitor reads Gmail metadata through the read-only provider connection,
-- records idempotent message events, updates the existing application RPC, and
-- creates drafts only. It never sends mail and never creates a schedule.

begin;

create table if not exists public.application_monitor_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'gmail' check (provider = 'gmail'),
  dry_run boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed', 'skipped')),
  messages_scanned integer not null default 0 check (messages_scanned >= 0),
  applications_considered integer not null default 0 check (applications_considered >= 0),
  applications_updated integer not null default 0 check (applications_updated >= 0),
  follow_up_drafts_created integer not null default 0 check (follow_up_drafts_created >= 0),
  duplicates_ignored integer not null default 0 check (duplicates_ignored >= 0),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists application_monitor_runs_user_started_idx
  on public.application_monitor_runs (user_id, started_at desc);

drop trigger if exists application_monitor_runs_updated_at_trigger on public.application_monitor_runs;
create trigger application_monitor_runs_updated_at_trigger
before update on public.application_monitor_runs
for each row execute function public.set_updated_at();

create table if not exists public.application_monitor_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  application_id uuid not null references public.application_records(id) on delete cascade,
  provider text not null default 'gmail' check (provider = 'gmail'),
  provider_message_id text not null check (btrim(provider_message_id) <> '' and length(provider_message_id) <= 512),
  provider_thread_id text,
  message_received_at timestamptz,
  event_type text not null default 'reply_detected' check (event_type = 'reply_detected'),
  detected_status text not null check (detected_status in ('replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed')),
  created_at timestamptz not null default now(),
  unique (user_id, application_id, provider, provider_message_id)
);

create index if not exists application_monitor_events_user_application_idx
  on public.application_monitor_events (user_id, application_id, message_received_at desc);

create index if not exists application_monitor_events_application_idx
  on public.application_monitor_events (application_id);

alter table public.application_monitor_runs enable row level security;
alter table public.application_monitor_events enable row level security;

revoke all on table public.application_monitor_runs, public.application_monitor_events from public, anon, authenticated;
grant select on table public.application_monitor_runs, public.application_monitor_events to authenticated;
grant select, insert, update on table public.application_monitor_runs, public.application_monitor_events to service_role;

drop policy if exists "Step 8 users can read monitor runs" on public.application_monitor_runs;
create policy "Step 8 users can read monitor runs"
  on public.application_monitor_runs for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Step 8 users can read monitor events" on public.application_monitor_events;
create policy "Step 8 users can read monitor events"
  on public.application_monitor_events for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.automation_log_application_monitor_run(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_run_id uuid;
  v_user_id uuid;
  v_provider text := lower(trim(coalesce(p_payload->>'provider', 'gmail')));
  v_dry_run boolean := coalesce((p_payload->>'dry_run')::boolean, false);
  v_started_at timestamptz := coalesce(nullif(trim(p_payload->>'started_at'), '')::timestamptz, now());
  v_completed_at timestamptz := nullif(trim(p_payload->>'completed_at'), '')::timestamptz;
  v_status text := lower(trim(coalesce(p_payload->>'status', 'completed')));
  v_messages_scanned integer := coalesce(nullif(trim(p_payload->>'messages_scanned'), '')::integer, 0);
  v_applications_considered integer := coalesce(nullif(trim(p_payload->>'applications_considered'), '')::integer, 0);
  v_applications_updated integer := coalesce(nullif(trim(p_payload->>'applications_updated'), '')::integer, 0);
  v_follow_up_drafts_created integer := coalesce(nullif(trim(p_payload->>'follow_up_drafts_created'), '')::integer, 0);
  v_duplicates_ignored integer := coalesce(nullif(trim(p_payload->>'duplicates_ignored'), '')::integer, 0);
  v_errors jsonb := coalesce(p_payload->'errors', '[]'::jsonb);
  v_summary text := nullif(left(trim(coalesce(p_payload->>'summary', '')), 500), '');
begin
  if coalesce(jsonb_typeof(p_payload), '') <> 'object' then
    raise exception 'p_payload must be a JSON object';
  end if;
  v_user_id := nullif(trim(p_payload->>'user_id'), '')::uuid;
  v_run_id := coalesce(nullif(trim(p_payload->>'run_id'), '')::uuid, gen_random_uuid());
  if v_user_id is null then raise exception 'user_id is required'; end if;
  if not exists (select 1 from auth.users where id = v_user_id) then raise exception 'user_id does not exist'; end if;
  if v_provider <> 'gmail' then raise exception 'unsupported monitor provider'; end if;
  if v_status not in ('running', 'completed', 'partial', 'failed', 'skipped') then raise exception 'invalid monitor run status'; end if;
  if v_messages_scanned < 0 or v_applications_considered < 0 or v_applications_updated < 0
     or v_follow_up_drafts_created < 0 or v_duplicates_ignored < 0 then
    raise exception 'monitor counts cannot be negative';
  end if;
  if jsonb_typeof(v_errors) <> 'array' then raise exception 'errors must be an array'; end if;
  if exists (select 1 from public.application_monitor_runs where run_id = v_run_id and user_id <> v_user_id) then
    raise exception 'run_id belongs to another user';
  end if;

  insert into public.application_monitor_runs (
    run_id, user_id, provider, dry_run, started_at, completed_at, status,
    messages_scanned, applications_considered, applications_updated,
    follow_up_drafts_created, duplicates_ignored, errors, summary
  ) values (
    v_run_id, v_user_id, v_provider, v_dry_run, v_started_at, v_completed_at, v_status,
    v_messages_scanned, v_applications_considered, v_applications_updated,
    v_follow_up_drafts_created, v_duplicates_ignored, v_errors, v_summary
  )
  on conflict (run_id) do update set
    provider = excluded.provider,
    dry_run = excluded.dry_run,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    status = excluded.status,
    messages_scanned = excluded.messages_scanned,
    applications_considered = excluded.applications_considered,
    applications_updated = excluded.applications_updated,
    follow_up_drafts_created = excluded.follow_up_drafts_created,
    duplicates_ignored = excluded.duplicates_ignored,
    errors = excluded.errors,
    summary = excluded.summary;

  return jsonb_build_object(
    'run_id', v_run_id,
    'status', v_status,
    'dry_run', v_dry_run,
    'messages_scanned', v_messages_scanned,
    'applications_considered', v_applications_considered,
    'applications_updated', v_applications_updated,
    'follow_up_drafts_created', v_follow_up_drafts_created,
    'duplicates_ignored', v_duplicates_ignored
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
  v_existing_status text;
  v_status text;
  v_last_response_at timestamptz;
  v_follow_up_at timestamptz;
  v_notes text;
  v_provider text := lower(trim(coalesce(p_payload->>'provider', 'gmail')));
  v_provider_message_id text;
  v_provider_thread_id text;
  v_message_received_at timestamptz;
  v_event_id uuid;
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
  v_provider_message_id := nullif(trim(p_payload->>'provider_message_id'), '');
  v_provider_thread_id := nullif(trim(p_payload->>'provider_thread_id'), '');
  v_message_received_at := coalesce(nullif(trim(p_payload->>'message_received_at'), '')::timestamptz, now());
  if v_user_id is null or v_application_id is null then raise exception 'user_id and application_id are required'; end if;
  if v_status not in ('not_sent', 'ready', 'already_sent', 'sent', 'waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response', 'follow_up_needed', 'closed') then
    raise exception 'invalid application status';
  end if;
  if v_provider_message_id is not null then
    if v_provider <> 'gmail' then raise exception 'unsupported monitor provider'; end if;
    if length(v_provider_message_id) > 512 then raise exception 'provider_message_id is too long'; end if;
  end if;

  select opportunity_id, application_status
  into v_existing_opportunity_id, v_existing_status
  from public.application_records
  where id = v_application_id and user_id = v_user_id
  for update;
  if not found then raise exception 'application not found'; end if;
  v_opportunity_id := v_existing_opportunity_id;
  if p_payload ? 'opportunity_id' then
    v_opportunity_id := nullif(trim(p_payload->>'opportunity_id'), '')::uuid;
    if v_opportunity_id is distinct from v_existing_opportunity_id then raise exception 'application opportunity link cannot change'; end if;
  end if;

  -- A Gmail message ID is the idempotency key. The advisory lock closes the
  -- race between two monitor invocations seeing the same unread reply.
  if v_provider_message_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || '|monitor|' || v_application_id::text || '|' || v_provider_message_id, 0));
    select id into v_event_id
    from public.application_monitor_events
    where user_id = v_user_id
      and application_id = v_application_id
      and provider = v_provider
      and provider_message_id = v_provider_message_id
    for update;
    if v_event_id is not null then
      return jsonb_build_object(
        'application_id', v_application_id,
        'opportunity_id', v_opportunity_id,
        'application_status', v_existing_status,
        'follow_up_draft_id', null,
        'event_id', v_event_id,
        'duplicate', true
      );
    end if;
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
      where user_id = v_user_id and opportunity_id is not distinct from v_opportunity_id;
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

  if v_provider_message_id is not null then
    insert into public.application_monitor_events (
      user_id, application_id, provider, provider_message_id, provider_thread_id,
      message_received_at, event_type, detected_status
    ) values (
      v_user_id, v_application_id, v_provider, v_provider_message_id, v_provider_thread_id,
      v_message_received_at, 'reply_detected', v_status
    )
    returning id into v_event_id;
  end if;

  return jsonb_build_object(
    'application_id', v_application_id,
    'opportunity_id', v_opportunity_id,
    'application_status', v_status,
    'follow_up_draft_id', v_draft_id,
    'event_id', v_event_id,
    'duplicate', false
  );
end;
$$;

revoke all on function public.automation_log_application_monitor_run(jsonb) from public, anon, authenticated;
revoke all on function public.automation_update_application(jsonb) from public, anon, authenticated;
grant execute on function public.automation_log_application_monitor_run(jsonb) to service_role;
grant execute on function public.automation_update_application(jsonb) to service_role;

comment on table public.application_monitor_runs is
  'Owner-scoped backend Application Monitor run summaries; no mailbox content or provider tokens.';
comment on table public.application_monitor_events is
  'Owner-scoped idempotency/history keys for read-only provider message observations.';
comment on function public.automation_log_application_monitor_run(jsonb) is
  'Service-role-only Application Monitor run logging; safe counts and error codes only.';
comment on function public.automation_update_application(jsonb) is
  'Service-role-only Application Monitor contract; idempotently updates status and creates follow-up drafts without sending mail.';

commit;
