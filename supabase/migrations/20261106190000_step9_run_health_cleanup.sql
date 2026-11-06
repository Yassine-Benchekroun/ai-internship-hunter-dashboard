-- Step 9 — remove the redundant profile sync read policy.
--
-- The Step 2 policy is the canonical owner-scoped SELECT policy. The older
-- ownership-equivalent policy adds no access and causes a duplicate-policy
-- performance finding.

begin;

drop policy if exists "Users can read profile sync runs" on public.profile_sync_runs;

commit;
