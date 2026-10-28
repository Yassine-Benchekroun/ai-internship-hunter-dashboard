-- Phase 3 follow-up for table-returning function output-column ambiguity in
-- artifact preservation queries.

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

  v_updated_definition := replace(v_definition,
    $needle$update public.cv_versions set is_current = false
      where user_id = p_user_id and opportunity_id = v_opportunity_id;$needle$,
    $replacement$update public.cv_versions as versions set is_current = false
      where versions.user_id = p_user_id and versions.opportunity_id = v_opportunity_id;$replacement$);
  v_updated_definition := replace(v_updated_definition,
    $needle$select id into v_artifact_id from public.cv_versions
    where user_id = p_user_id and opportunity_id = v_opportunity_id and version = v_version for update;$needle$,
    $replacement$select versions.id into v_artifact_id from public.cv_versions as versions
    where versions.user_id = p_user_id and versions.opportunity_id = v_opportunity_id and versions.version = v_version for update;$replacement$);
  v_updated_definition := replace(v_updated_definition,
    $needle$update public.email_drafts set is_current = false
      where user_id = p_user_id and opportunity_id = v_opportunity_id;$needle$,
    $replacement$update public.email_drafts as drafts set is_current = false
      where drafts.user_id = p_user_id and drafts.opportunity_id = v_opportunity_id;$replacement$);
  v_updated_definition := replace(v_updated_definition,
    $needle$select id into v_artifact_id from public.email_drafts
    where user_id = p_user_id and opportunity_id = v_opportunity_id and version = v_version for update;$needle$,
    $replacement$select drafts.id into v_artifact_id from public.email_drafts as drafts
    where drafts.user_id = p_user_id and drafts.opportunity_id = v_opportunity_id and drafts.version = v_version for update;$replacement$);

  if v_updated_definition <> v_definition then
    execute v_updated_definition;
  end if;
end;
$$;

commit;
