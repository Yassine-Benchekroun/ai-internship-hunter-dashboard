-- Owner-managed profile facts are additive and remain clearly distinct from
-- facts extracted from approved GitHub/portfolio sources.
begin;

alter table public.profile_facts
  add column if not exists origin text not null default 'source',
  add column if not exists owner_hidden boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profile_facts_origin_check'
      and conrelid = 'public.profile_facts'::regclass
  ) then
    alter table public.profile_facts
      add constraint profile_facts_origin_check check (origin in ('source', 'owner'));
  end if;
end;
$$;

-- A source sync must never turn an owner-entered fact into source_missing.
-- The fact remains in the registry for review instead of being deleted.
create or replace function public.protect_owner_profile_fact()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.origin = 'owner' and new.verification_status = 'source_missing' then
    new.verification_status := old.verification_status;
    new.verified := old.verified;
    new.owner_hidden := old.owner_hidden;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_facts_owner_protection_trigger on public.profile_facts;
create trigger profile_facts_owner_protection_trigger
before update on public.profile_facts
for each row execute function public.protect_owner_profile_fact();

-- Narrow authenticated-owner RPC. It never accepts a caller-supplied user_id,
-- never promotes an owner entry to verified, and never deletes source facts.
create or replace function public.owner_manage_profile_fact(
  p_action text,
  p_fact_id uuid default null,
  p_category text default null,
  p_name text default null,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_action text := lower(trim(coalesce(p_action, '')));
  v_category text := lower(regexp_replace(trim(coalesce(p_category, '')), '\s+', ' ', 'g'));
  v_name text := trim(coalesce(p_name, ''));
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_normalized_name text;
  v_fact_id uuid;
  v_origin text;
  v_fact jsonb;
begin
  if v_user_id is null or not public.is_dashboard_owner() then
    raise exception 'owner_required';
  end if;
  if v_action not in ('add', 'update', 'upsert', 'remove') then
    raise exception 'invalid_profile_fact_action';
  end if;

  if v_action = 'remove' then
    if p_fact_id is null then raise exception 'fact_id_required'; end if;
    select id, origin into v_fact_id, v_origin
    from public.profile_facts
    where id = p_fact_id and user_id = v_user_id
    for update;
    if v_fact_id is null then raise exception 'profile_fact_not_found'; end if;

    update public.profile_facts
    set owner_hidden = true,
        verification_status = 'rejected',
        verified = false
    where id = v_fact_id and user_id = v_user_id;

    select to_jsonb(f) into v_fact from public.profile_facts f where f.id = v_fact_id;
    return jsonb_build_object('action', case when v_origin = 'owner' then 'removed' else 'hidden_source' end, 'fact', v_fact);
  end if;

  if v_category in ('skills') then v_category := 'skill'; end if;
  if v_category in ('technologies') then v_category := 'technology'; end if;
  if v_category in ('libraries') then v_category := 'library'; end if;
  if v_category in ('frameworks') then v_category := 'framework'; end if;
  if v_category in ('projects') then v_category := 'project'; end if;
  if v_category in ('experiences', 'work experience', 'work_experience', 'research experience') then v_category := 'experience'; end if;
  if v_category in ('educational') then v_category := 'education'; end if;
  if v_category in ('certifications') then v_category := 'certification'; end if;
  if v_category in ('languages') then v_category := 'language'; end if;
  if v_category not in ('skill', 'technology', 'library', 'framework', 'project', 'experience', 'education', 'certification', 'language') then
    raise exception 'invalid_profile_fact_category';
  end if;
  if v_name = '' then raise exception 'profile_fact_name_required'; end if;
  if char_length(v_name) > 200 then raise exception 'profile_fact_name_too_long'; end if;
  if v_description is not null and char_length(v_description) > 4000 then raise exception 'profile_fact_description_too_long'; end if;
  v_normalized_name := public.normalize_profile_name(v_category, v_name);
  if v_normalized_name is null then raise exception 'profile_fact_name_required'; end if;

  if p_fact_id is not null then
    select id, origin into v_fact_id, v_origin
    from public.profile_facts
    where id = p_fact_id and user_id = v_user_id
    for update;
    if v_fact_id is null then raise exception 'profile_fact_not_found'; end if;
    if v_origin <> 'owner' then raise exception 'source_fact_read_only'; end if;
  else
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || '|profile|' || v_category || '|' || v_normalized_name, 0));
    select id, origin into v_fact_id, v_origin
    from public.profile_facts
    where user_id = v_user_id and category = v_category and normalized_name = v_normalized_name
    for update;
  end if;

  if v_fact_id is null then
    insert into public.profile_facts (user_id, category, name, normalized_name, description, verified, verification_status, origin, owner_hidden)
    values (v_user_id, v_category, v_name, v_normalized_name, v_description, false, 'unverified', 'owner', false)
    returning id into v_fact_id;
  elsif v_origin = 'source' then
    select to_jsonb(f) into v_fact from public.profile_facts f where f.id = v_fact_id;
    return jsonb_build_object('action', 'source_fact_exists', 'fact', v_fact);
  else
    update public.profile_facts
    set category = v_category,
        name = v_name,
        description = v_description,
        verification_status = 'unverified',
        verified = false,
        origin = 'owner',
        owner_hidden = false
    where id = v_fact_id and user_id = v_user_id;
  end if;

  insert into public.profile_fact_evidence (user_id, fact_id, source_type, source_name, evidence, last_verified_at)
  values (v_user_id, v_fact_id, 'owner_input', 'Owner-provided', coalesce(v_description, 'Owner-entered fact; source verification pending.'), null)
  on conflict do nothing;
  update public.profile_fact_evidence
  set evidence = coalesce(v_description, 'Owner-entered fact; source verification pending.'),
      last_verified_at = null
  where fact_id = v_fact_id and source_type = 'owner_input' and source_name = 'Owner-provided';

  select to_jsonb(f) into v_fact from public.profile_facts f where f.id = v_fact_id;
  return jsonb_build_object('action', case when p_fact_id is null then 'added' else 'updated' end, 'fact', v_fact);
end;
$$;

revoke all on function public.protect_owner_profile_fact() from public, anon, authenticated;
revoke all on function public.owner_manage_profile_fact(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.owner_manage_profile_fact(text, uuid, text, text, text) to authenticated;

comment on function public.owner_manage_profile_fact(text, uuid, text, text, text) is
  'Owner-only manual profile edits. Entries remain unverified until approved-source evidence exists; source facts cannot be deleted.';

commit;
