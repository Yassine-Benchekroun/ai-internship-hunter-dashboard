-- Legacy compatibility hardening for an existing AI Internship Hunter project.
--
-- This file is retained for operators who used the former one-off script. It
-- contains no account UUID. Ownership is always auth.uid() = user_id.
-- The timestamped migrations are the canonical deployment history.

begin;

revoke truncate, references, trigger on table public.opportunity_records from anon, authenticated;
revoke truncate, references, trigger on table public.opportunity_ingestion_events from anon, authenticated;

revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.normalize_opportunity_url(text) from public;
revoke execute on function public.opportunity_dedupe_key(text, text, text) from public;

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

drop policy if exists "Owner can read their ingestion events" on public.opportunity_ingestion_events;
drop policy if exists "Users can read their ingestion events" on public.opportunity_ingestion_events;
create policy "Users can read their ingestion events"
  on public.opportunity_ingestion_events for select to authenticated
  using ((select auth.uid()) = user_id);

commit;
