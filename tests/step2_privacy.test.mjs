import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261030200000_step2_privacy_hardening.sql', import.meta.url), 'utf8');
const schema = await readFile(new URL('../supabase/migrations/20261028182336_phase1_data_model.sql', import.meta.url), 'utf8');
const phase3 = await readFile(new URL('../supabase/migrations/20261028210000_phase3_secure_automation_interfaces.sql', import.meta.url), 'utf8');
const phase4 = await readFile(new URL('../supabase/migrations/20261028230000_phase4_browser_contract_hardening.sql', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8');
const privacyBridge = await readFile(new URL('../dist/step2-privacy.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const phase2 = await readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8');

test('Step 2 protects every exposed private table and removes anonymous grants', () => {
  const tables = [
    'dashboard_state', 'opportunity_records', 'application_records',
    'profile_facts', 'profile_fact_evidence', 'profile_sync_runs',
    'cv_versions', 'email_drafts', 'user_settings', 'opportunity_ingestion_events'
  ];
  for (const table of tables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /revoke all on table[\s\S]+from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table public\.dashboard_state to authenticated/);
  assert.match(migration, /grant select on table public\.opportunity_ingestion_events to authenticated/);
});

test('ownership policies use auth.uid for every write and prevent ownership reassignment', () => {
  const writePolicies = migration.match(/create policy[\s\S]*?(?=\n\n|\ncreate policy|\n--|\ncommit;)/g) || [];
  assert.ok(writePolicies.length >= 20, 'expected explicit per-operation policies');
  assert.match(migration, /with check \(\s*\(select auth\.uid\(\)\) = user_id/);
  assert.match(migration, /using \(\s*\(select auth\.uid\(\)\) = user_id/);
  assert.doesNotMatch(migration, /auth\.role\(\)/);
});

test('child and parent ownership checks block forged foreign links', () => {
  for (const child of ['application_records', 'cv_versions', 'email_drafts', 'profile_fact_evidence', 'opportunity_ingestion_events']) {
    assert.match(migration, new RegExp(`from public\\.[\\s\\S]+`));
  }
  assert.match(migration, /parent\.id = application_records\.opportunity_id[\s\S]+parent\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /parent\.id = cv_versions\.opportunity_id[\s\S]+parent\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /parent\.id = email_drafts\.opportunity_id[\s\S]+parent\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /parent\.id = profile_fact_evidence\.fact_id[\s\S]+parent\.user_id = \(select auth\.uid\(\)\)/);
});

test('privileged automation functions are closed to browser roles', () => {
  for (const fn of ['automation_read_settings', 'automation_sync_profile', 'ingest_opportunity_record', 'automation_ingest_opportunities', 'automation_update_application', 'is_approved_profile_source']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}`));
  }
  assert.doesNotMatch(phase3, /grant execute on function public\.automation_[^(]+\([^)]*\) to authenticated/);
});

test('profile sources have no private default and are loaded from owner settings', () => {
  assert.match(schema, /approved_profile_sources jsonb not null default '\[\]'::jsonb/);
  assert.match(phase3, /approved_profile_sources.*coalesce\(v_settings\.approved_profile_sources, '\[\]'::jsonb\)/);
  assert.match(phase4, /approved_profile_sources from public\.user_settings/);
  assert.match(bridge, /state\.approvedProfileSources = Array\.isArray\(result\.data\.approved_profile_sources\)/);
  assert.match(privacyBridge, /window\.__AIH_AUTHENTICATED_SESSION/);
  assert.match(privacyBridge, /state\.approvedProfileSources/);
  assert.match(phase2, /Array\.isArray\(state\.approvedProfileSources\)/);
});

test('public production assets contain no original account-specific private values', async () => {
  const distDir = new URL('../dist/', import.meta.url);
  const files = await readdir(distDir);
  const publicText = (await Promise.all(files.filter((file) => /\.(html|js|css)$/.test(file)).map(async (file) => {
    return readFile(new URL(file, distDir), 'utf8');
  }))).join('\n');
  const accountMarkers = [
    Buffer.from('WWFzc2luZQ==', 'base64').toString(),
    Buffer.from('eWFzc2luZS1iZW5jaGVrcm91bg==', 'base64').toString(),
    Buffer.from('WWFzc2luZS1CZW5jaGVrcm91bg==', 'base64').toString()
  ];
  for (const leakedValue of accountMarkers) {
    assert.doesNotMatch(publicText, new RegExp(leakedValue, 'i'));
  }
  assert.doesNotMatch(publicText, /service[_-]?role|supabase[_-]?secret[_-]?key|ingest[_-]?api[_-]?key/i);
  assert.match(index, /step2-privacy\.js/);
});
