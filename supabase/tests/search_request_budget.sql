begin;

set local role service_role;

do $$
declare
  v_user_id uuid := '3a419f7d-36e0-43d5-aa39-156b3177b84a';
  v_result jsonb;
begin
  if has_function_privilege('anon', 'public.automation_reserve_discovery_search_request(uuid,timestamptz)', 'execute') then
    raise exception 'anon can execute search budget RPC';
  end if;
  if has_function_privilege('authenticated', 'public.automation_reserve_discovery_search_request(uuid,timestamptz)', 'execute') then
    raise exception 'authenticated can execute search budget RPC';
  end if;
  if not has_function_privilege('service_role', 'public.automation_reserve_discovery_search_request(uuid,timestamptz)', 'execute') then
    raise exception 'service_role cannot execute search budget RPC';
  end if;

  v_result := public.automation_reserve_discovery_search_request(v_user_id, '2030-02-01T00:00:00Z'::timestamptz);
  if (v_result->>'allowed')::boolean is distinct from true
     or (v_result->>'requests_used')::integer <> 1
     or (v_result->>'requests_remaining')::integer <> 999 then
    raise exception 'first search request was not reserved correctly: %', v_result;
  end if;

  update private.discovery_search_request_usage
  set request_count = 999
  where user_id = v_user_id and period_start = '2030-02-01'::date;

  v_result := public.automation_reserve_discovery_search_request(v_user_id, '2030-02-15T00:00:00Z'::timestamptz);
  if (v_result->>'allowed')::boolean is distinct from true
     or (v_result->>'requests_used')::integer <> 1000
     or (v_result->>'requests_remaining')::integer <> 0 then
    raise exception 'request 1000 was not allowed correctly: %', v_result;
  end if;

  v_result := public.automation_reserve_discovery_search_request(v_user_id, '2030-02-20T00:00:00Z'::timestamptz);
  if (v_result->>'allowed')::boolean is distinct from false
     or (v_result->>'requests_used')::integer <> 1000
     or (v_result->>'requests_remaining')::integer <> 0 then
    raise exception 'request 1001 was not blocked correctly: %', v_result;
  end if;
end;
$$;

rollback;
