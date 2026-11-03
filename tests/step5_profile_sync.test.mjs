import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const endpoint = await readFile(new URL('../supabase/functions/sync-profile/index.ts', import.meta.url), 'utf8');
const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const docs = await readFile(new URL('../docs/automation-contracts.md', import.meta.url), 'utf8');
const publicFiles = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8'),
]);

test('Profile Sync endpoint is JWT-protected and derives account scope from the caller', () => {
  assert.match(config, /\[functions\.sync-profile\]/);
  assert.match(config, /\[functions\.sync-profile\][\s\S]*?verify_jwt\s*=\s*true/);
  assert.match(endpoint, /auth\.getUser\(token\)/);
  assert.match(endpoint, /const userId = userData\.user\.id/);
  assert.match(endpoint, /automation_read_settings/);
  assert.match(endpoint, /automation_sync_profile/);
  assert.match(endpoint, /is_approved_profile_source/);
  assert.match(endpoint, /user_id: userId/);
});

test('Profile Sync only fetches approved GitHub and portfolio sources and preserves missing facts', () => {
  assert.match(endpoint, /\["github", "portfolio"\]/);
  assert.match(endpoint, /githubOwner/);
  assert.match(endpoint, /api\.github\.com\/users/);
  assert.match(endpoint, /syncPortfolio/);
  assert.match(endpoint, /missing_facts/);
  assert.match(endpoint, /profile_fact_evidence/);
  assert.match(endpoint, /source_missing/);
  assert.doesNotMatch(endpoint, /cron\.schedule|pg_cron|send_mail|send_email/i);
});

test('Profile Sync keeps privileged credentials server-side', () => {
  assert.match(endpoint, /SUPABASE_SECRET_KEYS/);
  assert.match(endpoint, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(endpoint, /SUPABASE_CONFIG|sb_publishable_/i);
  assert.doesNotMatch(publicFiles.join('\n'), /service_role_key|supabase_secret_key|ingest_api_key|oauth[_-]?token/i);
});

test('Profile Sync contract documents source validation and no automatic sending', () => {
  assert.match(docs, /automation_sync_profile/);
  assert.match(docs, /approved profile sources/i);
  assert.match(docs, /never deletes a fact/i);
  assert.match(docs, /No contract sends mail/i);
});
