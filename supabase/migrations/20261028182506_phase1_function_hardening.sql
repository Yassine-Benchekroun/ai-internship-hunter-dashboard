-- Phase 1 follow-up: make helper function search paths explicit and cover the
-- application-to-opportunity foreign key. This is additive and non-destructive.

begin;

alter function public.is_dashboard_owner() set search_path = public;
alter function public.normalize_profile_name(text, text) set search_path = public;
alter function public.classify_opportunity_score(integer, integer) set search_path = public;
alter function public.set_updated_at() set search_path = public;
alter function public.prepare_profile_fact() set search_path = public;
alter function public.prepare_opportunity_record() set search_path = public;

create index if not exists application_records_opportunity_id_idx
  on public.application_records (opportunity_id);

commit;
