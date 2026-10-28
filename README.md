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

Access control is owner-only. The deployed dashboard identifies the single approved Supabase user by immutable user ID; signed-out and non-owner sessions receive a read-only demo state, and Settings is available only to the owner session. Database RLS and table privileges enforce the same boundary even if somebody clones or modifies the public frontend.

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

These migrations create the normalized `opportunity_records` table with owner-only RLS, deterministic deduplication, independent application status, profile evidence, versioned artifacts, settings, and ingestion audit history. They are additive and preserve existing opportunity and application rows.

Server-side opportunity ingestion is not included in this phase. Do not follow references to an Edge Function or migration file that are not present in this repository. Any future ingestion boundary must validate payloads server-side, use a privileged key only inside Supabase, and never expose that key in GitHub Pages or browser JavaScript.

The existing dashboard stores its UI state in `dashboard_state`. The normalized opportunity table is deliberately separate so scheduled writes cannot overwrite the whole dashboard JSON document. Backend-driven matching settings are mirrored to `user_settings`, and the dashboard's data-loading layer is connected to `opportunity_records`.

The published static dashboard includes `dist/opportunity-records-bridge.js` and `dist/phase2-ui.js`. When the owner is signed in, it loads opportunities from `opportunity_records`, profile facts/evidence from `profile_facts` and `profile_fact_evidence`, the latest sync summary from `profile_sync_runs`, mirrors matching settings to `user_settings`, and syncs opportunity edits back to the normalized table. Application drafts and UI-only state remain in `dashboard_state`; demo records remain local-only and are never uploaded. The UI keeps match classification separate from application status, and future automation cards remain explanatory placeholders only.

Phase 2 behavior tests can be run with `node --test tests/phase2_ui.test.mjs`.

## GitHub Pages

The workflow in .github/workflows/deploy-pages.yml publishes the dist directory when main changes. Set the repository Pages source to GitHub Actions if GitHub has not enabled it automatically.

