# AI Internship Hunter — Pre-Schedule Technical Progress

## Progress rule

When the CURRENT step is genuinely complete:

1. mark the finished step `COMPLETE`;
2. record its results/tests/commit;
3. set `Current step` to the next step;
4. set the next step to `NOT STARTED`;
5. keep all later steps blocked.

If a required test fails:

- keep the same current step;
- do not mark it complete;
- record the blocker.

Do NOT create recurring schedules during this project.

---

# Overall status

**NOT READY FOR SCHEDULES**

Current step:

**Step 7 — Implement Gmail/provider OAuth**

---

# Step tracker

| Step | Status |
|---|---|
| 1. Reconcile GitHub ↔ Supabase migrations | COMPLETE |
| 2. Fix authoritative backend settings | COMPLETE |
| 3. Remove hardcoded real user/source data safely | COMPLETE |
| 4. Add Master CV backend support | COMPLETE |
| 5. Add Profile Sync endpoint + dry run | COMPLETE |
| 6. Verify Opportunity ingestion + dry run | COMPLETE |
| 7. Implement Gmail/provider OAuth | BLOCKED — public dashboard deployed; real account authorization tests pending |
| 8. Add Application Monitor endpoint + dry run | BLOCKED BY STEP 7 |
| 9. Add run-health visibility + Supabase cleanup | BLOCKED BY STEP 8 |
| 10. Final pre-schedule audit | BLOCKED BY STEP 9 |

---

# Baseline audit

## GitHub findings

- Current `main` was restored to pre-Step-1 frontend behavior.
- Latest inspected deployment workflow passed.
- Normalized backend bridge exists.
- `ingest-opportunities` source exists.
- Future automation placeholders exist.
- Master CV is missing.
- Gmail OAuth is missing.
- Public build and repository fallback/fixture sources contain no real user-specific source/profile values; approved values remain backend settings only.

## Live Supabase findings

- Project: ACTIVE_HEALTHY.
- Auth users: 1.
- `dashboard_state`: 1 row.
- `user_settings`: 1 row.
- `opportunity_records`: 0.
- `application_records`: 0.
- `profile_facts`: 0.
- `profile_fact_evidence`: 0.
- `profile_sync_runs`: 0.
- `cv_versions`: 0.
- `email_drafts`: 0.
- `opportunity_ingestion_events`: 0.
- Important application tables have RLS enabled.
- Live database still includes Step 1 + Step 2 privacy migrations.
- Approved profile sources are configured from the explicitly authorized repository GitHub and portfolio values.
- Target countries are configured from the explicitly authorized repository country list.
- Sender identity exists.
- Provider connection is not connected.
- One live Edge Function exists: `ingest-opportunities`.
- Profile Sync RPC exists but no Edge Function exists for it.
- Application update RPC exists but no monitor Edge Function exists.
- No Storage bucket is currently used.
- Security advisor: leaked-password protection disabled.
- Performance advisor: duplicate `profile_sync_runs` SELECT policy.
- Several indexes are unused; not considered a blocker yet.

---

# Step 1 — Reconcile GitHub ↔ Supabase migrations

Status: **COMPLETE**

Checklist:

- [x] Inspect live migrations.
- [x] Inspect repository migrations.
- [x] Restore/reconstruct canonical Step 1 migration source.
- [x] Restore/reconstruct canonical Step 2 migration source.
- [x] Verify live schema/policies match.
- [x] Update migration ledger/docs.
- [x] Preserve live useful RLS.
- [x] Run schema/RLS verification.
- [x] Commit/push feature branch.

Results:

- Migration drift: GitHub `main` at `a98b1c4e4b0c1f1925b9f367ec7a7777f5cd093f` omitted the two migration source files, while Supabase production records `20261029220721 step1_auth_ownership_foundation` and `20261030181754 step_2_privacy_hardening`. Restored the reviewed SQL under the repository source filenames and mapped both managed production versions in the ledger.
- RLS verification: PASS. All ten protected public tables exist with RLS enabled; all 28 canonical Step 2 policies are present; no legacy owner-gate policies remain; the `approved_profile_sources` default is `[]` JSONB; `anon` has no private-table privileges; authenticated grants match the Step 2 contract. The redundant ownership-equivalent `Users can read profile sync runs` policy was preserved for the later cleanup step.
- Tests: PASS — live Supabase migration list, advisors, Edge Function inventory, row-count baseline, and the read-only schema/RLS/grant verification query were run. Canonical restored migration blob hashes match the reviewed GitHub parent sources (`ac3c7e5109fa80ea79159b28057e15698bc823f8` and `38068792ce0c7fe417b11d6ea0c77cf8ee8c8396`).
- Commit: `c03340b` — Reconcile GitHub and Supabase migration state.
- Blockers: None for Step 1. Later-step items remain unchanged: the duplicate `profile_sync_runs` policy and leaked-password warning are deferred to Step 9; no production data or live migration was changed.

When complete:

- Step 1 = COMPLETE
- Current step = Step 2
- Step 2 = NOT STARTED

---

# Step 2 — Fix authoritative backend settings

Status: **COMPLETE**

Checklist:

- [x] Verify threshold.
- [x] Verify daily target.
- [x] Verify domain relevance.
- [x] Verify opportunity types.
- [x] Configure approved profile sources using approved values.
- [x] Configure target countries using approved values.
- [x] Load/save settings from backend.
- [x] Preserve sender/provider separation.
- [x] Test persistence/refresh.
- [x] Commit.
- [x] Push feature branch.

Results:

- Settings: `user_settings` is the authoritative backend contract for match threshold `70`, daily opportunity target `30`, domain relevance enabled, opportunity types `internship` and `research`, approved profile sources, sender identity, and provider connection status.
- Sources: Live `approved_profile_sources` now contains the explicitly authorized GitHub and portfolio values from the repository.
- Countries: Live `target_countries` now contains the explicitly authorized repository country list.
- Tests: PASS — Node syntax checks; all 23 repository/UI/backend tests; local `/api/settings` load-save-refresh; live Supabase read-before/write/read-back verification. Sender identity remains separate from provider status `not_connected`.
- Commit: `68da3b7` — Complete Step 2 backend settings with the unrelated watcher commit removed. The feature branch is ready for a force-with-lease update; no merge to main or deployment performed.
- Blockers: None for Step 2. The watcher commit was removed without changing Step 1 or Step 2 files; Step 3 remains intentionally not started.

When complete:

- Step 2 = COMPLETE
- Current step = Step 3
- Step 3 = NOT STARTED

---

# Step 3 — Remove hardcoded real user/source data safely

Status: **COMPLETE**

Checklist:

- [x] Scan public source/build.
- [x] Remove real GitHub/portfolio fallback from public production logic.
- [x] Load real source registry from backend.
- [x] Keep demo data generic/fake if retained.
- [x] Verify signed-out/non-owner cannot read real backend data.
- [x] Verify owner dashboard still works.
- [x] Re-run leakage scan.
- [x] Commit/push.

Results:

- Leakage scan: PASS — the exact authorized GitHub/portfolio URL and owner-name markers are absent from `dist/`, SQL fallback defaults, automation docs, and SQL fixtures. Public source/evidence links now render only from the authenticated backend settings state; empty source state remains explicit.
- UI regression: PASS — signed-out profile rendering shows no source link; the owner fixture renders a backend-provided source; JavaScript syntax checks pass; all 28 repository tests pass.
- Privacy check: PASS — the dashboard and normalized-data bridge both require the owner session before loading private data. Live read-only verification confirms `user_settings` RLS is enabled, `anon` has zero grants on the protected tables, the owner settings row remains present with 2 approved sources and 8 countries, and no live data was changed.
- Commit: `aba9da0` — Complete Step 3 source privacy hardening; no deployment or merge performed.
- Blockers: None for Step 3. Step 4 remains not started by request.

When complete:

- Step 3 = COMPLETE
- Current step = Step 4
- Step 4 = NOT STARTED

---

# Step 4 — Add Master CV backend support

Status: **COMPLETE**

Checklist:

- [x] Design minimal Master CV model.
- [x] Add ownership/RLS.
- [x] Add version/revision support.
- [x] Add safe import/save path.
- [x] Keep targeted CV versions separate.
- [x] Do not fabricate content.
- [x] Test owner privacy.
- [x] Commit/push.

Results:

- Schema: PASS — added `public.master_cv_versions` with user ownership, server-controlled revisions, one current revision per user, supplied content/source reference, timestamps, size/material checks, and history indexes. Targeted `public.cv_versions` remains unchanged and opportunity-linked.
- RLS: PASS — authenticated reads are restricted to `auth.uid() = user_id`; anonymous access and direct authenticated table writes are revoked. The privileged implementation is isolated in `private`, while the public RPC is an invoker wrapper.
- Import/save: PASS — `public.save_master_cv(jsonb)` accepts only caller-supplied content or source references, rejects client-controlled owner/revision/current fields, validates types and bounds, serializes revision allocation, and never fabricates CV content.
- Tests: PASS — all 32 repository Node tests and the server syntax check pass, including the Step 4 contract assertions after making the Step 4 test line-ending portable. The owner-privacy SQL test is present and rollback-only; live table/RLS/RPC catalog checks and owner/non-owner readback passed after deployment.
- PDF source: PASS — the supplied Master CV is a readable 3-page PDF with extractable text and was imported as owner revision 1 through `public.save_master_cv(jsonb)` with 7,852 extracted characters. It remains untracked/private and was not uploaded or committed to the public repository.
- Commit: `c09b462` — Add Master CV backend support; `3679d93` — Finalize Step 4 Master CV verification; live managed migration `20261103223240`.
- Blockers: None for Step 4. Supabase security advisor still reports leaked-password protection disabled, and the performance advisor still reports the pre-existing duplicate `profile_sync_runs` SELECT policy and unused indexes; these remain deferred to Step 9. No schedule or automatic sending was created.

When complete:

- Step 4 = COMPLETE
- Current step = Step 5
- Step 5 = NOT STARTED

---

# Step 5 — Add Profile Sync endpoint + dry run

Status: **COMPLETE**

Checklist:

- [x] Create secure `sync-profile` endpoint.
- [x] Require authorization with platform JWT verification and `auth.getUser`.
- [x] Scope to the signed-in account.
- [x] Validate approved sources through backend settings and `is_approved_profile_source`.
- [x] Keep privileged credentials server-side.
- [x] Call existing sync RPC.
- [x] Run controlled GitHub/portfolio sync.
- [x] Verify profile facts/evidence.
- [x] Verify deduplication/source-missing behavior.
- [x] Verify sync run log.
- [x] Verify dashboard rendering.
- [x] Commit/push.

Results:

- Endpoint: Deployed `sync-profile` as live Edge Function version 1 with `verify_jwt = true`; unauthenticated HTTP smoke test returned `401 UNAUTHORIZED_NO_AUTH_HEADER`; retrieved live source matches the local source exactly. The endpoint derives account scope from the verified caller, loads backend-approved GitHub/portfolio sources, keeps privileged credentials server-side, extracts bounded evidence-backed facts, preserves source-missing history, and calls the service-role-only `automation_sync_profile` RPC.
- Facts/evidence: Controlled approved-source sync recorded 19 verified facts (8 projects and 11 technologies) with 20 evidence rows and 0 review-needed records. The live sources were the configured GitHub profile and portfolio; no content was fabricated and no Master CV content was read or written.
- Sync log: First live run completed with 19 inserted, 0 updated, 0 duplicates, and 0 errors. Repeating the same payload completed with 0 inserted, 0 updated, 19 duplicates ignored, and 0 errors. A rollback-only `source_missing` assertion passed and left 0 temporary test facts.
- Tests: PASS — `node --check supabase/functions/sync-profile/index.ts`; all 36 repository Node tests; live pre/post database catalog and row-count verification; deployed function parity; JWT boundary smoke test; fact/evidence counts; duplicate behavior; rollback-only source-missing behavior; no recent email artifacts. Security/performance advisor findings remain the deferred Step 9 findings.
- Commit: `6506cba` — Complete Step 5 profile sync endpoint and dry run.
- Blockers: None for Step 5. Step 6 is now the current step and remains not started. No schedule, automatic email sending, provider connection, or later-step work was created.

When complete:

- Step 5 = COMPLETE
- Current step = Step 6
- Step 6 = NOT STARTED

---

# Step 6 — Verify Opportunity ingestion + dry run

Status: **COMPLETE**

Checklist:

- [x] Compare repository/live Edge Function.
- [x] Verify JWT protection.
- [x] Verify private secret configuration without revealing values.
- [x] Ingest one controlled test opportunity.
- [x] Verify normalized row.
- [x] Verify score/classification.
- [x] Verify history.
- [x] Repeat same opportunity.
- [x] Verify deduplication.
- [x] Verify ingestion event.
- [x] Verify CV/email artifacts if supplied.
- [x] Commit only if changes required.

Results:

- Function parity: PASS — local `supabase/functions/ingest-opportunities/index.ts` matches the live `ingest-opportunities` source after line-ending normalization; live version 5 has `verify_jwt = true`. The source keeps the privileged key and owner scope server-side and calls only `automation_ingest_opportunities`.
- JWT and private configuration: PASS — unauthenticated browser request was rejected at the platform boundary with `UNAUTHORIZED_NO_AUTH_HEADER`; the read-only Functions Secrets view showed configured custom secret names `INGEST_API_KEY` and `INGEST_OWNER_USER_ID`, while the reserved `SUPABASE_SECRET_KEYS` name is available. Secret values and digests were not copied or exposed.
- Ingestion: PASS — live service-role ingestion contract dry run inserted one synthetic controlled opportunity with a normalized source URL, score `68`, and classification `lower` against the live threshold `70`. The record had `application_status = not_sent` and no CV/email artifacts.
- Deduplication: PASS — repeating the same organization/position/source key reused the single row, returned `duplicate_count = 1`, preserved `first_discovered_at`, and updated the score to `74` with classification `top`.
- History: PASS — the first call recorded an `inserted`/`completed` event and the repeat recorded a `duplicate_updated` event; two events existed during verification.
- Cleanup: PASS — only the exact synthetic test row and its two test events were removed after verification; no applications or artifacts were deleted. Post-cleanup live counts returned to the baseline: `opportunity_records = 0`, `opportunity_ingestion_events = 0`, `cv_versions = 0`, and `email_drafts = 0`.
- Tests: PASS — Node syntax checks for the server, published bridges, and Edge Function; all 36 repository Node tests; live project status, migrations, RLS/grant catalog checks, function parity, JWT boundary, secret-name presence, ingestion, deduplication, history, artifact, and post-cleanup verification. No schedule or automatic sending was created.
- Commit: `67cef08` — Complete Step 6 opportunity ingestion verification.
- Blockers: None for Step 6. Step 7 is now current and remains intentionally not started.

When complete:

- Step 6 = COMPLETE
- Current step = Step 7
- Step 7 = NOT STARTED

---

# Step 7 — Implement Gmail/provider OAuth

Status: **BLOCKED — Gmail connect verified; refresh and disconnect/revoke tests pending**

Checklist:

- [x] Implement secure OAuth/provider flow.
- [x] Keep provider secrets/tokens backend-only.
- [x] Keep dashboard Auth separate.
- [x] Keep sender identity separate.
- [x] Support connection states.
- [x] Keep automatic sending OFF.
- [x] Apply the Step 7 migration to live Supabase.
- [x] Deploy the `provider-oauth` Edge Function.
- [x] Test connect.
- [ ] Test disconnect/revoke.
- [ ] Test refresh/session behavior.
- [x] Verify no token leakage.
- [x] Commit/push local implementation.

Results:

- Provider: Local Step 7 implementation uses Gmail read-only scope `https://www.googleapis.com/auth/gmail.readonly`; it does not request `gmail.send`, `gmail.compose`, `gmail.modify`, or `mail.google.com`. Sender identity remains separate from provider authorization, and automatic sending remains disabled.
- OAuth: Added `provider-oauth` with manual Supabase JWT validation for authenticated actions, one-time SHA-256 state binding for the Google callback, offline access, backend refresh, disconnect/revoke, and safe status-only responses. Added private OAuth-state/provider-token tables and service-role-only RPC wrappers; browser roles cannot read or execute token paths.
- Token privacy: Google client values and token material are read only from backend Edge Function environment variables. No token or secret values are in public assets, the public settings row, or responses. The private `master_cv.pdf` remains untracked and was not staged or modified.
- Tests: PASS — `node --check` for server, bridge, UI, and `provider-oauth`; all 39 repository Node tests; `git diff --check`; public-asset token/secret scan with no matches. Live read-only pre/post verification confirmed the production project remains unchanged: no Step 7 migration, private provider tables/RPCs, or Edge Function was applied/deployed; existing row counts, functions, and advisor findings remain unchanged.
- Continuation verification: PASS — on 2026-11-06, all 39 repository tests, server/bridge/UI/Edge Function syntax checks, `git diff --check`, and the targeted public-asset secret scan passed. The repository has no `package.json`, so `npm test` is not an available runner; the direct Node test runner is the passing test command. Before production changes, the project was `ACTIVE_HEALTHY` with no Step 7 migration, provider tables/RPCs, or OAuth function; the failed first migration attempt rolled back with no partial state. The minimal checked-in SQL correction fixed the `provider_oauth_store_connection_impl` permission signature. The authorized migration then applied successfully as managed version `20261106115834` (`step7_provider_oauth`), with both private tables RLS-enabled, six public RPC wrappers, and zero provider token/state rows. `provider-oauth` deployed as live version 1 with `verify_jwt = false`; the deployed source matches the checked-in entrypoint exactly. Boundary smoke tests returned `400` for a callback without state, `200` for CORS preflight, and `401` for an unauthenticated action. The rollback-only live RLS/privilege assertions passed. Opportunity/application/draft counts remain zero; no automatic sending or schedule was created.
- Dashboard deployment: PASS — after the authorized merge commit `cde47ec` reached `main`, GitHub Pages workflow run `#26` passed verification and deployed successfully. The live dashboard is available at `https://yassine-benchekroun.github.io/ai-internship-hunter-dashboard/`. At deployment time, the UI correctly showed `Not connected` before the real owner account completed Gmail authorization.
- Live connect verification: PASS — the authorized Gmail callback returned `{"ok":true,"provider":"gmail","status":"connected"}`. Live read-only verification initially found the private provider row `connected` while the public/dashboard status had been reset to `not_connected` by the browser settings sync. The status was repaired from the existing private connection, and the post-change live query now shows both private and public status `connected`. No token values were read or exposed.
- Dashboard sync fix: PASS locally — ordinary browser settings saves no longer include or overwrite `provider_connection_status`; existing settings are updated in place and new rows are inserted with the database default. Added a regression assertion to the Step 7 test.
- Deployment verification: PASS — Pages workflow run `42255133822` completed successfully for `f41fcf5`; the live bridge contains the editable-settings-only update path. An already-open pre-fix browser tab rewrote the public status once after the first repair, so the live status was repaired again and now verifies `private_status = connected` and `public_status = connected`. The user must close old dashboard tabs and hard-refresh before lifecycle testing.
- Commit: `cb43c0f` — Implement backend-only Gmail provider OAuth. This preserves the current Step 7 blocker; it does not claim live provider verification or production deployment.
- Fix commit: `ced1b4a` — Prevent ordinary dashboard settings saves from overwriting the connected provider status.
- Blockers: The permanent dashboard sync fix still requires Pages deployment and live browser verification. Refresh/session and disconnect/revoke remain untested through the real signed-in dashboard session. No automatic sending or schedule was created. Step 7 must remain blocked until the full account-authorization lifecycle is explicitly tested.

When complete:

- Step 7 = COMPLETE
- Current step = Step 8
- Step 8 = NOT STARTED

---

# Step 8 — Add Application Monitor endpoint + dry run

Status: **BLOCKED BY STEP 7**

Checklist:

- [ ] Create secure monitor endpoint.
- [ ] Scope to intended owner.
- [ ] Use mailbox authorization safely.
- [ ] Call existing application update RPC.
- [ ] Prevent duplicate processing.
- [ ] Create follow-up drafts only.
- [ ] Never auto-send.
- [ ] Log run result.
- [ ] Run controlled application test.
- [ ] Verify status/history/follow-up.
- [ ] Commit/push.

Results:

- Endpoint:
- Status update:
- Follow-up draft:
- Logging:
- Tests:
- Commit:
- Blockers:

When complete:

- Step 8 = COMPLETE
- Current step = Step 9
- Step 9 = NOT STARTED

---

# Step 9 — Run health + Supabase cleanup

Status: **BLOCKED BY STEP 8**

Checklist:

- [ ] Add minimal run-health model/UI.
- [ ] Show safe last-run information.
- [ ] Do not expose secrets.
- [ ] Remove redundant profile_sync_runs SELECT policy.
- [ ] Re-run security advisor.
- [ ] Re-run performance advisor.
- [ ] Document passwordless/password security decision.
- [ ] Do not remove indexes only because they are unused now.
- [ ] Commit/push.

Results:

- Run health:
- RLS cleanup:
- Advisors:
- Tests:
- Commit:
- Blockers:

When complete:

- Step 9 = COMPLETE
- Current step = Step 10
- Step 10 = NOT STARTED

---

# Step 10 — Final pre-schedule audit

Status: **BLOCKED BY STEP 9**

Checklist:

- [ ] Migration history consistent.
- [ ] Production data preserved.
- [ ] Backend settings correct.
- [ ] Approved sources configured.
- [ ] Target countries configured.
- [ ] No real user-specific data hardcoded in public build.
- [ ] Master CV backend ready.
- [ ] Profile Sync dry run passed.
- [ ] Opportunity ingestion dry run passed.
- [ ] Gmail/provider connection works.
- [ ] Application Monitor dry run passed.
- [ ] Auto-send remains OFF.
- [ ] Run-health visibility works.
- [ ] RLS verified.
- [ ] Edge Functions verified.
- [ ] No privileged credentials exposed.
- [ ] Tests/build pass.
- [ ] Feature-branch diff reviewed.
- [ ] No recurring schedules created.

Results:

- GitHub:
- Supabase:
- Security:
- Profile Sync:
- Discovery readiness:
- Gmail:
- Monitor:
- Master CV:
- Tests:
- Remaining blockers:

When complete:

- Step 10 = COMPLETE
- Overall status = READY FOR SCHEDULE CREATION
- Current step = NONE
