-- Phase 3 follow-up for deployments that already applied the initial Phase 3
-- migration. The output-column name `dedupe_key` is also a PL/pgSQL variable
-- in the table-returning function, so qualify the table reference.

begin;

do $$
declare
  v_definition text;
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

  v_definition := replace(
    v_definition,
    $needle$from public.opportunity_records
  where user_id = p_user_id and dedupe_key = v_dedupe_key$needle$,
    $replacement$from public.opportunity_records as opportunities
  where opportunities.user_id = p_user_id and opportunities.dedupe_key = v_dedupe_key$replacement$
  );
  if v_definition <> pg_get_functiondef((
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'ingest_opportunity_record'
      and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_record jsonb, p_request_id uuid'
  )) then
    execute v_definition;
  end if;
end;
$$;

commit;
