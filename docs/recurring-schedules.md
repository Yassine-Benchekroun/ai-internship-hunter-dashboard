# Independent schedules

Three separate workers implement profile sync, discovery/preparation, and mailbox monitoring. Installing the migration defines the scheduler interfaces but creates **no recurring jobs**. Automatic sending is always disabled; there is no sending endpoint in this implementation.

| Worker | Ownership and writes | Dependency |
| --- | --- | --- |
| `sync-profile` | Profile facts, evidence, profile run history, shared run health | Explicit backend-approved public sources |
| `discover-opportunities` | Opportunities, ingestion events, immutable CV/email versions, shared run health | Fresh, evidence-backed profile from a successful non-dry profile run |
| `application-monitor` | Application/reply history, linked application status, follow-up draft versions, shared run health | Actual read-only Gmail authorization; independent of discovery |

All three derive account ownership from a validated Supabase Auth JWT or a server-generated, single-use, five-minute ticket. Requests containing `user_id` are rejected. The shared handler validates authentication itself, so these three functions use `verify_jwt = false` at the gateway; this does **not** make the handler unauthenticated. The existing ingestion function retains its gateway JWT and private ingestion-key checks.

Tickets are hashed in the private schema and consumed atomically for one schedule type. The optional server-key path requires both `SCHEDULE_API_KEY` and a configured `SCHEDULE_OWNER_USER_ID` (or the existing `INGEST_OWNER_USER_ID`). Neither credential path is exposed to the browser. Runtime packages are pinned in `deno.lock` and `package-lock.json`.

## Profile sync

Approved GitHub account URLs enumerate only that account's non-fork repositories. Approved GitHub repository URLs read only that repository's README. The approved profile README and portfolio configuration live in the owner's backend settings; there are no personal source defaults in the worker.

Explicit technology sections, repository language metadata, and portfolio project/education/experience sections provide evidence. Repository topics, incidental dependencies, future learning plans, and arbitrary mentions are not automatically verified. Aliases normalize consistently. Evidence retains source URL plus a locator/excerpt. Education dates stay with their original timeline entry.

Only complete source inspections support absence detection. Failed or truncated sources never cause their facts to be marked missing. Facts are retained; missing evidence produces a review state, never deletion. Public source fetches require HTTPS and public DNS addresses, reject redirects, and bound response size and time.

## Discovery and preparation

Backend `approved_search_sources` accepts entries such as:

```json
[{"kind":"jsonld","source_url":"https://careers.example.org/individual-opening"}]
```

Supported input formats are Schema.org `JobPosting` JSON-LD, HTML microdata, and `jobposting_json` feeds. Pages without reliable structured posting data are not guessed into opportunities. Arbitrary lab/professor prose is not currently extracted. `search_queries` can contain approved search strings; broad web search uses a backend-only `BRAVE_SEARCH_API_KEY`. A search key is optional when approved posting sources are supplied. No private candidate data is sent to that search service.

Search results are locators only: source documents must be fetched and verified. Country and opportunity-type preferences come from `user_settings`. Unknown location, funding, deadline or recipient information stays unknown. Known countries outside the configured list and unrelated or expired roles are rejected. Both top and lower matches are saved.

Scoring is deterministic and stored with its explanation: technical overlap (35), project evidence (25), topic overlap (20), education wording (10), eligibility (5), access (5). Eligibility/access receive zero when not established; country preference never implies work authorization. Application status is excluded from scoring.

The worker uses only fresh verified facts backed by currently approved sources. The default profile maximum age is 168 hours. It blocks while profile sync is running or if no usable successful profile run exists. A failed profile run may fall back to the last successful state within the validity window.

Each opportunity is committed before preparation. The CV emphasizes matching verified facts and preserves approved Master CV content verbatim. Drafts use only an explicitly published application-contact email; otherwise the recipient stays empty. Missing sender identity is a visible review placeholder. All generated materials start as `Needs review`.

Content hashes and row locks make preparation retries idempotent. Genuine new content appends versions; older automation artifacts cannot be overwritten. Identical legacy artifacts are reused without changing their content. A corrected title on an explicitly verified single-posting URL updates the existing opportunity. The original discovery time and linked history survive updates.

The daily quota is a minimum for successful discovery. Only distinct opportunities first saved by the discovery worker that calendar day count, using the owner's configured timezone. Rediscovered records and dry runs do not fill the quota. Failed attempts keep their verified results and the next attempt counts them toward the same day. If configured sources are exhausted, search access is missing, or the execution budget expires before the quota is reached, run health records a failed or blocked run with its exact shortfall and available error codes. Meeting the quota still requires enough unique, verifiable listings from working sources.

## Monitoring

A sender email alone never authorizes monitoring. Both backend provider status and the private connection must be connected with read-only scopes. Revoked authorization blocks the run before mailbox inspection, even if there are zero applications.

The worker queries each known application's contact/date range, paginates metadata, and requires sender, delivery address, sent date, and an exact normalized subject or known thread. Ambiguous matches receive a manual-review note. Incomplete scans never infer no reply or create follow-ups. Metadata classifications are conservative; uncertain messages remain `replied`.

Reply IDs are deduplicated across the owner's applications, response timestamps cannot regress, and confirmed threads are retained. Follow-ups use a stable application/sent-date/due-date key and append an immutable draft. Monitoring updates only linked application status, never score or match classification. Terminal states are excluded unless explicitly configured.

## Configuration and recurrence gate

`save_schedule_configuration(jsonb)` derives the owner from `auth.uid()`. It supports timezone, daily profile/discovery times, monitor times, maximum profile age, follow-up days, and search configuration. It cannot enable recurrence or manufacture validation results. Configuration changes invalidate prior validation and disable recurrence.

Defaults: `Africa/Casablanca`, profile at 07:00, discovery at 08:00, monitoring at 08:30/12:30/16:30/20:30, seven-day follow-up interval. The actual timezone database determines local times, including clock changes.

Each worker has its own lease and run history. Retries of failed/partial attempts create new run records; completed request IDs are replay-safe. Stale leases become explicit failures, including the final exhausted attempt. A later Gmail disconnection does not prevent Profile Sync or Discovery from completing or logging their results. Errors are bounded codes, not provider exception text or mailbox content.

Only after successful live manual validations for all three workers may an administrator enable `pg_cron` and call `private.enable_recurring_schedules(owner_uuid)`. The database also checks the real Gmail connection. That function creates three independently named jobs, each checking its own configured local due time. Due slots are deduplicated; failures receive at most three dispatch attempts with 15-minute backoff. A transport failure is recorded in run health. These minute-level due checks do not inspect the mailbox except at the configured monitoring times.

**Do not invoke activation now. Gmail connection and live monitoring validation are intentionally deferred.** No recurring trigger was created during implementation.

## Deployment review and manual validation

1. Apply the checked-in schedule migrations in order. The initial `20261115190017_independent_schedule_contracts.sql` adds run/configuration tables and private dispatch state, grants worker table access, and strengthens artifact/application contracts. Existing history is retained. The user approved hosted migration and worker deployment after review.
2. Deploy `sync-profile`, then invoke its dry run and two real runs using an authenticated owner session or `private.dispatch_schedule(owner_uuid,'profile_sync',true/false)`. Include `_shared/schedule.ts`, `sync-profile/core.mjs`, and the root `deno.json`/`deno.lock` when packaging functions.
3. Verify facts/evidence and replay counts. Deploy `discover-opportunities`, configure approved posting sources or search queries plus the backend search key, and validate a controlled dry run and replay. Its deployment also needs the `linkedom/worker` import mapping from root `deno.json`.
4. Deploy `application-monitor`. Until Gmail is reconnected its expected result is `blocked`. Once authorized, use a controlled real application and replay the same reply; verify one event/transition and one follow-up per due key.
5. Record live validations with `automation_record_schedule_validation(owner_uuid,type,run_ids)`. Fixture tests and legacy-RPC smoke tests are **not** attestations for deployed worker runs.
6. Enable recurrence only after all three validations pass. Sending remains disabled after activation.

## Deployed state and validation — 2026-11-18

Both schedule migrations are applied to AI Internship Hunter: `20261115190017_independent_schedule_contracts.sql` and `20261118124405_reuse_legacy_application_artifacts.sql`. Hosted workers are `sync-profile` v4, `discover-opportunities` v1, and `application-monitor` v3. The user explicitly approved migration and worker deployment. Dashboard run-health source changes are local and have not been published to GitHub Pages.

- **Local checks:** 87 Node behavioral/auth/UI tests pass, all three workers pass Deno checking, and the complete migration chain passes PostgreSQL acceptance tests through PGlite. Tests cover replay, legacy artifact reuse, genuine version changes, RLS/grants, immutable versions, leases, mailbox-outage independence, and recurrence gates. Local `pg_net`/`pg_cron` interfaces are mocked; hosted `pg_net` dispatch and ticket authentication were subsequently verified. No hosted cron jobs were created.
- **Profile:** hosted dry run plus two real runs completed. Each real run reverified 32 facts with zero inserts/updates and 32 unchanged records. Runs: `655cc424-cc5f-4c45-b9e1-dbc859c1c9a2` and `4ee7ab61-5a79-44a5-b8d0-887ea09e7afb`. All 42 existing facts and 59 evidence rows remain unique; prior history is preserved. The earlier 2026-11-15 legacy-RPC checks had inserted 23 facts and updated 9. Only the new worker runs were used for profile validation attestation.
- **Discovery:** two real controlled runs completed against the employer's ALTEN Computer Vision internship posting. Runs: `80395d07-cbad-4a7e-a765-0716e6f4c387` and `727bc92b-9377-4784-921d-9cf9dcec41aa`. The controlled target was temporarily 1 and is restored to 30. There is one opportunity, score 28, `lower`, `not_sent`; its original 2026-11-15 discovery timestamp is preserved and last-checked advanced. The first hosted run appended CV v2 because highlight ordering differed from the earlier manual artifact; line contents match and the approved Master CV remains verbatim. The unchanged legacy email draft was reused. Replay created zero opportunities, CVs, or drafts. CV v1 is retained.
- **Monitoring:** hosted run `34b5c7a6-4a59-4f0b-930e-4cfdf3c13776` returned `blocked` / `provider_not_connected`, with zero mailbox reads, events, transitions, or drafts. This is the expected disconnected-provider behavior, not a successful authorized mailbox validation. Reply/follow-up replay is tested locally; no real mailbox was connected.
- **Authentication:** all three deployed endpoints returned HTTP 401 for unauthenticated requests. Browser-supplied ownership is rejected; one-use tickets successfully dispatched the authorized manual runs.
- **Final settings:** eight configured countries and eight corresponding search queries; daily target 30; one controlled employer source. `recurrence_enabled=false`, `automatic_sending_enabled=false`, no running leases, no recurring dispatch slots, and `pg_cron` is not installed. Only profile validation is attested.

## Remaining setup before recurrence

Broad search dry-run verification reported `search_provider_not_configured`: add `BRAVE_SEARCH_API_KEY` to Supabase's server-side Edge Function secrets, then validate discovery with the normal daily target and source coverage. Never put this key in frontend code or paste it into run logs. The structured-source parser currently supports JobPosting JSON-LD/microdata/JSON feeds; arbitrary professor/lab prose remains unsupported.

Gmail authorization is deliberately deferred at the user's request. Later, connect the read-only provider and validate a real application, reply replay, and follow-up behavior. Record the remaining validations only after those checks pass. Keep all recurring triggers disabled until then. No automatic sending is implemented.

Security advisors show intentional private-schema RLS without public policies, the owner-scoped `save_schedule_configuration` definer RPC (it checks `auth.uid()` and restricts writable fields), and `pg_net` extension metadata in `public` (`extrelocatable=false`; network objects live in `net`). The pre-existing leaked-password-protection warning remains unchanged. See the [Supabase linter guidance](https://supabase.com/docs/guides/database/database-linter) and [password security guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Run local checks with `npm ci --ignore-scripts`, `npm test`, `npm run test:sql`, and `deno task check:schedules`.

References: [Supabase function authentication](https://supabase.com/docs/guides/functions/auth), [function scheduling](https://supabase.com/docs/guides/functions/schedule-functions), [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), and [Brave search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started).
