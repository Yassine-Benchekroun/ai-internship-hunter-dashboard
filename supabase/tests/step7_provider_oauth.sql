-- Run after the Step 7 migration in a controlled verification transaction.
begin;

do $$
declare
  v_states_rls boolean;
  v_connections_rls boolean;
begin
  select c.relrowsecurity into v_states_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname = 'provider_oauth_states';
  select c.relrowsecurity into v_connections_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname = 'provider_connections';

  if not coalesce(v_states_rls, false) or not coalesce(v_connections_rls, false) then
    raise exception 'Step 7 private provider tables must have RLS enabled';
  end if;
  if has_table_privilege('anon', 'private.provider_connections', 'select')
     or has_table_privilege('authenticated', 'private.provider_connections', 'select') then
    raise exception 'Browser roles must not read provider tokens';
  end if;
  if has_function_privilege('anon', 'public.provider_oauth_get_connection(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.provider_oauth_get_connection(uuid)', 'execute') then
    raise exception 'Browser roles must not execute the provider token RPC';
  end if;
  if not has_function_privilege('service_role', 'public.provider_oauth_get_connection(uuid)', 'execute') then
    raise exception 'The backend service role must execute the provider token RPC';
  end if;
end;
$$;

rollback;
