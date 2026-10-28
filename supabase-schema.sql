-- Secure per-user storage for the dashboard.
-- Run this once in Supabase SQL Editor.

create table if not exists public.dashboard_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.dashboard_state enable row level security;

revoke all on table public.dashboard_state from anon;
revoke truncate, references, trigger on table public.dashboard_state from authenticated;

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

grant select, insert, update, delete on table public.dashboard_state to authenticated;

