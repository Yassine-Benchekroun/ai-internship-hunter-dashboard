import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Execute the production pure functions without loading Deno/npm imports or
// starting an HTTP server. Shared run finalization is replaced at its boundary.
const source = await readFile(new URL('../supabase/functions/application-monitor/index.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/^import .+;\r?\n/gm, ''), { mode: 'strip' });
const monitor = await import(`data:text/javascript;base64,${Buffer.from(`
const finishRun = (admin, run, status, counts, errors) => admin.rpc('test_finish', {run, status, counts, errors});
${executable}`).toString('base64')}`);

const sentAt = '2026-11-01T10:00:00.000Z';
const now = Date.parse('2026-11-15T10:00:00.000Z');
const mailbox = 'owner@example.org';
const application = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', opportunity_id: 'opportunity-1',
  organization: 'Example Robotics', position: 'Computer Vision Internship',
  recipient_email: 'research@example.org', email_subject: 'Application — Computer Vision Internship',
  sent_at: sentAt, last_response_at: null, application_status: 'sent', follow_up_at: null, notes: null,
  ...overrides,
});
const message = (overrides = {}) => ({
  id: 'reply-1', threadId: 'thread-1', internalDate: String(now),
  headers: { from: 'Research Team <research@example.org>', to: mailbox,
    subject: 'Re: Application — Computer Vision Internship' }, ...overrides,
});
const scan = (messages = [], complete = true) => ({ messages, complete });
const plan = (apps, scans) => monitor.actionsFor(apps, scans, mailbox, 7, now);

test('reply requires exact sender, subject or known thread, delivery and a valid later date', () => {
  const app = application();
  assert.equal(monitor.matchesApplication(app, message(), mailbox), true);
  for (const headers of [
    { from: 'someone@example.org', to: mailbox, subject: app.email_subject },
    { from: app.recipient_email, to: mailbox, subject: 'Weekly newsletter' },
    { from: app.recipient_email, to: 'other@example.org', subject: app.email_subject },
  ]) assert.equal(monitor.matchesApplication(app, message({ headers }), mailbox), false);
  assert.equal(monitor.matchesApplication(app, message({ internalDate: String(Date.parse(sentAt) - 1) }), mailbox), false);
  assert.equal(monitor.matchesApplication(app, message({ internalDate: null }), mailbox), false);
  assert.equal(monitor.matchesApplication(application({ provider_thread_id: 'thread-1' }),
    message({ headers: { from: app.recipient_email, to: mailbox, subject: 'Interview invitation' } }), mailbox), true);
});

test('one reply matching two applications marks both for review without state inference', () => {
  const a = application();
  const b = application({ id: '22222222-2222-4222-8222-222222222222' });
  const result = plan([a, b], new Map([[a.id, scan([message()])], [b.id, scan([message()])]]));
  assert.equal(result.ambiguousMessages, 1);
  assert.deepEqual(result.actions.map((x) => x.kind), ['review', 'review']);
  // A controlled single-application scan still compares against both records.
  const controlled = plan([a, b], new Map([[a.id, scan([message()])]]));
  assert.deepEqual(controlled.actions.map((x) => x.kind), ['review']);
});

test('incomplete mailbox searches never produce follow-ups or no-reply transitions', () => {
  const app = application();
  assert.deepEqual(plan([app], new Map([[app.id, scan([], false)]])).actions, []);
  assert.deepEqual(plan([app], new Map([[app.id, scan([message()], false)]])).actions, []);
});

test('follow-up interval comes from config and produces a stable retry key', () => {
  const app = application();
  const scans = new Map([[app.id, scan()]]);
  const first = plan([app], scans).actions[0];
  const second = plan([app], scans).actions[0];
  assert.equal(first.kind, 'follow_up');
  assert.equal(first.followUpAt, '2026-11-08T10:00:00.000Z');
  assert.equal(first.followUpKey, second.followUpKey);
  assert.equal(monitor.actionsFor([app], scans, mailbox, 30, now).actions[0].kind, 'waiting');
  const replied = application({ last_response_at: '2026-11-05T10:00:00Z' });
  assert.deepEqual(plan([replied], scans).actions, []);
});

test('older replies do not regress the latest response and terminal states have no follow-up', () => {
  const app = application({ last_response_at: '2026-11-16T10:00:00Z' });
  assert.deepEqual(plan([app], new Map([[app.id, scan([message()])]])).actions, []);
  for (const status of ['offer', 'rejected', 'closed', 'interview']) {
    const terminal = application({ application_status: status });
    assert.deepEqual(plan([terminal], new Map([[terminal.id, scan()]])).actions, []);
  }
});

test('metadata classification is conservative and ignores negated or generic subjects', () => {
  const app = application();
  const classify = (subject) => monitor.classifyResponse(message({ headers: { subject } }), app);
  assert.equal(classify('Re: Application — Computer Vision Internship'), 'replied');
  assert.equal(classify('Interview invitation'), 'interview');
  assert.equal(classify('Internship offer'), 'offer');
  assert.equal(classify('Application rejected'), 'rejected');
  assert.equal(classify('Position closed'), 'closed');
  assert.equal(classify('No internship offer'), 'replied');
  assert.equal(classify('Potential interview invitation'), 'replied');
  assert.equal(classify('Application update'), 'replied');
});

test('mailbox pagination uses contact/date constraints and fetches metadata only', async () => {
  const calls = [];
  const reader = async (_token, path, params) => {
    calls.push({ path, params });
    if (path === 'messages') return params.has('pageToken') ? { messages: [{ id: 'm2' }] } : { messages: [{ id: 'm1' }], nextPageToken: 'page2' };
    return { id: path.split('/')[1], threadId: 'thread-1', internalDate: String(now), payload: { headers: [] } };
  };
  const result = await monitor.listApplicationMessages('test-credential', application(), reader);
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
  assert.match(calls[0].params.get('q'), /^from:\(research@example\.org\) after:\d+ -in:sent -in:drafts$/);
  assert.equal(calls[2].params.get('pageToken'), 'page2');
  assert.equal(calls.filter((call) => call.path !== 'messages').every((call) => call.params.get('format') === 'metadata'), true);
});

test('truncated pagination is incomplete and malformed identifiers never query Gmail', async () => {
  let calls = 0;
  const repeatedPage = async () => { calls += 1; return { messages: [], nextPageToken: 'same' }; };
  const truncated = await monitor.listApplicationMessages('test-credential', application(), repeatedPage);
  assert.equal(truncated.complete, false);
  assert.equal(calls, 2);
  calls = 0;
  const invalid = await monitor.listApplicationMessages('test-credential', application({ recipient_email: 'x OR in:anywhere' }), repeatedPage);
  assert.equal(invalid.complete, false);
  assert.equal(calls, 0);
});

test('follow-up requests use an immutable event key and never supply an overwrite version', async () => {
  const app = application();
  const action = plan([app], new Map([[app.id, scan()]])).actions[0];
  const payloads = [];
  const admin = { rpc: async (name, args) => { assert.equal(name, 'automation_update_application'); payloads.push(args.p_payload); return { data: { follow_up_draft_id: 'draft-1' } }; } };
  await monitor.applyAction(admin, 'owner-id', action, 'Verified Owner');
  await monitor.applyAction(admin, 'owner-id', action, 'Verified Owner');
  assert.equal(payloads[0].follow_up_key, payloads[1].follow_up_key);
  assert.equal('version' in payloads[0].follow_up_draft, false);
  assert.equal(payloads[0].follow_up_draft.recipient, app.recipient_email);
  assert.match(payloads[0].follow_up_draft.body, /Best regards,\nVerified Owner$/);
  assert.equal('match_score' in payloads[0], false);
  assert.equal('match_classification' in payloads[0], false);
  assert.equal('sent' in payloads[0], false);
});

test('same reply produces the same provider id and honors backend duplicate response', async () => {
  const app = application();
  const action = plan([app], new Map([[app.id, scan([message()])]])).actions[0];
  const events = new Set();
  let transitions = 0;
  const admin = { rpc: async (_name, { p_payload }) => {
    const duplicate = events.has(p_payload.provider_message_id);
    if (!duplicate) { events.add(p_payload.provider_message_id); transitions += 1; }
    return { data: { duplicate, event_id: 'event-1' } };
  } };
  assert.equal((await monitor.applyAction(admin, 'owner-id', action, 'Verified Owner')).duplicate, false);
  assert.equal((await monitor.applyAction(admin, 'owner-id', action, 'Verified Owner')).duplicate, true);
  assert.equal(events.size, 1);
  assert.equal(transitions, 1);
});

test('revoked mailbox connection blocks before any application or mailbox inspection', async () => {
  const calls = [];
  const admin = { rpc: async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'automation_read_settings') return { data: { provider_connection_status: 'revoked' } };
    if (name === 'automation_read_schedule_config') return { data: { follow_up_days: 7 } };
    if (name === 'provider_oauth_get_connection') return { data: null };
    return { data: {} };
  }, from: () => { throw new Error('must not read applications'); } };
  const response = await monitor.runMonitor(admin, 'owner-id', {}, { run_id: 'run-1' });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.status, 'blocked');
  assert.deepEqual(body.errors, ['provider_not_connected']);
  assert.equal(calls.at(-1).name, 'test_finish');
  assert.equal(calls.at(-1).payload.status, 'blocked');
});

test('only readonly provider scopes are accepted', () => {
  const read = 'https://www.googleapis.com/auth/gmail.readonly';
  assert.equal(monitor.scopesAllowReadOnly([read]), true);
  assert.equal(monitor.scopesAllowReadOnly([]), false);
  assert.equal(monitor.scopesAllowReadOnly([read, 'https://www.googleapis.com/auth/gmail.send']), false);
});
