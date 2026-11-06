# Supabase migration ledger

The production project `cjwsyitmoussjnjjgdsv` records migrations with the timestamp assigned when the migration was applied. The repository keeps the reviewed SQL source names below. Keep this mapping with the repository when using a CLI or another deployment tool so an already-applied migration is not replayed under a different source name.

| Production version | Production name | Repository source |
| --- | --- | --- |
| 20261028182336 | phase1_data_model | `supabase/migrations/20261028182336_phase1_data_model.sql` |
| 20261028182506 | phase1_function_hardening | `supabase/migrations/20261028182506_phase1_function_hardening.sql` |
| 20261028184050 | phase1_review_fixes | `supabase/migrations/20261028184050_phase1_review_fixes.sql` |
| 20261028184232 | phase1_ingestion_history_fix | `supabase/migrations/20261028184232_phase1_ingestion_history_fix.sql` |
| 20261028184358 | phase1_bridge_score_sync | `supabase/migrations/20261028184358_phase1_bridge_score_sync.sql` |
| 20261028190111 | phase1_runtime_fixes | `supabase/migrations/20261028190000_phase1_runtime_fixes.sql` |
| 20261028190210 | phase1_score_sync_followup | `supabase/migrations/20261028190500_phase1_score_sync_followup.sql` |
| 20261028192728 | phase2_classification_fix | `supabase/migrations/20261028200000_phase2_classification_fix.sql` |
| 20261028194258 | phase3_secure_automation_interfaces | `supabase/migrations/20261028210000_phase3_secure_automation_interfaces.sql` |
| 20261028194345 | phase3_ingest_ambiguity_fix | `supabase/migrations/20261028210500_phase3_ingest_ambiguity_fix.sql` |
| 20261028194413 | phase3_event_conflict_fix | `supabase/migrations/20261028211000_phase3_event_conflict_fix.sql` |
| 20261028194507 | phase3_artifact_ambiguity_fix | `supabase/migrations/20261028211500_phase3_artifact_ambiguity_fix.sql` |
| 20261028195726 | phase4_browser_contract_hardening | `supabase/migrations/20261028230000_phase4_browser_contract_hardening.sql` |
| 20261029220721 | step1_auth_ownership_foundation | `supabase/migrations/20261029220000_step1_auth_ownership_foundation.sql` |
| 20261030181754 | step_2_privacy_hardening | `supabase/migrations/20261030200000_step2_privacy_hardening.sql` |
| 20261103223240 | step4_master_cv | `supabase/migrations/20261103000000_step4_master_cv.sql` |
| 20261106183512 | step8_application_monitor | `supabase/migrations/20261106170000_step8_application_monitor.sql` |
| 20261106183612 | step8_application_monitor_fk_index | `supabase/migrations/20261106184000_step8_application_monitor_fk_index.sql` |
| 20261106190147 | step9_run_health_cleanup | `supabase/migrations/20261106190000_step9_run_health_cleanup.sql` |

The production list was verified after applying Step 4. No scheduled automation or mail sender is part of these migrations.


## Step 1 reconciliation note — 2026-11-02

The live migration history was re-checked against this ledger. Production records the Step 1 and Step 2 migrations under the managed versions shown above, while the repository retains the reviewed source filenames used to reconstruct their intent.

The live database matches the canonical Step 1/Step 2 ownership, RLS, and table-grant contract for the ten protected public tables. Production also contains one redundant ownership-equivalent SELECT policy named `Users can read profile sync runs` alongside `Step 2 users can read their profile sync runs`. It is intentionally preserved for the later Supabase cleanup step; this reconciliation does not roll back live migrations, remove production data, or change the live schema.

## Step 4 deployment note — 2026-11-03

The managed production migration `20261103223240 step4_master_cv` maps to the reviewed repository source `20261103000000_step4_master_cv.sql`. The live `master_cv_versions` table, owner-only RLS policy, authenticated `save_master_cv` RPC, and targeted-CV separation were verified after deployment. The supplied Master CV was imported as owner revision 1 through the authenticated RPC; its source reference is `user-provided:master_cv.pdf`. The PDF remains private and is not tracked in Git.

## Step 8 deployment note — 2026-11-06

The managed production migrations `20261106183512 step8_application_monitor`
and `20261106183612 step8_application_monitor_fk_index` map to the reviewed
repository sources above. Production now has owner-readable, service-role-
written monitor run/event history, message-id idempotency, and the
`application-monitor` Edge Function at version 1 with `verify_jwt = true`.
The controlled rollback-only application test passed for status propagation,
follow-up draft creation, duplicate message suppression, run logging, and
browser-role denial. The provider remains revoked from the completed Step 7
lifecycle, so no real mailbox content was read and no reconnect was attempted.

## Step 9 deployment note — 2026-11-06

The managed production migration `20261106190147 step9_run_health_cleanup`
removed only the redundant `Users can read profile sync runs` SELECT policy;
the canonical Step 2 owner-scoped policy, RLS, grants, and all run rows were
preserved. The dashboard now reads owner-scoped latest run summaries from the
profile sync, opportunity ingestion, and application monitor histories while
rendering only safe dates, statuses, bounded counts, and error counts.
