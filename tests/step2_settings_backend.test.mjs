import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(path.join(root, 'dist', 'opportunity-records-bridge.js'), 'utf8');

test('the Supabase bridge round-trips editable Step 2 settings only', () => {
  for (const field of [
    'daily_opportunity_target',
    'domain_relevance_enabled',
    'target_countries',
    'opportunity_types',
    'approved_profile_sources',
    'sender_identity_email',
    'sender_identity_name',
    'provider_connection_status'
  ]) assert.match(bridgeSource, new RegExp(field));
  assert.match(bridgeSource, /state\.countries = settingsStringList\(result\.data\.target_countries\)/);
  assert.match(bridgeSource, /state\.approvedProfileSources = approvedProfileSources\(result\.data\.approved_profile_sources\)/);
  assert.match(bridgeSource, /var countries = backendSettingsLoaded \? settingsStringList\(state\.countries\) : \[\]/);
  assert.match(bridgeSource, /var sources = backendSettingsLoaded \? approvedProfileSources\(state\.approvedProfileSources\) : \[\]/);
  assert.doesNotMatch(bridgeSource, /match_threshold|state\.threshold/);
});

test('ordinary dashboard persistence does not overwrite discovery and profile settings', () => {
  const persistSource = bridgeSource.slice(bridgeSource.indexOf('window.persist = function'));
  assert.doesNotMatch(persistSource, /syncUserSettings\(|user_settings/);
  assert.match(bridgeSource, /function syncUserSettings\(fields\)/);
  assert.match(bridgeSource, /\.update\(patch\)\.eq\('user_id', ownerId\)/);
  assert.match(bridgeSource, /ignoreDuplicates: true/);
});

test('local backend persists Step 2 settings across refresh without inventing sources or countries', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'aih-step2-'));
  const priorDataDir = process.env.AIH_DATA_DIR;
  process.env.AIH_DATA_DIR = dataDir;
  const backend = await import(`../server.mjs?step2=${Date.now()}`);
  try {
    const initial = backend.settingsPayload(await backend.readState());
    assert.deepEqual(initial.countries, []);
    assert.deepEqual(initial.approvedProfileSources, []);

    const saved = {
      ...initial,
      threshold: 82,
      qualityTarget: 20,
      domainRelevanceEnabled: false,
      opportunityTypes: ['internship'],
      countries: [],
      approvedProfileSources: [],
      connectedEmail: 'sender@example.com',
      senderIdentityName: 'Sender',
      providerConnectionStatus: 'not_connected'
    };
    const expected = { ...saved, threshold: 70 };
    assert.deepEqual(backend.settingsPayload(await backend.writeState(saved)), expected);

    const refreshed = backend.settingsPayload(await backend.readState());
    assert.deepEqual(refreshed, expected);
    const fullState = await backend.readState();
    assert.deepEqual(fullState.countries, []);
    assert.deepEqual(fullState.approvedProfileSources, []);
    assert.equal(fullState.providerConnectionStatus, 'not_connected');
  } finally {
    if (priorDataDir === undefined) delete process.env.AIH_DATA_DIR;
    else process.env.AIH_DATA_DIR = priorDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
