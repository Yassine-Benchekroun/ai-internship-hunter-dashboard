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

## Secure opportunity ingestion

The secure ingestion boundary is in:

- `supabase/migrations/202610270001_secure_opportunity_ingestion.sql`
- `supabase/functions/ingest-opportunities/index.ts`

The migration creates a normalized `opportunity_records` table with per-user RLS, a unique deduplication key, and an ingestion audit table. Repeated submissions for the same source URL, organization, and position update the existing record instead of creating a duplicate. New records start in `New / Unreviewed` with `Needs review` status.

The Edge Function accepts one opportunity or a batch of up to 100 opportunities. It requires an `INGEST_API_KEY`, validates domain relevance and source URLs, and uses a privileged server-side key only inside Supabase. Never put either key in GitHub Pages or browser JavaScript.

### Deploying the ingestion boundary

1. Run the migration in the Supabase SQL Editor.
2. Create the Edge Function named `ingest-opportunities` from the function folder.
3. Add these hosted function secrets: `INGEST_API_KEY` and `INGEST_OWNER_USER_ID`. The latter is the authenticated user's Supabase UUID.
4. Test the function with a small opportunity payload before connecting a scheduler.

The existing dashboard stores its UI state in `dashboard_state`. The normalized ingestion table is deliberately separate so scheduled writes cannot overwrite the whole dashboard JSON document. The dashboard's data-loading layer is connected to `opportunity_records`, so ingested rows can appear in its cards after sign-in.

The published static dashboard now includes `dist/opportunity-records-bridge.js`. When a user is signed in, it loads opportunities from `opportunity_records` and syncs dashboard edits back to that table. Applications, settings, and email drafts continue to use `dashboard_state`; demo records remain local-only and are never uploaded.

## GitHub Pages

The workflow in .github/workflows/deploy-pages.yml publishes the dist directory when main changes. Set the repository Pages source to GitHub Actions if GitHub has not enabled it automatically.

