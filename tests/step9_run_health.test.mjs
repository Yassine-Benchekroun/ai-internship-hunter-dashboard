import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [migration, bridge, ui, docs, readme] = await Promise.all([
  readFile(new URL('../supabase/migrations/20261106190000_step9_run_health_cleanup.sql', import.meta.url), 'utf8'),
  readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../docs/automation-contracts.md', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
]);

test('Step 9 removes only the redundant profile sync read policy', () => {
  assert.match(migration, /drop policy if exists "Users can read profile sync runs" on public\.profile_sync_runs/i);
  assert.doesNotMatch(migration, /drop table|delete from|truncate|drop index/i);
});

test('run-health loading is owner-scoped and projects safe bounded fields only', () => {
  assert.match(bridge, /from\('opportunity_ingestion_events'\)[\s\S]*?opportunities_received/);
  assert.match(bridge, /from\('application_monitor_runs'\)[\s\S]*?messages_scanned/);
  assert.match(bridge, /state\.runHealth = \{/);
  assert.match(bridge, /errorCount: runErrorCount\(run\.errors\)/);
  assert.doesNotMatch(bridge, /select\('\*'\).*application_monitor_runs/);
});

test('run-health UI never renders secrets or raw error payloads', () => {
  assert.match(ui, /Run health/);
  assert.match(ui, /Tokens, message bodies, source excerpts, and credentials stay out/);
  assert.match(ui, /errorCount/);
  assert.doesNotMatch(ui, /access_token|refresh_token|service_role_key|SUPABASE_SECRET_KEYS/i);
});

test('passwordless security decision is documented', () => {
  assert.match(docs, /signInWithOtp/);
  assert.match(docs, /leaked-password-protection warning/i);
  assert.match(readme, /safe last-run summaries/);
});
