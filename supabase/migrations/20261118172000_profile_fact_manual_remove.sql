-- Explicit owner removal hides a profile fact without deleting its evidence.
-- Source-managed facts remain recoverable and may return after a later sync.
begin;

drop policy if exists "Owner can update owner profile facts" on public.profile_facts;
create policy "Owner can update owner profile facts"
  on public.profile_facts for update to authenticated
  using (
    (select auth.uid()) = user_id
    and origin in ('owner', 'source')
  )
  with check (
    (select auth.uid()) = user_id
    and (
      (origin = 'owner' and verified = false and verification_status in ('unverified', 'rejected'))
      or (origin = 'source' and owner_hidden = true and verified = false and verification_status = 'rejected')
    )
  );

create or replace function public.owner_remove_profile_fact(p_fact_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_origin text;
  v_fact jsonb;
begin
  if v_user_id is null or not public.is_dashboard_owner() then
    raise exception 'owner_required';
  end if;
  if p_fact_id is null then raise exception 'fact_id_required'; end if;

  select origin into v_origin
  from public.profile_facts
  where id = p_fact_id and user_id = v_user_id
  for update;
  if v_origin is null then raise exception 'profile_fact_not_found'; end if;

  update public.profile_facts
  set owner_hidden = true,
      verification_status = 'rejected',
      verified = false
  where id = p_fact_id and user_id = v_user_id;

  select to_jsonb(f) into v_fact from public.profile_facts f where f.id = p_fact_id;
  return jsonb_build_object(
    'action', case when v_origin = 'owner' then 'removed' else 'hidden_source' end,
    'fact', v_fact
  );
end;
$$;

revoke all on function public.owner_remove_profile_fact(uuid) from public, anon, authenticated;
grant execute on function public.owner_remove_profile_fact(uuid) to authenticated;

comment on function public.owner_remove_profile_fact(uuid) is
  'Explicit owner hide for profile facts. Evidence rows and history are retained; source facts may return after a later approved sync.';

commit;
