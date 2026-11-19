begin;

-- One Brave search HTTP request consumes one budget unit. The limit is fixed
-- server-side so browser state and worker retries cannot raise it.
create table private.discovery_search_request_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  request_count integer not null default 0 check (request_count between 0 and 1000),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);
revoke all on private.discovery_search_request_usage from public, anon, authenticated;
grant select, insert, update on private.discovery_search_request_usage to service_role;

create or replace function public.automation_reserve_discovery_search_request(
  p_user_id uuid,
  p_requested_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_period_start date := date_trunc('month', coalesce(p_requested_at, now()) at time zone 'UTC')::date;
  v_used integer;
begin
  if p_user_id is null or p_requested_at is null then
    raise exception 'search_budget_arguments_invalid';
  end if;

  insert into private.discovery_search_request_usage(user_id, period_start)
  values (p_user_id, v_period_start)
  on conflict (user_id, period_start) do nothing;

  select request_count into v_used
  from private.discovery_search_request_usage
  where user_id = p_user_id and period_start = v_period_start
  for update;

  if v_used >= 1000 then
    return jsonb_build_object(
      'allowed', false,
      'period_start', v_period_start,
      'request_limit', 1000,
      'requests_used', v_used,
      'requests_remaining', 0
    );
  end if;

  update private.discovery_search_request_usage
  set request_count = v_used + 1, updated_at = now()
  where user_id = p_user_id and period_start = v_period_start;

  return jsonb_build_object(
    'allowed', true,
    'period_start', v_period_start,
    'request_limit', 1000,
    'requests_used', v_used + 1,
    'requests_remaining', 999 - v_used
  );
end;
$$;
revoke all on function public.automation_reserve_discovery_search_request(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.automation_reserve_discovery_search_request(uuid, timestamptz) to service_role;

commit;
