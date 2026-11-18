-- Keep owner profile editing behind the same row-level ownership boundary as
-- profile reads. The RPC is intentionally invoker-security: authenticated
-- callers receive only the narrow writes granted by these policies.
begin;

grant select, insert, update on public.profile_facts to authenticated;
grant select, insert, update on public.profile_fact_evidence to authenticated;
grant execute on function public.normalize_profile_name(text, text) to authenticated;

drop policy if exists "Owner can insert owner profile facts" on public.profile_facts;
create policy "Owner can insert owner profile facts"
  on public.profile_facts for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and origin = 'owner'
    and owner_hidden = false
    and verified = false
    and verification_status = 'unverified'
  );

drop policy if exists "Owner can update owner profile facts" on public.profile_facts;
create policy "Owner can update owner profile facts"
  on public.profile_facts for update to authenticated
  using (
    (select auth.uid()) = user_id
    and origin = 'owner'
  )
  with check (
    (select auth.uid()) = user_id
    and origin = 'owner'
    and verified = false
    and verification_status in ('unverified', 'rejected')
  );

drop policy if exists "Owner can insert owner profile evidence" on public.profile_fact_evidence;
create policy "Owner can insert owner profile evidence"
  on public.profile_fact_evidence for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and source_type = 'owner_input'
    and source_name = 'Owner-provided'
    and exists (
      select 1 from public.profile_facts parent
      where parent.id = profile_fact_evidence.fact_id
        and parent.user_id = (select auth.uid())
        and parent.origin = 'owner'
    )
  );

drop policy if exists "Owner can update owner profile evidence" on public.profile_fact_evidence;
create policy "Owner can update owner profile evidence"
  on public.profile_fact_evidence for update to authenticated
  using (
    (select auth.uid()) = user_id
    and source_type = 'owner_input'
    and source_name = 'Owner-provided'
  )
  with check (
    (select auth.uid()) = user_id
    and source_type = 'owner_input'
    and source_name = 'Owner-provided'
    and exists (
      select 1 from public.profile_facts parent
      where parent.id = profile_fact_evidence.fact_id
        and parent.user_id = (select auth.uid())
        and parent.origin = 'owner'
    )
  );

alter function public.owner_manage_profile_fact(text, uuid, text, text, text)
  security invoker;

revoke all on function public.owner_manage_profile_fact(text, uuid, text, text, text)
  from public, anon;
grant execute on function public.owner_manage_profile_fact(text, uuid, text, text, text)
  to authenticated;

commit;
