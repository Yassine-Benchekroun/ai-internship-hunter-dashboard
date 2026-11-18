-- Reuse unchanged pre-schedule artifacts without backfilling keys, changing
-- their content, or creating duplicate versions. New content still appends an
-- immutable automated version under the existing opportunity lock.
begin;

create or replace function public.automation_prepare_artifacts(p_user_id uuid,p_opportunity_id uuid,p_cv jsonb,p_email jsonb,p_content_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_cv_id uuid; v_email_id uuid; v_version integer; v_cv_key text; v_email_key text; v_cv_created boolean:=false; v_email_created boolean:=false;
begin
  if nullif(p_content_key,'') is null or length(p_content_key)>128 then raise exception 'invalid_content_key'; end if;
  perform 1 from public.opportunity_records where id=p_opportunity_id and user_id=p_user_id for update;
  if not found then raise exception 'opportunity_not_found'; end if;
  if p_cv is not null and jsonb_typeof(p_cv)<>'null' then
    if jsonb_typeof(p_cv)<>'object' or nullif(btrim(p_cv->>'content'),'') is null then raise exception 'invalid_cv'; end if;
    v_cv_key:=encode(extensions.digest(convert_to(p_cv->>'content','UTF8'),'sha256'),'hex');
    select id into v_cv_id from public.cv_versions where user_id=p_user_id and opportunity_id=p_opportunity_id and automation_content_key=v_cv_key;
    if v_cv_id is null then
      -- Prefer the current legacy version if historical duplicates already exist.
      -- A read lock prevents concurrent editing during this exact-content reuse.
      select id into v_cv_id from public.cv_versions
        where user_id=p_user_id and opportunity_id=p_opportunity_id
          and automation_content_key is null and content=p_cv->>'content'
        order by is_current desc,version desc,id
        limit 1 for share;
    end if;
    if v_cv_id is null then
      select coalesce(max(version),0)+1 into v_version from public.cv_versions where user_id=p_user_id and opportunity_id=p_opportunity_id;
      update public.cv_versions set is_current=false where user_id=p_user_id and opportunity_id=p_opportunity_id and is_current;
      insert into public.cv_versions(user_id,opportunity_id,version,is_current,change_summary,content,automation_content_key)
        values(p_user_id,p_opportunity_id,v_version,true,left(p_cv->>'change_summary',500),p_cv->>'content',v_cv_key) returning id into v_cv_id;
      v_cv_created:=true;
    end if;
  end if;
  if p_email is not null and jsonb_typeof(p_email)<>'null' then
    if jsonb_typeof(p_email)<>'object' or nullif(btrim(p_email->>'body'),'') is null then raise exception 'invalid_email_draft'; end if;
    v_email_key:=encode(extensions.digest(convert_to(jsonb_build_object('recipient',p_email->>'recipient','subject',p_email->>'subject','body',p_email->>'body')::text,'UTF8'),'sha256'),'hex');
    select id into v_email_id from public.email_drafts where user_id=p_user_id and opportunity_id=p_opportunity_id and automation_content_key=v_email_key;
    if v_email_id is null then
      select id into v_email_id from public.email_drafts
        where user_id=p_user_id and opportunity_id=p_opportunity_id and automation_content_key is null
          and recipient is not distinct from nullif(p_email->>'recipient','')
          and subject is not distinct from (p_email->>'subject') and body=p_email->>'body'
        order by is_current desc,version desc,id
        limit 1 for share;
    end if;
    if v_email_id is null then
      select coalesce(max(version),0)+1 into v_version from public.email_drafts where user_id=p_user_id and opportunity_id=p_opportunity_id;
      update public.email_drafts set is_current=false where user_id=p_user_id and opportunity_id=p_opportunity_id and is_current;
      insert into public.email_drafts(user_id,opportunity_id,version,is_current,recipient,subject,body,automation_content_key)
        values(p_user_id,p_opportunity_id,v_version,true,nullif(p_email->>'recipient',''),p_email->>'subject',p_email->>'body',v_email_key) returning id into v_email_id;
      v_email_created:=true;
    end if;
  end if;
  -- Preparation readiness remains independent from sending and matching.
  update public.opportunity_records set status='Needs review' where id=p_opportunity_id and user_id=p_user_id and application_status='not_sent';
  return jsonb_build_object('cv_id',v_cv_id,'email_draft_id',v_email_id,'cv_created',v_cv_created,'email_created',v_email_created,'duplicate',not v_cv_created and not v_email_created);
end; $$;

revoke all on function public.automation_prepare_artifacts(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.automation_prepare_artifacts(uuid,uuid,jsonb,jsonb,text) to service_role;

commit;
