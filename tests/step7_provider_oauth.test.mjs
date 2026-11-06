import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [migration, endpoint, config, sqlTest, docs, bridge, ui, index, publicConfig] = await Promise.all([
  readFile(new URL('../supabase/migrations/20261103233000_step7_provider_oauth.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/provider-oauth/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/step7_provider_oauth.sql', import.meta.url), 'utf8'),
  readFile(new URL('../docs/provider-oauth-contract.md', import.meta.url), 'utf8'),
  readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/phase2-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../supabase-config.js', import.meta.url), 'utf8')
]).then((files) => files.map((file) => file.replace(/\r\n/g, '\n')));

test('provider OAuth keeps state and tokens in private, backend-only storage', () => {
  assert.match(migration, /create table if not exists private\.provider_oauth_states/);
  assert.match(migration, /create table if not exists private\.provider_connections/);
  assert.match(migration, /alter table private\.provider_oauth_states enable row level security/);
  assert.match(migration, /alter table private\.provider_connections enable row level security/);
  assert.match(migration, /revoke all on table private\.provider_oauth_states, private\.provider_connections from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table private\.provider_oauth_states, private\.provider_connections to service_role/);
  assert.match(migration, /delete from private\.provider_oauth_states[\s\S]*returning provider_oauth_states\.user_id/);
  assert.match(migration, /grant execute on function public\.provider_oauth_get_connection\(uuid\)[\s\S]*to service_role/);
  assert.match(sqlTest, /Browser roles must not read provider tokens/);
});

test('OAuth endpoint validates sessions, binds callback state, and never sends mail', () => {
  assert.match(config, /\[functions\.provider-oauth\]/);
  assert.match(config, /\[functions\.provider-oauth\][\s\S]*?verify_jwt\s*=\s*false/);
  assert.match(endpoint, /auth\.getUser\(token\)/);
  assert.match(endpoint, /provider_oauth_begin/);
  assert.match(endpoint, /provider_oauth_consume/);
  assert.match(endpoint, /provider_oauth_store_connection/);
  assert.match(endpoint, /provider_oauth_revoke_connection/);
  assert.match(endpoint, /provider_oauth_mark_error/);
  assert.match(endpoint, /SHA-256/);
  assert.match(endpoint, /access_type.*offline/);
  assert.match(endpoint, /gmail\.readonly/);
  assert.match(endpoint, /oauth2\.googleapis\.com\/revoke/);
  assert.doesNotMatch(endpoint, /gmail\.(send|compose|modify)|mail\.google\.com/);
  assert.doesNotMatch(endpoint, /cron\.schedule|pg_cron|send_mail|send_email/i);
});

test('dashboard controls provider actions without coupling sender identity or exposing secrets', () => {
  assert.match(bridge, /functions\.invoke\('provider-oauth'/);
  assert.match(bridge, /providerConnectionStatus = providerStatus\(result\.data\.provider_connection_status\)/);
  assert.doesNotMatch(bridge.match(/function settingsRow\(\)[\s\S]*?\n  \}/)?.[0] || '', /provider_connection_status/);
  assert.match(bridge, /from\('user_settings'\)\.update\(settingsRow\(\)\)/);
  assert.match(ui, /Connect Gmail/);
  assert.match(ui, /Disconnect & revoke/);
  assert.match(ui, /Automatic sending remains off/);
  assert.match(ui, /Sender identity and drafts remain separate/);
  assert.doesNotMatch([ui, bridge, index, publicConfig].join('\n'), /google_client_secret|client_secret|refresh_token|access_token|service_role_key|supabase_secret_key/i);
  assert.match(docs, /GOOGLE_CLIENT_SECRET/);
  assert.match(docs, /gmail\.readonly/);
  assert.match(docs, /No provider token/);
});
