import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const index = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8');
const phase2 = await readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8');
const session = await readFile(new URL('../dist/step3-session.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('Step 3 starts empty and disables the shared unauthenticated state path', () => {
  assert.match(index, /function loadState\(\)\{return defaultState\(\)\}/);
  assert.doesNotMatch(index, /fetch\('\/api\/state'/);
  assert.doesNotMatch(index, /localJsonHost/);
  assert.match(index, /step3-session\.js/);
  assert.doesNotMatch(server, /url\.pathname === '\/api\/state'/);
  assert.match(server, /owner-scoped-supabase/);
});

test('session transitions clear private state and invalidate stale loaders', () => {
  assert.match(session, /SIGNED_OUT/);
  assert.match(session, /account-switch/);
  assert.match(session, /AIH_invalidateCloudLoads/);
  assert.match(session, /AIH_invalidatePrivateLoads/);
  assert.match(index, /var cloudLoadToken = 0/);
  assert.match(bridge, /var bridgeLoadToken = 0/);
  assert.match(bridge, /if \(loadToken !== bridgeLoadToken\) return/);
});

test('sender identity cannot imply Gmail/provider authorization', () => {
  assert.match(phase2, /state\.providerConnectionStatus = 'not_connected'/);
  assert.match(bridge, /provider_connection_status: 'not_connected'/);
  assert.match(phase2, /Saved address used in drafts\. It does not authorize Gmail/);
  assert.match(index, /sender identity used in application drafts/);
});

test('account switching drops the previous user before rendering the next workspace', () => {
  const events = [];
  const context = {
    console,
    setTimeout: (fn) => fn(),
    localStorage: { removeItem() {} },
    document: { querySelector() { return null; } },
    defaultState: () => ({ opportunities: [], applications: [], emailDrafts: {} }),
    state: { opportunities: [], applications: [], emailDrafts: {} },
    render() { events.push(context.state); },
    closeModal() {}
  };
  context.window = { AIH_SUPABASE_CLIENT: null };
  vm.createContext(context);
  vm.runInContext(session, context, { filename: 'step3-session.js' });

  context.window.AIH_privateSessionEvent('SIGNED_IN', { user: { id: 'user-a', email: 'a@example.com' } });
  context.state.opportunities = [{ id: 'a-private-record' }];
  context.state.emailDrafts = { draftA: 'private' };
  context.window.AIH_privateSessionEvent('SIGNED_IN', { user: { id: 'user-b', email: 'b@example.com' } });

  assert.equal(JSON.stringify(context.state.opportunities), '[]');
  assert.equal(JSON.stringify(context.state.emailDrafts), '{}');
  assert.equal(context.window.__AIH_AUTHENTICATED_SESSION.id, 'user-b');
  assert.ok(events.length >= 2, 'the transition renders the cleared shell');

  context.state.applications = [{ id: 'b-private-record' }];
  context.window.AIH_privateSessionEvent('SIGNED_OUT', null);
  assert.equal(JSON.stringify(context.state.applications), '[]');
  assert.equal(context.window.__AIH_AUTHENTICATED_SESSION, null);
});

test('published scripts compile after the Step 3 additions', () => {
  assert.doesNotThrow(() => new Function(session));
  assert.doesNotThrow(() => new Function(phase2));
  assert.doesNotThrow(() => new Function(bridge));
});
