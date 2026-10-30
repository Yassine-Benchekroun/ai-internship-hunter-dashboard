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
drop policy if exists "Owner can read their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can create their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can update their dashboard state" on public.dashboard_state;
drop policy if exists "Owner can delete their dashboard state" on public.dashboard_state;

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

grant select, insert, update, delete on table public.dashboard_state to authenticated;

