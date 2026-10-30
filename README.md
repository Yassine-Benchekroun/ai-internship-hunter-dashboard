# AI Internship Hunter

Verified-first AI internship and research opportunity dashboard with opportunity history, application tracking, email draft management, Supabase persistence, and GitHub Pages deployment.

## Local preview

Run `node server.mjs` and open http://127.0.0.1:4173/.

Local development keeps a JSON fallback in data/dashboard-data.json. That file is ignored by Git so personal dashboard data is not committed to a public repository.

## Supabase setup

1. Run supabase-schema.sql in the Supabase SQL Editor.
2. Enable the Email provider under Supabase Authentication settings.
3. Add the deployed GitHub Pages URL to the allowed redirect URLs.
4. Use the dashboard cloud sign-in button to receive a magic link.

The browser uses supabase-config.js with the Project URL and publishable key. Never add a secret/service_role key.

Access control is per-user. Each authenticated Supabase user gets a workspace keyed by their immutable `auth.users.id`; signed-out sessions receive an empty state, and no email string is used as an authorization boundary. Database RLS and table privileges enforce the same boundary even if somebody clones or modifies the public frontend.

## Supabase Phase 1 data model

Run `supabase-schema.sql` first, then run the migration files in timestamp order:

1. `supabase/migrations/20261028182336_phase1_data_model.sql`
2. `supabase/migrations/20261028182506_phase1_function_hardening.sql`
3. `supabase/migrations/20261028184050_phase1_review_fixes.sql`
4. `supabase/migrations/20261028184232_phase1_ingestion_history_fix.sql`
5. `supabase/migrations/20261028184358_phase1_bridge_score_sync.sql`
6. `supabase/migrations/20261028190000_phase1_runtime_fixes.sql`
7. `supabase/migrations/20261028190500_phase1_score_sync_followup.sql`
8. `supabase/migrations/20261028200000_phase2_classification_fix.sql`
9. `supabase/migrations/20261028210000_phase3_secure_automation_interfaces.sql`
10. `supabase/migrations/20261028210500_phase3_ingest_ambiguity_fix.sql`
11. `supabase/migrations/20261028211000_phase3_event_conflict_fix.sql`
12. `supabase/migrations/20261028211500_phase3_artifact_ambiguity_fix.sql`
13. `supabase/migrations/20261028230000_phase4_browser_contract_hardening.sql`
14. `supabase/migrations/20261029220000_step1_auth_ownership_foundation.sql`

These migrations create the normalized `opportunity_records` table with per-user RLS, deterministic deduplication, independent application status, profile evidence, versioned artifacts, settings, and ingestion audit history. They are additive and preserve existing opportunity and application rows.

Phase 3 adds service-role-only RPC contracts for settings, Verified Profile Sync, opportunity ingestion, and Application Monitoring. The existing `ingest-opportunities` Edge Function source is tracked under `supabase/functions/ingest-opportunities/`; its platform JWT verification and private API-key check keep privileged writes server-side. No schedule or automatic email sender is created.

The Edge Function JWT requirement is pinned in `supabase/config.toml` and must remain enabled in every deployment.

The existing dashboard stores its UI state in `dashboard_state`. The normalized opportunity table is deliberately separate so scheduled writes cannot overwrite the whole dashboard JSON document. Backend-driven matching settings are mirrored to `user_settings`, and the dashboard's data-loading layer is connected to `opportunity_records`.

The published static dashboard includes `dist/opportunity-records-bridge.js` and `dist/phase2-ui.js`. When an authenticated user is signed in, it loads that user's opportunities from `opportunity_records`, applications from `application_records`, current CV/email artifacts from `cv_versions` and `email_drafts`, profile facts/evidence from `profile_facts` and `profile_fact_evidence`, the latest sync summary from `profile_sync_runs`, and matching settings from `user_settings`. UI-only filters and demo records remain local-only and are never uploaded. Destructive opportunity/application deletes are sent through explicit persisted deletion queues; ordinary snapshot reconciliation never deletes cloud history. The UI keeps match classification separate from application status, and future automation cards remain explanatory placeholders only.

Phase 2 behavior tests can be run with `node --test tests/phase2_ui.test.mjs`.

The Phase 3 contracts and payloads are documented in `docs/automation-contracts.md`. The rollback-safe SQL contract tests are in `supabase/tests/phase3_automation_interfaces.sql` and require a privileged Supabase SQL test session.

The production migration/version mapping is tracked in `docs/supabase-migration-ledger.md` because the managed migration service assigns production timestamps when migrations are applied.

## GitHub Pages

The workflow in .github/workflows/deploy-pages.yml publishes the dist directory when main changes. Set the repository Pages source to GitHub Actions if GitHub has not enabled it automatically.

