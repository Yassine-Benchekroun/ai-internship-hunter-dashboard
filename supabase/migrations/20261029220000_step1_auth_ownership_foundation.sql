-- Step 1 — Authentication + ownership foundation.
--
-- This migration removes the legacy single-account gate. Ownership is the
-- authenticated Supabase user ID, never an email string or a hard-coded UUID.
-- It is additive and does not reassign or delete existing rows.

begin;

-- Keep the legacy helper name for already-created database objects, but make
-- it describe authentication only. The policies below use auth.uid() and do
-- not rely on this helper as an ownership boundary.
create or replace function public.is_dashboard_owner()
returns boolean
language sql
stable
security invoker
set search_path = public
parallel safe
as $$
  select (select auth.uid()) is not null;
$$;

revoke all on function public.is_dashboard_owner() from public;
grant execute on function public.is_dashboard_owner() to authenticated;

-- New accounts must not inherit the previous account's profile sources.
alter table public.user_settings
  alter column approved_profile_sources set default '[]'::jsonb;

drop policy if exists "Owner can read their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can create their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can update their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can delete their dashboard state" on public.dashboard_state;
drop policy if exists "Users can read their dashboard state" on public.dashboard_state;
drop policy if exists "Users can create their dashboard state" on public.dashboard_state;
drop policy if exists "Users can update their dashboard state" on public.dashboard_state;
drop policy if exists "Users can delete their dashboard state" on public.dashboard_state;

create policy "Users can read their dashboard state"
  on public.dashboard_state for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their dashboard state"
  on public.dashboard_state for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their dashboard state"
  on public.dashboard_state for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their dashboard state"
  on public.dashboard_state for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their opportunities" on public.opportunity_records;
drop policy if exists "Owner can insert their opportunities" on public.opportunity_records;
drop policy if exists "Owner can update their opportunities" on public.opportunity_records;
drop policy if exists "Owner can delete their opportunities" on public.opportunity_records;
drop policy if exists "Users can read their opportunities" on public.opportunity_records;
drop policy if exists "Users can insert their opportunities" on public.opportunity_records;
drop policy if exists "Users can update their opportunities" on public.opportunity_records;
drop policy if exists "Users can delete their opportunities" on public.opportunity_records;

create policy "Users can read their opportunities"
  on public.opportunity_records for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their opportunities"
  on public.opportunity_records for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their opportunities"
  on public.opportunity_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their opportunities"
  on public.opportunity_records for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their applications" on public.application_records;
drop policy if exists "Owner can insert their applications" on public.application_records;
drop policy if exists "Owner can update their applications" on public.application_records;
drop policy if exists "Owner can delete their applications" on public.application_records;
drop policy if exists "Users can read their applications" on public.application_records;
drop policy if exists "Users can insert their applications" on public.application_records;
drop policy if exists "Users can update their applications" on public.application_records;
drop policy if exists "Users can delete their applications" on public.application_records;

create policy "Users can read their applications"
  on public.application_records for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their applications"
  on public.application_records for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their applications"
  on public.application_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their applications"
  on public.application_records for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their CV versions" on public.cv_versions;
drop policy if exists "Owner can insert their CV versions" on public.cv_versions;
drop policy if exists "Owner can update their CV versions" on public.cv_versions;
drop policy if exists "Owner can delete their CV versions" on public.cv_versions;
drop policy if exists "Users can read their CV versions" on public.cv_versions;
drop policy if exists "Users can insert their CV versions" on public.cv_versions;
drop policy if exists "Users can update their CV versions" on public.cv_versions;
drop policy if exists "Users can delete their CV versions" on public.cv_versions;

create policy "Users can read their CV versions"
  on public.cv_versions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their CV versions"
  on public.cv_versions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their CV versions"
  on public.cv_versions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their CV versions"
  on public.cv_versions for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their email drafts" on public.email_drafts;
drop policy if exists "Owner can insert their email drafts" on public.email_drafts;
drop policy if exists "Owner can update their email drafts" on public.email_drafts;
drop policy if exists "Owner can delete their email drafts" on public.email_drafts;
drop policy if exists "Users can read their email drafts" on public.email_drafts;
drop policy if exists "Users can insert their email drafts" on public.email_drafts;
drop policy if exists "Users can update their email drafts" on public.email_drafts;
drop policy if exists "Users can delete their email drafts" on public.email_drafts;

create policy "Users can read their email drafts"
  on public.email_drafts for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their email drafts"
  on public.email_drafts for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their email drafts"
  on public.email_drafts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their email drafts"
  on public.email_drafts for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their settings" on public.user_settings;
drop policy if exists "Owner can insert their settings" on public.user_settings;
drop policy if exists "Owner can update their settings" on public.user_settings;
drop policy if exists "Owner can delete their settings" on public.user_settings;
drop policy if exists "Users can read their settings" on public.user_settings;
drop policy if exists "Users can insert their settings" on public.user_settings;
drop policy if exists "Users can update their settings" on public.user_settings;
drop policy if exists "Users can delete their settings" on public.user_settings;

create policy "Users can read their settings"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their settings"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their settings"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their settings"
  on public.user_settings for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their ingestion events" on public.opportunity_ingestion_events;
drop policy if exists "Users can read their ingestion events" on public.opportunity_ingestion_events;
create policy "Users can read their ingestion events"
  on public.opportunity_ingestion_events for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read their profile facts" on public.profile_facts;
drop policy if exists "Users can read their profile facts" on public.profile_facts;
create policy "Users can read their profile facts"
  on public.profile_facts for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read profile fact evidence" on public.profile_fact_evidence;
drop policy if exists "Users can read profile fact evidence" on public.profile_fact_evidence;
create policy "Users can read profile fact evidence"
  on public.profile_fact_evidence for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owner can read profile sync runs" on public.profile_sync_runs;
drop policy if exists "Users can read profile sync runs" on public.profile_sync_runs;
create policy "Users can read profile sync runs"
  on public.profile_sync_runs for select to authenticated
  using ((select auth.uid()) = user_id);

commit;
