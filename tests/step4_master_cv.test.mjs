import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [migration, sqlTest, docs] = await Promise.all([
  readFile(new URL('../supabase/migrations/20261103000000_step4_master_cv.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/step4_master_cv.sql', import.meta.url), 'utf8'),
  readFile(new URL('../docs/master-cv-contract.md', import.meta.url), 'utf8')
]);

test('Master CV schema has owned revisions and one current row per user', () => {
  assert.match(migration, /create table if not exists public\.master_cv_versions/);
  assert.match(migration, /user_id uuid not null references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /revision integer not null check \(revision > 0\)/);
  assert.match(migration, /content text/);
  assert.match(migration, /source_reference text/);
  assert.match(migration, /created_at timestamptz not null default now\(\)/);
  assert.match(migration, /updated_at timestamptz not null default now\(\)/);
  assert.match(migration, /master_cv_versions_user_revision_uidx/);
  assert.match(migration, /master_cv_versions_one_current_uidx/);
  assert.match(migration, /where is_current = true/);
});

test('Master CV has owner privacy and a write-only-through validated RPC', () => {
  assert.match(migration, /alter table public\.master_cv_versions enable row level security/);
  assert.match(migration, /revoke all on table public\.master_cv_versions from public, anon, authenticated/);
  assert.match(migration, /grant select on table public\.master_cv_versions to authenticated/);
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(migration, /create schema if not exists private/);
  assert.match(migration, /create or replace function private\.save_master_cv_impl\(p_payload jsonb\)/);
  assert.match(migration, /security definer\nset search_path = ''/);
  assert.match(migration, /create or replace function public\.save_master_cv\(p_payload jsonb\)/);
  assert.match(migration, /language sql\nsecurity invoker\nset search_path = ''/);
  assert.match(migration, /user_id is not accepted/);
  assert.match(migration, /revision and is_current are server-controlled/);
  assert.match(migration, /content or source_reference is required/);
  assert.match(migration, /grant execute on function public\.save_master_cv\(jsonb\) to authenticated/);
  assert.match(migration, /revoke all on function public\.save_master_cv\(jsonb\) from public, anon, authenticated/);
});

test('Master CV save path never fabricates content or writes targeted CV artifacts', () => {
  assert.match(migration, /no default or generated CV text is/);
  assert.doesNotMatch(migration, /(?:insert|update|delete)\s+into\s+public\.cv_versions/i);
  assert.match(migration, /revisions are deliberately stored separately/);
  assert.match(docs, /cv_versions/);
  assert.match(docs, /never invents CV text or claims/);
  assert.match(docs, /has no `opportunity_id`/);
});

test('owner privacy SQL test covers history, spoofing, and signed-in non-owner reads', () => {
  assert.match(sqlTest, /revision history\/current invariant failed/);
  assert.match(sqlTest, /client-controlled owner was accepted/);
  assert.match(sqlTest, /non-owner can read Master CV rows/);
  assert.match(sqlTest, /Master CV save path wrote targeted cv_versions/);
  assert.match(sqlTest, /rollback;/);
});
