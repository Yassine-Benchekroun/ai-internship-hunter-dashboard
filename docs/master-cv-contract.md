# Master CV backend contract

Step 4 adds `public.master_cv_versions` as the canonical, user-owned Master CV source. Each saved row is a user-supplied revision with a server-assigned `revision`, timestamps, and an `is_current` flag. A revision must contain either supplied `content` or a supplied `source_reference`; the backend never invents CV text or claims.

Authenticated sessions can select only their own rows through RLS. Direct authenticated inserts, updates, and deletes are revoked. `public.save_master_cv(jsonb)` is the invoker RPC wrapper for the validated private-schema import/save path: ownership comes from `auth.uid()`, revision/current state are server-controlled, payload types and sizes are bounded, and one current revision is maintained per user.

Targeted opportunity CV artifacts remain in `public.cv_versions`. The Master CV table has no `opportunity_id`, and the Master CV save function never writes `cv_versions`; targeted versions can therefore continue to derive from approved profile facts, a user-approved Master CV, and opportunity requirements in a later step.
