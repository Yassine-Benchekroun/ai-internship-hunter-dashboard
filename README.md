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

## GitHub Pages

The workflow in .github/workflows/deploy-pages.yml publishes the dist directory when main changes. Set the repository Pages source to GitHub Actions if GitHub has not enabled it automatically.

