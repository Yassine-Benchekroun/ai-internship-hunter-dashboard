import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const phase2Source = fs.readFileSync(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8');

function loadPhase2(opportunities = [], saveSettings, importUi = {}) {
  const state = {
    threshold: 82,
    opportunities,
    profileFacts: [],
    profileSync: null,
    connected: true,
    connectedEmail: '',
    providerConnectionStatus: 'not_connected',
    emailProviderConnected: false,
    emailProvider: ''
  };
  const noOpNode = () => ({
    appendChild() {},
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertBefore() {},
    insertAdjacentHTML() {},
    set textContent(value) { this._textContent = value; },
    get textContent() { return this._textContent || ''; }
  });
  const document = {
    head: noOpNode(),
    body: noOpNode(),
    createElement: noOpNode,
    getElementById: (id) => importUi.nodes?.[id] ?? (id === 'phase2-sender-email' ? { value: 'me@example.com' } : noOpNode()),
    querySelector: noOpNode,
    querySelectorAll: () => []
  };
  const context = {
    console,
    document,
    innerWidth: 1200,
    URL,
    MATCH_THRESHOLD: 70,
    state,
    window: {
      __AIH_OWNER_SESSION: importUi.ownerSession ?? null,
      AIH_saveBackendSettings: saveSettings,
      AIH_requireOwner: importUi.requireOwner,
      AIH_importOpportunityLinks: importUi.importLinks,
      AIH_runOpportunityDiscovery: importUi.runDiscovery
    },
    pageIntro: () => '',
    icon: () => '',
    esc: (value) => String(value ?? ''),
    fmtDate: (value) => String(value ?? ''),
    overviewHTML: () => '<div class="dashboard-grid"></div>',
    profileHTML: () => '',
    settingsHTML: () => '',
    statusPill: () => '',
    classifyOpportunity: () => {},
    toggleConnection: () => {},
    render: () => {},
    saveManualApplication: () => {},
    persist: () => {},
    toast: () => {},
    navigate: () => {},
    opp: () => null
  };
  vm.createContext(context);
  vm.runInContext(phase2Source, context, { filename: 'phase2-ui.js' });
  return {
    api: context.window.AIH_phase2,
    saveDailyQuota: context.window.saveDailyQuota,
    saveSenderIdentity: context.window.saveSenderIdentity,
    submitImport: context.window.submitOpportunityLinkImport,
    runDiscovery: context.window.runOpportunityDiscoveryNow,
    profileHTML: context.profileHTML,
    settingsHTML: context.settingsHTML,
    state
  };
}

test('score classification uses a fixed 70 boundary despite saved legacy values', () => {
  const { api } = loadPhase2();
  for (const [score, expected] of [[74, 'top'], [70, 'top'], [69, 'lower'], [62, 'lower'], [0, 'lower']]) {
    const opportunity = { score, activeSections: ['new'] };
    api.classify(opportunity);
    assert.equal(opportunity.classification, expected);
    assert.deepEqual(opportunity.activeSections, [expected]);
  }
});

test('settings show a read-only cutoff and a numeric quota with the recorded shortfall', () => {
  const { settingsHTML, state } = loadPhase2();
  state.qualityTarget = 20;
  state.runHealth.opportunityIngestion = { dailyTarget: 30, dailyDiscovered: 24, dailyShortfall: 6, searchRequestLimit: 1000, searchRequestsMonthToDate: 42, searchRequestsRemaining: 958 };
  const html = settingsHTML();
  assert.match(html, /Fixed at 70/);
  assert.doesNotMatch(html, /type="range"|setThreshold/);
  assert.match(html, /<option value="20" selected>20 opportunities<\/option>/);
  assert.match(html, /24 of 30 new opportunities · 6 short of quota/);
  assert.match(html, /search API 42\/1000 used, 958 left/);
});

test('changing the daily quota saves only the quota field', async () => {
  const writes = [];
  const { saveDailyQuota, state } = loadPhase2([], async fields => writes.push(Array.from(fields)));
  await saveDailyQuota('20');
  assert.equal(state.qualityTarget, 20);
  assert.deepEqual(writes, [['daily_opportunity_target']]);
});

test('owner link import previews a normalized batch and reports safe feedback', async () => {
  const calls = [];
  const nodes = {
    'phase2-import-urls': { value: '- [Example posting](https://example.org/jobs/123#apply)\nhttps://example.org/jobs/123' },
    'phase2-import-status': {},
    'phase2-import-preview': {},
    'phase2-import-submit': {}
  };
  let owner = false;
  const { submitImport } = loadPhase2([], undefined, {
    nodes,
    requireOwner: () => owner,
    importLinks: async (links, dryRun) => {
      calls.push([Array.from(links), dryRun]);
      return {
        status: 'partial',
        counts: { valid_opportunities: 1, rejected_other: 1 },
        errors: ['unsupported_import_source', 'arbitrary_error_that_must_not_render']
      };
    }
  });
  await submitImport(true);
  assert.equal(calls.length, 0);
  owner = true;
  await submitImport(true);
  assert.deepEqual(calls, [[['https://example.org/jobs/123'], true]]);
  assert.match(nodes['phase2-import-status'].textContent, /1 eligible posting/);
  assert.match(nodes['phase2-import-status'].textContent, /unsupported site/);
  assert.doesNotMatch(nodes['phase2-import-status'].textContent, /arbitrary_error/);
  nodes['phase2-import-urls'].value = 'http://example.org/jobs/123';
  await submitImport(false);
  assert.equal(calls.length, 1);
  assert.match(nodes['phase2-import-status'].textContent, /Line 1 must contain one public HTTPS posting link/);
  assert.equal(nodes['phase2-import-submit'].disabled, false);
});

test('owner can run discovery now and sees pending state and the saved count', async () => {
  const nodes = { 'phase2-discovery-run': {}, 'phase2-discovery-run-status': {} };
  let finish;
  let runs = 0;
  const { settingsHTML, runDiscovery } = loadPhase2([], undefined, {
    ownerSession: { id: 'owner' },
    requireOwner: () => true,
    nodes,
    runDiscovery: () => {
      runs += 1;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  assert.doesNotMatch(loadPhase2().settingsHTML(), /Run discovery now/);
  assert.match(settingsHTML(), /Run discovery now/);
  const pending = runDiscovery();
  assert.equal(nodes['phase2-discovery-run'].disabled, true);
  assert.match(nodes['phase2-discovery-run-status'].textContent, /Searching configured sources/);
  await runDiscovery();
  assert.equal(runs, 1);
  finish({ status: 'failed', counts: { inserted_count: 3, updated_count: 2, daily_target: 30, daily_discovered: 12 } });
  await pending;
  assert.equal(nodes['phase2-discovery-run'].disabled, false);
  assert.match(nodes['phase2-discovery-run-status'].textContent, /Failed\. 3 added\. 2 updated\. 12 of 30 new opportunities today/);
});

test('older scores are reclassified without changing application status or restoring hidden cards', () => {
  const legacy = [
    { score: 69, classification: 'top', activeSections: ['top'], status: 'Already Sent' },
    { score: 70, classification: 'lower', activeSections: ['lower'], status: 'Needs review' },
    { score: 70, classification: 'new', activeSections: ['new'] },
    { score: 70, classification: 'top', activeSections: [] }
  ];
  loadPhase2(legacy);
  assert.deepEqual(legacy, [
    { score: 69, classification: 'lower', activeSections: ['lower'], status: 'Already Sent' },
    { score: 70, classification: 'top', activeSections: ['top'], status: 'Needs review' },
    { score: 70, classification: 'new', activeSections: ['new'] },
    { score: 70, classification: 'top', activeSections: [] }
  ]);
});

test('application status does not override match classification', () => {
  const { api } = loadPhase2();
  const opportunity = { score: 68, status: 'Already Sent', activeSections: ['new'] };
  api.classify(opportunity);
  assert.equal(opportunity.classification, 'lower');
  assert.equal(opportunity.status, 'Already Sent');
});

test('manual sent reclassification fixes stale sections without changing status', () => {
  const { api, state } = loadPhase2();
  state.opportunities = [{ score: 68, status: 'Already Sent', sent: true, activeSections: ['top'] }];
  api.reclassifySent();
  assert.equal(state.opportunities[0].classification, 'lower');
  assert.deepEqual(state.opportunities[0].activeSections, ['lower']);
  assert.equal(state.opportunities[0].status, 'Already Sent');
});

test('top classification makes an unsent review actionable without changing sent status', () => {
  const { api } = loadPhase2();
  const ready = { score: 74, status: 'Needs review', sent: false, activeSections: ['new'] };
  api.classify(ready);
  assert.equal(ready.classification, 'top');
  assert.equal(ready.status, 'Ready');

  const alreadySent = { score: 74, status: 'Already Sent', sent: true, activeSections: ['new'] };
  api.classify(alreadySent);
  assert.equal(alreadySent.status, 'Already Sent');
});

test('sender identity does not imply a provider connection', () => {
  const { saveSenderIdentity, state } = loadPhase2();
  saveSenderIdentity();
  assert.equal(state.connectedEmail, 'me@example.com');
  assert.equal(state.connected, false);
  assert.equal(state.providerConnectionStatus, 'not_connected');
  assert.equal(state.emailProviderConnected, false);
});

test('saving sender identity preserves an existing provider connection state', () => {
  const { saveSenderIdentity, state } = loadPhase2();
  state.providerConnectionStatus = 'connected';
  state.emailProviderConnected = true;
  state.connected = true;
  saveSenderIdentity();
  assert.equal(state.connectedEmail, 'me@example.com');
  assert.equal(state.providerConnectionStatus, 'connected');
  assert.equal(state.emailProviderConnected, true);
  assert.equal(state.connected, true);
});

test('legacy connected state follows the provider connection status', () => {
  const { state } = loadPhase2();
  assert.equal(state.connected, false);
});

test('profile counts distinguish verified and review-needed facts', () => {
  const { api, state } = loadPhase2();
  state.profileFacts = [
    { name: 'Python', category: 'skills', verification_status: 'verified', verified: true },
    { name: 'Docker', category: 'technologies', verification_status: 'source_missing', verified: false },
    { name: 'FastAPI', category: 'technologies', verification_status: 'needs_review', verified: false }
  ];
  assert.equal(JSON.stringify(api.profileCounts()), JSON.stringify({ total: 3, verified: 1, needsReview: 2, sourceMissing: 1 }));
});

test('the UI exposes independent deployed schedules without creating a browser trigger', () => {
  assert.match(phase2Source, /Verified Profile Sync/);
  assert.match(phase2Source, /Opportunity Discovery & Application Preparation/);
  assert.match(phase2Source, /Application & Email Monitoring/);
  assert.match(phase2Source, /Deployed · disabled/);
  assert.match(phase2Source, /recurrence_enabled/);
  assert.doesNotMatch(phase2Source, /schedule\(/);
});

test('Step 2 settings UI preserves empty backend source and country values', () => {
  assert.match(phase2Source, /state\.approvedProfileSources = Array\.isArray\(state\.approvedProfileSources\) \? state\.approvedProfileSources : \[\]/);
  assert.match(phase2Source, /id="phase2-target-countries"/);
  assert.match(phase2Source, /id="phase2-approved-sources"/);
  assert.match(phase2Source, /state\.countries = parseSettingsList\(countries && countries\.value\)/);
  assert.match(phase2Source, /state\.approvedProfileSources = parsedSources/);
});

test('owner profile UI renders only backend-provided approved sources', () => {
  const { profileHTML, state } = loadPhase2();
  const signedOutHtml = profileHTML();
  assert.match(signedOutHtml, /Sign in to view approved profile sources/);
  assert.doesNotMatch(signedOutHtml, /href=/);

  state.approvedProfileSources = [{
    source_type: 'github',
    source_name: 'Example profile',
    source_url: 'https://github.com/example-profile'
  }];
  const ownerHtml = profileHTML();
  assert.match(ownerHtml, /href="https:\/\/github\.com\/example-profile"/);
  assert.match(ownerHtml, /Example profile/);
});

test('owner profile UI provides additive editing while hiding owner-removed facts', () => {
  const { api, state } = loadPhase2();
  state.profileFacts = [
    { id: 'source-1', name: 'Python', category: 'skill', origin: 'source', verification_status: 'verified', verified: true },
    { id: 'owner-1', name: 'Robotics', category: 'skill', origin: 'owner', owner_hidden: false, verification_status: 'unverified', verified: false },
    { id: 'owner-2', name: 'Hidden', category: 'skill', origin: 'owner', owner_hidden: true, verification_status: 'rejected', verified: false },
    { id: 'source-2', name: 'Hidden source', category: 'skill', origin: 'source', owner_hidden: true, verification_status: 'rejected', verified: false }
  ];
  assert.equal(api.profileCounts().total, 2);
  assert.match(phase2Source, /openProfileFactEditor/);
  assert.match(phase2Source, /AIH_manageProfileFact/);
  assert.match(phase2Source, /removeProfileFact/);
  assert.match(phase2Source, /Source-managed/);
  assert.match(phase2Source, /Owner entries are clearly labeled and reviewable/);
});
