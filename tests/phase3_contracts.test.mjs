import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261028210000_phase3_secure_automation_interfaces.sql', import.meta.url), 'utf8');
const docs = await readFile(new URL('../docs/automation-contracts.md', import.meta.url), 'utf8');
const edgeFunction = await readFile(new URL('../supabase/functions/ingest-opportunities/index.ts', import.meta.url), 'utf8');
const publicFiles = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8'),
]);

test('Phase 3 exposes all four narrow server-side contracts', () => {
  for (const name of [
    'automation_read_settings',
    'automation_sync_profile',
    'automation_ingest_opportunities',
    'automation_update_application',
  ]) assert.match(migration, new RegExp(`function public\\.${name}`));
  assert.match(migration, /revoke all on function public\.automation_sync_profile\(jsonb\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.automation_update_application\(jsonb\) to service_role/);
});

test('Phase 3 contracts preserve history and prohibit automatic sending/scheduling', () => {
  assert.match(docs, /Verified Profile Sync/);
  assert.match(docs, /Opportunity Discovery/);
  assert.match(docs, /Application Monitor/);
  assert.match(docs, /sends email/i);
  assert.doesNotMatch(migration, /cron\.schedule|pg_cron|send_mail|send_email/i);
});

test('the ingestion boundary requires JWT verification and a private API key', () => {
  assert.match(edgeFunction, /x-ingest-api-key/);
  assert.match(edgeFunction, /automation_ingest_opportunities/);
  assert.doesNotMatch(edgeFunction, /SUPABASE_CONFIG|sb_publishable_/i);
});

test('public GitHub Pages assets contain no privileged automation credentials', () => {
  const publicText = publicFiles.join('\n');
  assert.doesNotMatch(publicText, /service_role_key|supabase_secret_key|ingest_api_key|oauth[_-]?token/i);
});
