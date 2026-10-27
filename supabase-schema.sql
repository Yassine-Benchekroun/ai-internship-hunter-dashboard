-- Secure per-user storage for the dashboard.
-- Run this once in Supabase SQL Editor.

create table if not exists public.dashboard_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.dashboard_state enable row level security;

drop policy if exists "Users can read their dashboard state" on public.dashboard_state;
create policy "Users can read their dashboard state"
  on public.dashboard_state for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their dashboard state" on public.dashboard_state;
create policy "Users can create their dashboard state"
  on public.dashboard_state for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their dashboard state" on public.dashboard_state;
create policy "Users can update their dashboard state"
  on public.dashboard_state for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their dashboard state" on public.dashboard_state;
create policy "Users can delete their dashboard state"
  on public.dashboard_state for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.dashboard_state to authenticated;

