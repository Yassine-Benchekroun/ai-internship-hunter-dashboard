-- Phase 3 follow-up for deployments that already applied the initial Phase 3
-- migration. Use the named unique constraint so the table-returning function's
-- request_id output variable cannot be confused with the event column.

begin;

do $$
declare
  v_definition text;
  v_updated_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'ingest_opportunity_record'
    and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_record jsonb, p_request_id uuid';

  if v_definition is null then
    raise exception 'ingest_opportunity_record function is missing';
  end if;

  v_updated_definition := replace(
    v_definition,
    'on conflict (request_id, dedupe_key) do update',
    'on conflict on constraint opportunity_ingestion_events_request_id_dedupe_key_key do update'
  );
  if v_updated_definition <> v_definition then
    execute v_updated_definition;
  end if;
end;
$$;

commit;
