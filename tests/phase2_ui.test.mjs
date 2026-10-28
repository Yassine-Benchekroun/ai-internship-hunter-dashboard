import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const phase2Source = fs.readFileSync(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8');

function loadPhase2() {
  const state = {
    threshold: 70,
    opportunities: [],
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
    getElementById: (id) => id === 'phase2-sender-email' ? { value: 'me@example.com' } : noOpNode(),
    querySelector: noOpNode,
    querySelectorAll: () => []
  };
  const context = {
    console,
    document,
    innerWidth: 1200,
    state,
    window: { __AIH_OWNER_SESSION: null },
    pageIntro: () => '',
    icon: () => '',
    esc: (value) => String(value ?? ''),
    fmtDate: (value) => String(value ?? ''),
    overviewHTML: () => '<div class="dashboard-grid"></div>',
    profileHTML: () => '',
    settingsHTML: () => '',
    statusPill: () => '',
    setThreshold: () => {},
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
  return { api: context.window.AIH_phase2, saveSenderIdentity: context.window.saveSenderIdentity, state };
}

test('score classification uses the threshold boundary', () => {
  const { api } = loadPhase2();
  for (const [score, expected] of [[74, 'top'], [70, 'top'], [68, 'lower'], [62, 'lower'], [0, 'lower']]) {
    const opportunity = { score, activeSections: ['new'] };
    api.classify(opportunity);
    assert.equal(opportunity.classification, expected);
    assert.deepEqual(opportunity.activeSections, [expected]);
  }
});

test('application status does not override match classification', () => {
  const { api } = loadPhase2();
  const opportunity = { score: 68, status: 'Already Sent', activeSections: ['new'] };
  api.classify(opportunity);
  assert.equal(opportunity.classification, 'lower');
  assert.equal(opportunity.status, 'Already Sent');
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

test('the UI includes all future automation placeholders and no schedule trigger', () => {
  assert.match(phase2Source, /Verified Profile Sync/);
  assert.match(phase2Source, /Opportunity Discovery & Application Preparation/);
  assert.match(phase2Source, /Application & Email Monitoring/);
  assert.match(phase2Source, /Not scheduled/);
  assert.doesNotMatch(phase2Source, /schedule\(/);
});
