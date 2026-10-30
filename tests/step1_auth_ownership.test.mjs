import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../dist/opportunity-records-bridge.js', import.meta.url), 'utf8');
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261029220000_step1_auth_ownership_foundation.sql', import.meta.url), 'utf8');

test('authentication uses Supabase magic links and permits new accounts', () => {
  assert.match(index, /auth\.signInWithOtp\(/);
  assert.match(index, /shouldCreateUser:\s*true/);
  assert.match(index, /emailRedirectTo:\s*window\.location\.href/);
  assert.match(index, /auth\.getSession\(\)/);
  assert.match(index, /auth\.onAuthStateChange\(/);
  assert.match(index, /auth\.signOut\(\)/);
});

test('frontend ownership is based on authenticated user identity, not an owner UUID or email string', () => {
  assert.match(index, /function authenticatedSession\(user\)/);
  assert.match(index, /window\.AIH_isAuthenticatedSession/);
  assert.doesNotMatch(index, /AIH_OWNER_USER_ID|AIH_isOwnerSession|__AIH_OWNER_SESSION/);
  assert.doesNotMatch(index, /\.eq\(['"]email['"]/i);
  assert.match(index, /user_id:\s*cloudUser\.id/);
});

test('signed-out and first-account states are empty and stale local cache is cleared', () => {
  assert.match(index, /opportunities:\[\],applications:\[\]/);
  assert.match(index, /localStorage\.removeItem\(STORAGE_KEY\)/);
  assert.match(index, /state = normalizeCloudState\(privateEmptyState\(\)\)/);
  assert.match(index, /loadSignedOutState\(\);/);
  assert.match(index, /failed private request must never reveal a previous user's cache/);
});

test('normalized bridge uses the shared authenticated client and rejects unauthenticated loads', () => {
  assert.match(bridge, /window\.AIH_SUPABASE_CLIENT/);
  assert.match(bridge, /window\.AIH_isAuthenticatedSession/);
  assert.match(bridge, /window\.AIH_setSignedOutState/);
  assert.doesNotMatch(bridge, /AIH_isOwnerSession|__AIH_OWNER_SESSION/);
});

test('Step 1 migration and bootstrap schema use auth.uid ownership without hard-coded account IDs', () => {
  for (const source of [migration, schema]) {
    assert.match(source, /auth\.uid\(\)/);
    assert.doesNotMatch(source, /3a419f7d-36e0-43d5-aa39-156b3177b84a/);
  }
  assert.match(migration, /alter column approved_profile_sources set default '\[\]'::jsonb/);
  assert.match(migration, /with check \(\(select auth\.uid\(\)\) = user_id\)/);
});

