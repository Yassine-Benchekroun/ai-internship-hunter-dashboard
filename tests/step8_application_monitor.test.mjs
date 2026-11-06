import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [migration, endpoint, config, sqlTest, docs, publicFiles] = await Promise.all([
  readFile(new URL('../supabase/migrations/20261106170000_step8_application_monitor.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/application-monitor/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/step8_application_monitor.sql', import.meta.url), 'utf8'),
  readFile(new URL('../docs/automation-contracts.md', import.meta.url), 'utf8'),
  Promise.all([
    readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8'),
  ]),
]).then((files) => files.map((file) => Array.isArray(file) ? file.join('\n') : file.replace(/\r\n/g, '\n')));

test('Application Monitor keeps owner-scoped run/event history and idempotency server-side', () => {
  assert.match(migration, /create table if not exists public\.application_monitor_runs/);
  assert.match(migration, /create table if not exists public\.application_monitor_events/);
  assert.match(migration, /unique \(user_id, application_id, provider, provider_message_id\)/);
  assert.match(migration, /automation_log_application_monitor_run/);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*provider_message_id/);
  assert.match(migration, /grant execute on function public\.automation_update_application\(jsonb\) to service_role/);
  assert.match(sqlTest, /duplicate provider message must be ignored/i);
});

test('Application Monitor authenticates the owner and uses Gmail read-only metadata only', () => {
  assert.match(config, /\[functions\.application-monitor\]/);
  assert.match(config, /\[functions\.application-monitor\][\s\S]*?verify_jwt\s*=\s*true/);
  assert.match(endpoint, /auth\.getUser\(token\)/);
  assert.match(endpoint, /provider_oauth_get_connection/);
  assert.match(endpoint, /automation_update_application/);
  assert.match(endpoint, /automation_log_application_monitor_run/);
  assert.match(endpoint, /gmail\.readonly/);
  assert.match(endpoint, /format.*metadata/);
  assert.match(endpoint, /dryRun/);
  assert.doesNotMatch(endpoint, /gmail\.(send|compose|modify)|mail\.google\.com/i);
  assert.doesNotMatch(endpoint, /messages[^\n]*send|users\/me\/messages\/[^`]+\/send/i);
  assert.doesNotMatch(endpoint, /cron\.schedule|pg_cron|send_mail|send_email/i);
});

test('monitor contract documents safe dry runs, deduplication, and draft-only follow-ups', () => {
  assert.match(docs, /application-monitor/);
  assert.match(docs, /gmail\.readonly/);
  assert.match(docs, /idempotency key/i);
  assert.match(docs, /never sends email/i);
});

test('public assets remain free of monitor credentials or provider tokens', () => {
  assert.doesNotMatch(publicFiles, /service_role_key|supabase_secret_key|refresh_token|access_token|google_client_secret/i);
});
