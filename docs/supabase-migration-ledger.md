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

The production list was verified after applying Phase 4. No scheduled automation or mail sender is part of these migrations.
