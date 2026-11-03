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

**Step 4 — Add Master CV backend support**

---

# Step tracker

| Step | Status |
|---|---|
| 1. Reconcile GitHub ↔ Supabase migrations | COMPLETE |
| 2. Fix authoritative backend settings | COMPLETE |
| 3. Remove hardcoded real user/source data safely | COMPLETE |
| 4. Add Master CV backend support | NOT STARTED |
| 5. Add Profile Sync endpoint + dry run | BLOCKED BY STEP 4 |
| 6. Verify Opportunity ingestion + dry run | BLOCKED BY STEP 5 |
| 7. Implement Gmail/provider OAuth | BLOCKED BY STEP 6 |
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
- Commit: `98589aa` — Complete Step 3 source privacy hardening; no deployment or merge performed.
- Blockers: None for Step 3. Step 4 remains not started by request.

When complete:

- Step 3 = COMPLETE
- Current step = Step 4
- Step 4 = NOT STARTED

---

# Step 4 — Add Master CV backend support

Status: **NOT STARTED**

Checklist:

- [ ] Design minimal Master CV model.
- [ ] Add ownership/RLS.
- [ ] Add version/revision support.
- [ ] Add safe import/save path.
- [ ] Keep targeted CV versions separate.
- [ ] Do not fabricate content.
- [ ] Test owner privacy.
- [ ] Commit/push.

Results:

- Schema:
- RLS:
- Import/save:
- Tests:
- Commit:
- Blockers:

When complete:

- Step 4 = COMPLETE
- Current step = Step 5
- Step 5 = NOT STARTED

---

# Step 5 — Add Profile Sync endpoint + dry run

Status: **BLOCKED BY STEP 4**

Checklist:

- [ ] Create secure `sync-profile` endpoint.
- [ ] Require authorization.
- [ ] Scope to intended account.
- [ ] Validate approved sources.
- [ ] Keep privileged credentials server-side.
- [ ] Call existing sync RPC.
- [ ] Run controlled GitHub/portfolio sync.
- [ ] Verify profile facts/evidence.
- [ ] Verify deduplication/source-missing behavior.
- [ ] Verify sync run log.
- [ ] Verify dashboard rendering.
- [ ] Commit/push.

Results:

- Endpoint:
- Facts/evidence:
- Sync log:
- Tests:
- Commit:
- Blockers:

When complete:

- Step 5 = COMPLETE
- Current step = Step 6
- Step 6 = NOT STARTED

---

# Step 6 — Verify Opportunity ingestion + dry run

Status: **BLOCKED BY STEP 5**

Checklist:

- [ ] Compare repository/live Edge Function.
- [ ] Verify JWT protection.
- [ ] Verify private secret configuration without revealing values.
- [ ] Ingest one controlled test opportunity.
- [ ] Verify normalized row.
- [ ] Verify score/classification.
- [ ] Verify history.
- [ ] Repeat same opportunity.
- [ ] Verify deduplication.
- [ ] Verify ingestion event.
- [ ] Verify CV/email artifacts if supplied.
- [ ] Commit only if changes required.

Results:

- Function parity:
- Ingestion:
- Deduplication:
- History:
- Tests:
- Commit:
- Blockers:

When complete:

- Step 6 = COMPLETE
- Current step = Step 7
- Step 7 = NOT STARTED

---

# Step 7 — Implement Gmail/provider OAuth

Status: **BLOCKED BY STEP 6**

Checklist:

- [ ] Implement secure OAuth/provider flow.
- [ ] Keep provider secrets/tokens backend-only.
- [ ] Keep dashboard Auth separate.
- [ ] Keep sender identity separate.
- [ ] Support connection states.
- [ ] Keep automatic sending OFF.
- [ ] Test connect.
- [ ] Test disconnect/revoke.
- [ ] Test refresh/session behavior.
- [ ] Verify no token leakage.
- [ ] Commit/push.

Results:

- Provider:
- OAuth:
- Token privacy:
- Tests:
- Commit:
- Blockers:

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
