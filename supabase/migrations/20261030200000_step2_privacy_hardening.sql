-- Step 2 — RLS, backend privacy, and removal of hardcoded private data.
--
-- This migration keeps the browser contract unchanged while making ownership
-- checks apply to every parent/child relationship. Browser-supplied user_id
-- values are only accepted when they equal auth.uid(); service-role workers
-- remain the only callers of the privileged automation contracts.

begin;

-- The bootstrap schema and older migrations once carried a real account's
-- profile sources as a JSON default. New accounts must start empty. Deliberately
-- configured sources remain untouched.
alter table public.user_settings
  alter column approved_profile_sources set default '[]'::jsonb;

-- RLS is defense in depth for every user-data table in the exposed schema.
alter table public.dashboard_state enable row level security;
alter table public.opportunity_records enable row level security;
alter table public.application_records enable row level security;
alter table public.profile_facts enable row level security;
alter table public.profile_fact_evidence enable row level security;
alter table public.profile_sync_runs enable row level security;
alter table public.cv_versions enable row level security;
alter table public.email_drafts enable row level security;
alter table public.user_settings enable row level security;
alter table public.opportunity_ingestion_events enable row level security;

-- Remove inherited/default Data API privileges before granting the exact
-- browser surface. Anon receives no private-table access at all.
revoke all on table public.dashboard_state,
  public.opportunity_records, public.application_records,
  public.profile_facts, public.profile_fact_evidence, public.profile_sync_runs,
  public.cv_versions, public.email_drafts, public.user_settings,
  public.opportunity_ingestion_events from anon, authenticated;

grant select, insert, update, delete on table public.dashboard_state to authenticated;
grant select, insert, update, delete on table public.opportunity_records to authenticated;
grant select, insert, update, delete on table public.application_records to authenticated;
grant select on table public.profile_facts, public.profile_fact_evidence,
  public.profile_sync_runs to authenticated;
grant select, insert, update, delete on table public.cv_versions,
  public.email_drafts, public.user_settings to authenticated;
grant select on table public.opportunity_ingestion_events to authenticated;

-- Replace every previous policy by name so this migration is safe to apply to
-- both the bootstrap schema and the current production migration chain.
drop policy if exists "Users can read their dashboard state" on public.dashboard_state;
drop policy if exists "Users can create their dashboard state" on public.dashboard_state;
drop policy if exists "Users can update their dashboard state" on public.dashboard_state;
drop policy if exists "Users can delete their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can read their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can create their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can update their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can delete their dashboard state" on public.dashboard_state;

create policy "Step 2 users can read their dashboard state"
  on public.dashboard_state for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Step 2 users can create their dashboard state"
  on public.dashboard_state for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Step 2 users can update their dashboard state"
  on public.dashboard_state for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Step 2 users can delete their dashboard state"
  on public.dashboard_state for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their opportunities" on public.opportunity_records;
drop policy if exists "Users can insert their opportunities" on public.opportunity_records;
drop policy if exists "Users can update their opportunities" on public.opportunity_records;
drop policy if exists "Users can delete their opportunities" on public.opportunity_records;
drop policy if exists "Owner can read their opportunities" on public.opportunity_records;
drop policy if exists "Owner can insert their opportunities" on public.opportunity_records;
drop policy if exists "Owner can update their opportunities" on public.opportunity_records;
drop policy if exists "Owner can delete their opportunities" on public.opportunity_records;

create policy "Step 2 users can read their opportunities"
  on public.opportunity_records for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Step 2 users can insert their opportunities"
  on public.opportunity_records for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Step 2 users can update their opportunities"
  on public.opportunity_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Step 2 users can delete their opportunities"
  on public.opportunity_records for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Applications are visible only when both the application and its optional
-- opportunity belong to the current user. This blocks forged child links and
-- also hides any inconsistent legacy row from the browser.
drop policy if exists "Users can read their applications" on public.application_records;
drop policy if exists "Users can insert their applications" on public.application_records;
drop policy if exists "Users can update their applications" on public.application_records;
drop policy if exists "Users can delete their applications" on public.application_records;
drop policy if exists "Owner can read their applications" on public.application_records;
drop policy if exists "Owner can insert their applications" on public.application_records;
drop policy if exists "Owner can update their applications" on public.application_records;
drop policy if exists "Owner can delete their applications" on public.application_records;

create policy "Step 2 users can read their applications"
  on public.application_records for select to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = application_records.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );
create policy "Step 2 users can insert their applications"
  on public.application_records for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = application_records.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );
create policy "Step 2 users can update their applications"
  on public.application_records for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = application_records.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  )
  with check (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = application_records.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );
create policy "Step 2 users can delete their applications"
  on public.application_records for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = application_records.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );

-- Profile facts and sync runs are backend-written records; the browser gets
-- only owner-scoped reads through the explicit SELECT grant above.
drop policy if exists "Users can read their profile facts" on public.profile_facts;
drop policy if exists "Owner can read their profile facts" on public.profile_facts;
create policy "Step 2 users can read their profile facts"
  on public.profile_facts for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read profile fact evidence" on public.profile_fact_evidence;
drop policy if exists "Owner can read profile fact evidence" on public.profile_fact_evidence;
create policy "Step 2 users can read profile fact evidence"
  on public.profile_fact_evidence for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.profile_facts parent
      where parent.id = profile_fact_evidence.fact_id
        and parent.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users can read their profile sync runs" on public.profile_sync_runs;
drop policy if exists "Owner can read their profile sync runs" on public.profile_sync_runs;
create policy "Step 2 users can read their profile sync runs"
  on public.profile_sync_runs for select to authenticated
  using ((select auth.uid()) = user_id);

-- CVs and drafts have optional parent links. Every non-null link must resolve
-- to a row owned by the same authenticated user.
drop policy if exists "Users can read their CV versions" on public.cv_versions;
drop policy if exists "Users can insert their CV versions" on public.cv_versions;
drop policy if exists "Users can update their CV versions" on public.cv_versions;
drop policy if exists "Users can delete their CV versions" on public.cv_versions;
drop policy if exists "Owner can read their CV versions" on public.cv_versions;
drop policy if exists "Owner can insert their CV versions" on public.cv_versions;
drop policy if exists "Owner can update their CV versions" on public.cv_versions;
drop policy if exists "Owner can delete their CV versions" on public.cv_versions;

create policy "Step 2 users can read their CV versions"
  on public.cv_versions for select to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = cv_versions.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );
create policy "Step 2 users can insert their CV versions"
  on public.cv_versions for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = cv_versions.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );
create policy "Step 2 users can update their CV versions"
  on public.cv_versions for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = cv_versions.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  )
  with check (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = cv_versions.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );
create policy "Step 2 users can delete their CV versions"
  on public.cv_versions for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = cv_versions.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists "Users can read their email drafts" on public.email_drafts;
drop policy if exists "Users can insert their email drafts" on public.email_drafts;
drop policy if exists "Users can update their email drafts" on public.email_drafts;
drop policy if exists "Users can delete their email drafts" on public.email_drafts;
drop policy if exists "Owner can read their email drafts" on public.email_drafts;
drop policy if exists "Owner can insert their email drafts" on public.email_drafts;
drop policy if exists "Owner can update their email drafts" on public.email_drafts;
drop policy if exists "Owner can delete their email drafts" on public.email_drafts;

create policy "Step 2 users can read their email drafts"
  on public.email_drafts for select to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = email_drafts.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
    and (
      application_id is null
      or exists (
        select 1 from public.application_records application
        where application.id = email_drafts.application_id
          and application.user_id = (select auth.uid())
          and (
            email_drafts.opportunity_id is null
            or application.opportunity_id is not distinct from email_drafts.opportunity_id
          )
      )
    )
  );
create policy "Step 2 users can insert their email drafts"
  on public.email_drafts for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = email_drafts.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
    and (
      application_id is null
      or exists (
        select 1 from public.application_records application
        where application.id = email_drafts.application_id
          and application.user_id = (select auth.uid())
          and (
            email_drafts.opportunity_id is null
            or application.opportunity_id is not distinct from email_drafts.opportunity_id
          )
      )
    )
  );
create policy "Step 2 users can update their email drafts"
  on public.email_drafts for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = email_drafts.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
    and (
      application_id is null
      or exists (
        select 1 from public.application_records application
        where application.id = email_drafts.application_id
          and application.user_id = (select auth.uid())
          and (
            email_drafts.opportunity_id is null
            or application.opportunity_id is not distinct from email_drafts.opportunity_id
          )
      )
    )
  )
  with check (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = email_drafts.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
    and (
      application_id is null
      or exists (
        select 1 from public.application_records application
        where application.id = email_drafts.application_id
          and application.user_id = (select auth.uid())
          and (
            email_drafts.opportunity_id is null
            or application.opportunity_id is not distinct from email_drafts.opportunity_id
          )
      )
    )
  );
create policy "Step 2 users can delete their email drafts"
  on public.email_drafts for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = email_drafts.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
    and (
      application_id is null
      or exists (
        select 1 from public.application_records application
        where application.id = email_drafts.application_id
          and application.user_id = (select auth.uid())
          and (
            email_drafts.opportunity_id is null
            or application.opportunity_id is not distinct from email_drafts.opportunity_id
          )
      )
    )
  );

drop policy if exists "Users can read their settings" on public.user_settings;
drop policy if exists "Users can insert their settings" on public.user_settings;
drop policy if exists "Users can update their settings" on public.user_settings;
drop policy if exists "Users can delete their settings" on public.user_settings;
drop policy if exists "Owner can read their settings" on public.user_settings;
drop policy if exists "Owner can insert their settings" on public.user_settings;
drop policy if exists "Owner can update their settings" on public.user_settings;
drop policy if exists "Owner can delete their settings" on public.user_settings;

create policy "Step 2 users can read their settings"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Step 2 users can insert their settings"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Step 2 users can update their settings"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Step 2 users can delete their settings"
  on public.user_settings for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their ingestion events" on public.opportunity_ingestion_events;
drop policy if exists "Owner can read their ingestion events" on public.opportunity_ingestion_events;
create policy "Step 2 users can read their ingestion events"
  on public.opportunity_ingestion_events for select to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      opportunity_id is null
      or exists (
        select 1 from public.opportunity_records parent
        where parent.id = opportunity_ingestion_events.opportunity_id
          and parent.user_id = (select auth.uid())
      )
    )
  );

-- The current repository has no views. Keep the automation contracts closed to
-- the browser and make the privileged function surface explicit on reruns.
revoke all on function public.automation_read_settings(uuid) from public, anon, authenticated;
revoke all on function public.automation_sync_profile(jsonb) from public, anon, authenticated;
revoke all on function public.ingest_opportunity_record(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.automation_ingest_opportunities(jsonb) from public, anon, authenticated;
revoke all on function public.automation_update_application(jsonb) from public, anon, authenticated;
revoke all on function public.is_approved_profile_source(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.automation_read_settings(uuid) to service_role;
grant execute on function public.automation_sync_profile(jsonb) to service_role;
grant execute on function public.ingest_opportunity_record(uuid, jsonb, uuid) to service_role;
grant execute on function public.automation_ingest_opportunities(jsonb) to service_role;
grant execute on function public.automation_update_application(jsonb) to service_role;
grant execute on function public.is_approved_profile_source(uuid, text, text, text) to service_role;

comment on function public.automation_read_settings(uuid) is
  'Service-role-only settings read. The backend supplies the trusted user ID; browser roles cannot execute it.';
comment on function public.automation_sync_profile(jsonb) is
  'Service-role-only profile sync. The backend supplies the trusted user ID; browser roles cannot execute it.';
comment on function public.automation_ingest_opportunities(jsonb) is
  'Service-role-only opportunity ingestion. The backend supplies the trusted user ID; browser roles cannot execute it.';
comment on function public.automation_update_application(jsonb) is
  'Service-role-only application monitoring. The backend supplies the trusted user ID; browser roles cannot execute it.';

commit;
