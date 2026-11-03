import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [index, phase2, bridge, migrations, docs, fixtures] = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8'),
  Promise.all([
    readFile(new URL('../supabase/migrations/20261028182336_phase1_data_model.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20261028210000_phase3_secure_automation_interfaces.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20261028230000_phase4_browser_contract_hardening.sql', import.meta.url), 'utf8')
  ]).then((files) => files.join('\n')),
  readFile(new URL('../docs/automation-contracts.md', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/phase3_automation_interfaces.sql', import.meta.url), 'utf8')
]);

const privateHandle = ['Yassine', 'Benchekroun'].join('-');
const privateGithub = ['github.com', privateHandle].join('/');
const privatePortfolio = [privateHandle.toLowerCase(), 'github.io'].join('.');
const realSourceMarkers = new RegExp([
  privateGithub,
  privatePortfolio,
  privateHandle,
  ['Yassine', 'Benchekroun'].join(' ')
].join('|'), 'i');

test('real source/profile values are absent from public build and repository fallbacks', () => {
  assert.doesNotMatch([index, phase2, bridge, migrations, docs, fixtures].join('\n'), realSourceMarkers);
});

test('public profile and evidence links are backend-driven', () => {
  assert.match(index, /public-source-registry/);
  assert.match(phase2, /approvedProfileSources\(\)/);
  assert.match(phase2, /approvedSourceLinksHTML\(\)/);
  assert.match(phase2, /Only backend-approved evidence may add profile facts/);
  assert.doesNotMatch(phase2, /hostname === 'github\\.com'|approvedHost/);
});

test('signed-out and non-owner paths cannot load private backend records', () => {
  assert.match(index, /window\.AIH_setDemoState\(\)/);
  assert.match(index, /if \(!cloudUser \|\| !window\.AIH_isOwnerSession\(cloudUser\)\)/);
  assert.match(bridge, /if \(!bridgeUser \|\| !window\.AIH_isOwnerSession \|\| !window\.AIH_isOwnerSession\(bridgeUser\)\)/);
  assert.match(bridge, /window\.AIH_loadBackendSettings = loadUserSettings/);
  assert.match(bridge, /state\.approvedProfileSources = \[\]/);
});

test('repository fallbacks preserve empty approved sources', () => {
  assert.doesNotMatch(migrations, /approved_profile_sources[^\n]*default '(?!\[\])/i);
  assert.match(migrations, /approved_profile_sources jsonb not null default '\[\]'::jsonb/);
  assert.match(migrations, /coalesce\(v_settings\.approved_profile_sources, '\[\]'::jsonb\)/);
});
