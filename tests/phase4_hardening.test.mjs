import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bridge = await readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8');
const ui = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const phase2 = await readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261028230000_phase4_browser_contract_hardening.sql', import.meta.url), 'utf8');
const phase3Migration = await readFile(new URL('../supabase/migrations/20261028210000_phase3_secure_automation_interfaces.sql', import.meta.url), 'utf8');

test('browser bridge syncs normalized application and artifact tables', () => {
  assert.match(bridge, /from\('application_records'\)/);
  assert.match(bridge, /from\('cv_versions'\)/);
  assert.match(bridge, /from\('email_drafts'\)/);
  assert.match(bridge, /queueCloudOpportunityDeletion/);
  assert.match(bridge, /queueCloudApplicationDeletion/);
});

test('opportunity reconciliation only deletes explicitly queued records', () => {
  assert.match(bridge, /cloudOpportunityDeleteQueue/);
  assert.doesNotMatch(bridge, /knownOpportunityIds\)\.filter/);
  assert.match(ui, /queueCloudOpportunityDeletion/);
  assert.match(ui, /queueCloudApplicationDeletion/);
});

test('source-less manual records stay source-less after cloud hydration', () => {
  assert.match(bridge, /localSourcePrefix/);
  assert.match(bridge, /isLocalSourcePlaceholder/);
  assert.match(bridge, /if \(!source \|\| isLocalSourcePlaceholder\(source\)\) return ''/);
});

test('profile sync enforces approved evidence sources', () => {
  assert.match(phase3Migration, /is_approved_profile_source/);
  assert.match(phase3Migration, /profile evidence source is not approved/);
  assert.match(migration, /approved_profile_sources/);
  assert.doesNotMatch(migration, /pg_get_functiondef|v_updated_definition/);
});

test('published inline scripts compile', () => {
  const scripts = [...ui.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim());
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new Function(source));
});

test('Pages deployment is gated by verification', () => {
  assert.match(workflow, /verify:/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /node --test tests\/\*\.test\.mjs/);
  assert.match(workflow, /privileged credential/i);
});

test('Settings has one authoritative implementation', () => {
  assert.equal((ui.match(/function settingsHTML\(/g) || []).length, 1);
  assert.match(ui, /function settingsHTML\(\)\{return''\}/);
  assert.match(phase2, /single authoritative Settings renderer/);
  assert.doesNotMatch(ui, /function saveEmailConnection\(/);
  assert.doesNotMatch(ui, /updateEmailIdentityUI/);
});
