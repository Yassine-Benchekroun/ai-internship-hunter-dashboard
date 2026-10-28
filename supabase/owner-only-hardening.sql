-- Existing-project hardening applied to the AI Internship Hunter project.
-- Owner UUID: 3a419f7d-36e0-43d5-aa39-156b3177b84a
-- This script changes policies and privileges only; it does not delete data.

begin;

revoke truncate, references, trigger on table public.opportunity_records from anon, authenticated;
revoke truncate, references, trigger on table public.opportunity_ingestion_events from anon, authenticated;

revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.normalize_opportunity_url(text) from public;
revoke execute on function public.opportunity_dedupe_key(text, text, text) from public;

drop policy if exists "Users can read their dashboard state" on public.dashboard_state;
drop policy if exists "Users can create their dashboard state" on public.dashboard_state;
drop policy if exists "Users can update their dashboard state" on public.dashboard_state;
drop policy if exists "Users can delete their dashboard state" on public.dashboard_state;

create policy "Owner can read their dashboard state"
  on public.dashboard_state for select to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

create policy "Owner can create their dashboard state"
  on public.dashboard_state for insert to authenticated
  with check ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

create policy "Owner can update their dashboard state"
  on public.dashboard_state for update to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid)
  with check ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

create policy "Owner can delete their dashboard state"
  on public.dashboard_state for delete to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

drop policy if exists "Users can read their opportunities" on public.opportunity_records;
drop policy if exists "Users can insert their opportunities" on public.opportunity_records;
drop policy if exists "Users can update their opportunities" on public.opportunity_records;
drop policy if exists "Users can delete their opportunities" on public.opportunity_records;

create policy "Owner can read their opportunities"
  on public.opportunity_records for select to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

create policy "Owner can insert their opportunities"
  on public.opportunity_records for insert to authenticated
  with check ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

create policy "Owner can update their opportunities"
  on public.opportunity_records for update to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid)
  with check ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

create policy "Owner can delete their opportunities"
  on public.opportunity_records for delete to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

drop policy if exists "Users can read their ingestion events" on public.opportunity_ingestion_events;

create policy "Owner can read their ingestion events"
  on public.opportunity_ingestion_events for select to authenticated
  using ((select auth.uid()) = user_id and (select auth.uid()) = '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid);

commit;
