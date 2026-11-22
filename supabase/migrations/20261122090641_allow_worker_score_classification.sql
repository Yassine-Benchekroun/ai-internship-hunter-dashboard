begin;

-- Artifact preparation updates readiness as the Edge Function's service role.
-- The opportunity trigger calls this deterministic score helper on that update.
grant execute on function public.classify_opportunity_score(integer, integer) to service_role;

commit;
