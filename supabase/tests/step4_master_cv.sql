-- Step 4 rollback-safe Master CV model, save-path, and owner-privacy tests.
-- Execute after the Step 4 migration as a privileged SQL test.

begin;

-- Run the assertions as an authenticated client so the SELECT policy is
-- exercised. The save RPC is security-definer but derives ownership from the
-- request claim, not from the payload.
set local role authenticated;

do $$
declare
  v_owner_id uuid := '3a419f7d-36e0-43d5-aa39-156b3177b84a'::uuid;
  v_other_id uuid := '00000000-0000-0000-0000-000000000004'::uuid;
  v_first jsonb;
  v_second jsonb;
  v_count integer;
  v_total_count integer;
  v_current_count integer;
  v_current_revision integer;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'master_cv_versions'
       and column_name = 'opportunity_id'
  ) then
    raise exception 'Master CV table must not carry targeted opportunity links';
  end if;
  if has_table_privilege('authenticated', 'public.master_cv_versions', 'INSERT')
     or has_table_privilege('authenticated', 'public.master_cv_versions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.master_cv_versions', 'DELETE') then
    raise exception 'authenticated direct Master CV writes are not revoked';
  end if;
  if has_table_privilege('anon', 'public.master_cv_versions', 'SELECT') then
    raise exception 'anon can read Master CV rows';
  end if;
  if has_function_privilege('anon', 'public.save_master_cv(jsonb)', 'EXECUTE') then
    raise exception 'anon can execute the Master CV save RPC';
  end if;

  -- The authenticated owner can save supplied content and receives revision 1.
  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  v_first := public.save_master_cv(jsonb_build_object(
    'content', 'Owner-supplied CV text for the rollback-safe Step 4 test',
    'source_reference', 'storage://master-cv/step4-test.txt',
    'change_summary', 'User supplied import'
  ));
  if (v_first->>'revision')::integer <> 1 or (v_first->>'is_current')::boolean is not true then
    raise exception 'first Master CV revision was not current revision 1';
  end if;

  -- A second save creates history and makes only the new revision current.
  v_second := public.save_master_cv(jsonb_build_object(
    'source_reference', 'storage://master-cv/step4-test-v2.pdf'
  ));
  if (v_second->>'revision')::integer <> 2 then
    raise exception 'second Master CV revision was not revision 2';
  end if;
  select count(*), count(*) filter (where is_current), max(revision) filter (where is_current)
    into v_total_count, v_current_count, v_current_revision
    from public.master_cv_versions
   where user_id = v_owner_id;
  if v_total_count <> 2 or v_current_count <> 1 or v_current_revision <> 2 then
    raise exception 'Master CV revision history/current invariant failed';
  end if;
  if (select count(*) from public.master_cv_versions where user_id = v_owner_id and is_current) <> 1 then
    raise exception 'Master CV must have exactly one current revision';
  end if;
  if (select content from public.master_cv_versions where user_id = v_owner_id and revision = 2) is not null then
    raise exception 'save path fabricated content for a source-only revision';
  end if;

  -- Invalid saves cannot create content or impersonate an owner.
  begin
    perform public.save_master_cv(jsonb_build_object('revision', 99, 'content', 'forged revision'));
    raise exception 'client-controlled revision was accepted';
  exception when others then
    if sqlerrm not like '%revision and is_current are server-controlled%' then raise; end if;
  end;
  begin
    perform public.save_master_cv(jsonb_build_object('user_id', v_owner_id, 'content', 'forged owner'));
    raise exception 'client-controlled owner was accepted';
  exception when others then
    if sqlerrm not like '%user_id is not accepted%' then raise; end if;
  end;
  begin
    perform public.save_master_cv(jsonb_build_object('change_summary', 'missing material'));
    raise exception 'empty Master CV save was accepted';
  exception when others then
    if sqlerrm not like '%content or source_reference is required%' then raise; end if;
  end;

  -- Owner can read both revisions; a different authenticated claim sees none.
  select count(*) into v_count from public.master_cv_versions where user_id = v_owner_id;
  if v_count <> 2 then raise exception 'owner could not read own Master CV history'; end if;
  perform set_config('request.jwt.claim.sub', v_other_id::text, true);
  select count(*) into v_count from public.master_cv_versions;
  if v_count <> 0 then raise exception 'non-owner can read Master CV rows'; end if;

  -- Targeted CV artifacts remain a separate table and are not touched by the
  -- Master CV save path.
  if (select count(*) from public.cv_versions where user_id = v_owner_id) <> 0 then
    raise exception 'Master CV save path wrote targeted cv_versions';
  end if;
end;
$$;

rollback;
