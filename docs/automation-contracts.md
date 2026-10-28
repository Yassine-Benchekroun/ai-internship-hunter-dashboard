# Secure automation contracts

Phase 3 prepares backend contracts for three future agents. The contracts are
server-side only; no schedule is created by this repository and no contract
sends email.

## Authentication boundary

The SQL functions below are `SECURITY DEFINER` functions with a fixed
`search_path`. `anon` and `authenticated` have no `EXECUTE` privilege. Only
`service_role` can call them through Supabase RPC. The service-role key must be
kept in an Edge Function or another private worker and must never be placed in
GitHub Pages, frontend JavaScript, documentation, or source control.

The deployed `ingest-opportunities` Edge Function adds a second boundary:

- Supabase JWT verification is enabled at the platform boundary.
- The worker must also send the private `x-ingest-api-key` header.
- The function maps the request to the configured owner UUID and calls
  `automation_ingest_opportunities` with the service-role client.

The API key and owner UUID are function environment variables. Their values are
not part of this repository.

## Shared settings contract

`public.automation_read_settings(p_user_id uuid)` returns the backend-driven
settings required by future agents:

- `match_threshold`
- `daily_opportunity_target`
- `domain_relevance_enabled`
- `target_countries`
- `opportunity_types`
- `approved_profile_sources`
- sender identity fields and provider connection state

It is read-only and service-role-only. It does not return provider secrets.

## Automation 1 — Verified Profile Sync

RPC: `public.automation_sync_profile(p_payload jsonb)`

Reads and writes:

- Reads existing `profile_facts` and `profile_fact_evidence`.
- Writes new or changed `profile_facts`, evidence rows, and one
  `profile_sync_runs` record.
- Accepts an explicit `missing_facts` list and marks matching facts
  `source_missing`; it never deletes a fact.
- Normalizes categories and names before matching, including the existing
  Python/scikit-learn/OpenCV alias rules.

Payload shape:

```json
{
  "user_id": "owner-uuid",
  "run_id": "optional-uuid",
  "started_at": "2026-10-28T07:00:00Z",
  "completed_at": "2026-10-28T07:00:04Z",
  "status": "completed",
  "sources_checked": [
    {"source_type": "github", "source_name": "Yassine-Benchekroun", "source_url": "https://github.com/Yassine-Benchekroun"}
  ],
  "facts": [
    {
      "category": "skill",
      "name": "Python",
      "description": "Evidence-backed description",
      "verification_status": "verified",
      "evidence": [
        {
          "source_type": "github",
          "source_name": "Yassine-Benchekroun",
          "source_url": "https://github.com/Yassine-Benchekroun",
          "evidence": "Source excerpt or locator"
        }
      ]
    }
  ],
  "missing_facts": [
    {"category": "technology", "name": "Docker"}
  ],
  "errors": [],
  "summary": "Profile sync completed"
}
```

## Automation 2 — Opportunity Discovery

RPC: `public.automation_ingest_opportunities(p_payload jsonb)`

Reads and writes:

- Reads `user_settings` for the current threshold and existing
  `opportunity_records` for deterministic deduplication.
- Writes `opportunity_records` and `opportunity_ingestion_events`.
- Writes `cv_versions` and `email_drafts` only when versioned artifacts are
  included in the payload.
- Does not delete opportunities, change profile facts, or send email.

Payload shape:

```json
{
  "user_id": "owner-uuid",
  "request_id": "optional-uuid",
  "source_name": "future-discovery-worker",
  "opportunities": [
    {
      "organization": "Example University",
      "organization_type": "university",
      "professor_researcher": "Confirmed contact when available",
      "position": "AI Research Internship",
      "research_area": "Computer vision",
      "country": "France",
      "city": "Paris",
      "opportunity_type": "research",
      "source_url": "https://example.org/opportunity",
      "external_id": "optional-source-id",
      "description": "Verified opportunity description",
      "requirements": ["Python"],
      "deadline": "2026-12-01",
      "funding": "Verified funding information",
      "work_mode": "onsite",
      "domain_relevant": true,
      "domain_relevance_reason": "The technical research problem is relevant",
      "verified_skills": ["Python"],
      "missing_skills": [],
      "projects": ["Verified project name"],
      "score_breakdown": {
        "technical": 25,
        "projects": 20,
        "topic": 18,
        "education": 8,
        "eligibility": 7,
        "access": 4
      },
      "match_score": 82,
      "cv": {
        "version": 1,
        "is_current": true,
        "change_summary": "Initial targeted CV",
        "content": "Verified-facts-only CV content"
      },
      "email_draft": {
        "version": 1,
        "is_current": true,
        "recipient": "Only a verified recipient, when available",
        "subject": "Application subject",
        "body": "Personalized draft; never sent by this contract"
      }
    }
  ]
}
```

The source URL, organization, position, and domain-relevance gate are
required. Duplicate records use the deterministic URL/organization/position
key, preserve `first_discovered_at`, update `last_checked_at`, and recalculate
classification from the stored threshold. A score of 68 remains `lower`; it
is never discarded. Existing application status, active visibility, and old
CV/email versions are preserved.

## Automation 3 — Application Monitor

RPC: `public.automation_update_application(p_payload jsonb)`

Reads and writes:

- Reads one owner-owned `application_records` row and its linked opportunity.
- Updates application status, response/follow-up timestamps, notes, and the
  linked opportunity's application status.
- Optionally creates or idempotently updates a versioned follow-up draft in
  `email_drafts`.
- Does not delete history, modify Verified Profile facts, or send email.

Payload shape:

```json
{
  "user_id": "owner-uuid",
  "application_id": "application-uuid",
  "application_status": "follow_up_needed",
  "last_response_at": "2026-10-28T12:00:00Z",
  "follow_up_at": "2026-11-04T12:00:00Z",
  "notes": "Reply requires human review",
  "follow_up_draft": {
    "version": 1,
    "is_current": true,
    "recipient": "Verified recipient only",
    "subject": "Follow-up subject",
    "body": "Draft only; requires explicit human send action"
  }
}
```

`follow_up_draft` requires `follow_up_needed` status and a non-empty body. The
status list is constrained to the normalized application lifecycle. Existing
classification is independent and is not changed by application status.

## Operational restrictions

- These contracts are not schedules.
- No contract sends mail.
- The browser continues using the existing owner-only RLS policies for normal
  dashboard actions.
- All future workers must use these contracts rather than direct table writes.
- Any future schedule must be explicitly configured after Phase 4 verification.
