-- The invoker RPC uses this immutable, secret-free canonicalizer.
begin;
grant execute on function public.normalize_profile_name(text, text) to authenticated;
commit;
