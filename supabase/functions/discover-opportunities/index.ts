import { authorizeSchedule, beginRun, finishRun, ScheduleError, errorResponse, corsHeaders } from "../_shared/schedule.ts";
import { fetchText, normalizedSources, sourceKey } from "../sync-profile/core.mjs";
import { canonicalUrl, jsonLdJobs, verifyJob, scoreOpportunity, prepareMaterials, contentKey } from "./core.mjs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
export function requestBudget(deadline: number, maxMs = 10000, now = Date.now): number {
  const remaining = Math.floor(deadline - now());
  if (remaining < 1) throw new ScheduleError("discovery_time_budget_reached", 408);
  return Math.min(maxMs, remaining);
}
// The outer timer also bounds DNS resolution, which occurs before fetchText's
// HTTP timeout. Every external read shares the run's work deadline.
export async function timedFetchText(url: string, headers: Record<string, string>, deadline: number,
  fetcher: typeof fetchText = fetchText, now = Date.now) {
  const timeoutMs = requestBudget(deadline, 10000, now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetcher(url, headers, { timeoutMs }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ScheduleError("discovery_source_timeout", 408)), timeoutMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function rows(admin: any, table: string, columns: string, userId: string, deadline: number, verified = false) {
  const result: any[] = [];
  for (let page = 0; page < 20; page++) {
    let query = admin.from(table).select(columns).eq("user_id", userId).order("id").range(page * 500, (page + 1) * 500 - 1);
    if (verified) query = query.eq("verification_status", "verified");
    const { data, error } = await query.abortSignal(AbortSignal.timeout(requestBudget(deadline)));
    if (error || !Array.isArray(data)) throw new ScheduleError("discovery_input_read_failed");
    result.push(...data);
    if (data.length < 500) return result;
  }
  throw new ScheduleError("discovery_input_limit_reached");
}
type CandidateSource = { url: string; kind: string };
const MAX_SEARCH_PAGES = 180;
const SOURCE_BATCH_SIZE = 6;

export async function* candidateSources(config: any, errors: string[],
  options: { deadline: number; searchKey?: string; retryUrls?: string[]; fetcher?: typeof fetchText; now?: () => number;
    reserveSearch?: () => Promise<{ allowed: boolean }> }) {
  const { deadline, searchKey: key, retryUrls = [], fetcher = fetchText, now = Date.now, reserveSearch } = options;
  const visited = new Set<string>();
  const direct: CandidateSource[] = [];
  for (const entry of config.approved_search_sources ?? []) {
    const url = canonicalUrl(entry?.source_url ?? entry?.url);
    const kind = entry?.kind ?? "jsonld";
    if (!url || !["jsonld", "jobposting_json"].includes(kind)) {
      errors.push("invalid_search_source");
    } else if (!visited.has(url)) {
      visited.add(url);
      direct.push({ url, kind });
    }
  }
  for (const url of retryUrls) if (!visited.has(url)) {
    visited.add(url);
    direct.push({ url, kind: "jsonld" });
  }
  yield direct;

  const queries = (config.search_queries ?? []).filter((q: unknown) => typeof q === "string" && q.length > 0 && q.length <= 300);
  if (!queries.length) {
    if (!direct.length) errors.push("approved_search_configuration_unavailable");
    return;
  }
  if (!key) {
    errors.push("search_provider_not_configured");
    return;
  }

  // Check each approved search group before asking any group for a deeper
  // page. Yield result URLs immediately so verification shares the same
  // deadline instead of waiting for every search request.
  const activeQueries = [...new Set<string>(queries.slice(0, 16))];
  for (let offset = 0; offset < 3 && activeQueries.length; offset++) {
    for (const query of [...activeQueries]) {
      if (now() >= deadline) { errors.push("discovery_time_budget_reached"); return; }
      if (reserveSearch) {
        try {
          const budget = await reserveSearch();
          if (!budget?.allowed) { errors.push("search_request_budget_exhausted"); return; }
        } catch {
          errors.push("search_request_budget_unavailable");
          return;
        }
      }
      const batch: CandidateSource[] = [];
      try {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.search = new URLSearchParams({ q: query, count: "20", offset: String(offset) }).toString();
        const result = JSON.parse(await timedFetchText(url.href, { Accept: "application/json", "X-Subscription-Token": key }, deadline, fetcher, now));
        const items = Array.isArray(result.web?.results) ? result.web.results : [];
        for (const item of items) {
          const candidate = canonicalUrl(item?.url);
          if (!candidate || visited.has(candidate) || visited.size >= MAX_SEARCH_PAGES) continue;
          visited.add(candidate);
          batch.push({ url: candidate, kind: "jsonld" });
        }
        if (items.length < 20 || result.query?.more_results_available === false) {
          activeQueries.splice(activeQueries.indexOf(query), 1);
        }
      } catch {
        if (now() >= deadline) { errors.push("discovery_time_budget_reached"); return; }
        errors.push("search_provider_request_failed");
        activeQueries.splice(activeQueries.indexOf(query), 1);
      }
      if (batch.length) yield batch;
      if (visited.size >= MAX_SEARCH_PAGES) { errors.push("search_candidate_limit_reached"); return; }
    }
  }
}

function normalizeIdentityUrl(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/#.*$/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}
function postingIdentity(posting: any): string {
  const field = (value: string | null) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return [normalizeIdentityUrl(posting.source_url), field(posting.organization), field(posting.position)].join("|");
}
function dryRunHistory(history: any[]) {
  const keys = new Set<string>();
  const urlIds = new Map<string, Set<string>>();
  function add(posting: any) {
    keys.add(postingIdentity(posting));
    const url = normalizeIdentityUrl(posting.source_url);
    const ids = urlIds.get(url) ?? new Set<string>();
    ids.add(posting.external_id || "");
    urlIds.set(url, ids);
  }
  for (const posting of history) add(posting);
  return {
    add,
    has(posting: any) {
      if (keys.has(postingIdentity(posting))) return true;
      if (!posting.source_is_single_posting) return false;
      const ids = urlIds.get(normalizeIdentityUrl(posting.source_url));
      return Boolean(ids && (!posting.external_id || ids.has("") || ids.has(posting.external_id)));
    },
  };
}

async function dailyCount(admin: any, userId: string, startedAt: string, deadline: number): Promise<number> {
  const { data, error } = await admin.rpc("automation_discovery_daily_count", {
    p_user_id: userId, p_started_at: startedAt,
  }).abortSignal(AbortSignal.timeout(requestBudget(deadline)));
  if (error || !Number.isSafeInteger(data) || data < 0) throw new ScheduleError("discovery_daily_count_unavailable");
  return data;
}

async function reserveDiscoverySearchRequest(admin: any, userId: string, deadline: number) {
  const { data, error } = await admin.rpc("automation_reserve_discovery_search_request", {
    p_user_id: userId,
    p_requested_at: new Date().toISOString(),
  }).abortSignal(AbortSignal.timeout(requestBudget(deadline)));
  if (error || !data || typeof data !== "object" || typeof data.allowed !== "boolean") {
    throw new ScheduleError("search_request_budget_unavailable", 503);
  }
  return data as { allowed: boolean; request_limit: number; requests_used: number; requests_remaining: number };
}

async function retryPreparationSources(admin: any, userId: string, requestId: unknown, attempt: number, deadline: number) {
  if (attempt < 2 || typeof requestId !== "string") return [];
  const { data: runs, error } = await admin.from("schedule_runs").select("run_id,errors")
    .eq("user_id", userId).eq("schedule_type", "opportunity_discovery").eq("dry_run", false)
    .eq("request_id", requestId).lt("attempt", attempt).order("attempt", { ascending: false }).limit(3)
    .abortSignal(AbortSignal.timeout(requestBudget(deadline)));
  if (error) throw new ScheduleError("preparation_retry_read_failed");
  const runIds = (runs ?? []).filter((run: any) => run.errors?.some((code: string) =>
    ["application_preparation_failed", "master_cv_content_unavailable", "lease_expired"].includes(code))).map((run: any) => run.run_id);
  if (!runIds.length) return [];
  const { data: events, error: readError } = await admin.from("opportunity_ingestion_events")
    .select("source_url,opportunity_records(raw_payload)").eq("user_id", userId).eq("source_name", "opportunity_discovery")
    .in("request_id", runIds).order("id").limit(MAX_SEARCH_PAGES)
    .abortSignal(AbortSignal.timeout(requestBudget(deadline)));
  if (readError) throw new ScheduleError("preparation_retry_read_failed");
  const urls = new Set<string>();
  for (const event of events ?? []) {
    if (typeof event.source_url !== "string") continue;
    const original = canonicalUrl(event.opportunity_records?.raw_payload?.source_url);
    // Keep the original case-sensitive URL when it matches the protected
    // ingestion event. Otherwise recover its HTTPS address from the event.
    const url = original && normalizeIdentityUrl(original) === normalizeIdentityUrl(event.source_url)
      ? original : canonicalUrl(event.source_url) ?? canonicalUrl(`https://${event.source_url}`);
    if (url) urls.add(url);
  }
  return [...urls];
}

export function verifyCandidate(job: any, jobUrl: string, settings: any, errors: string[], verifier = verifyJob) {
  try { return verifier(job, jobUrl, settings); }
  catch { errors.push("opportunity_verification_failed"); return { rejected: "invalid_posting_data" }; }
}

async function readJobs(source: CandidateSource, deadline: number) {
  const document = await timedFetchText(source.url, { Accept: "text/html, application/json" }, deadline);
  const parsed = source.kind === "jobposting_json" ? JSON.parse(document) : jsonLdJobs(document);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function handleDiscovery(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported" }, 405);
  let admin: any; let run: any;
  const errors: string[] = [];
  const counts: Record<string, number> = { processed_records: 0, discovered: 0, valid_opportunities: 0, rejected_domain: 0, rejected_other: 0, duplicate_count: 0, inserted_count: 0, updated_count: 0, top_matches: 0, lower_matches: 0, cvs_generated: 0, drafts_generated: 0, warning_count: 0,
    search_requests_reserved: 0, search_requests_month_to_date: 0, search_requests_remaining: 1000, search_request_limit: 1000 };
  try {
    const context = await authorizeSchedule(request, "opportunity_discovery");
    admin = context.admin;
    const { userId, body } = context;
    run = await beginRun(admin, userId, "opportunity_discovery", body);
    if (!run.acquired) return json({ run_id: run.run_id, status: run.status, replay: true });
    const dryRun = body.dry_run === true;
    // Includes configuration, search, verification and persistence. Stop new
    // work after 75s, reserving 15s of the 90s run budget for finalization.
    const runDeadline = Date.now() + 90000;
    const workDeadline = runDeadline - 15000;
    const [settingsResult, configResult] = await Promise.all([
      admin.rpc("automation_read_settings", { p_user_id: userId }).abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
      admin.rpc("automation_read_schedule_config", { p_user_id: userId }).abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
    ]);
    if (settingsResult.error || configResult.error) throw new ScheduleError("discovery_settings_unavailable");
    const settings = settingsResult.data; const config = configResult.data;
    const target = settings.daily_opportunity_target;
    if (!Number.isSafeInteger(target) || target < 1 || target > 100) throw new ScheduleError("invalid_daily_target", 409);
    counts.daily_target = target;
    counts.daily_discovered = await dailyCount(admin, userId, run.started_at, workDeadline);
    counts.daily_shortfall = Math.max(0, target - counts.daily_discovered);
    if (dryRun) counts.dry_run_new_candidates = 0;
    if (!settings.target_countries?.length || !settings.opportunity_types?.length) throw new ScheduleError("search_targets_unavailable", 409);
    const [profile, evidence, history, masterResult, profileRunResult, activeProfileResult, retryUrls] = await Promise.all([
      rows(admin, "profile_facts", "id,category,name,description,verification_status,last_verified_at", userId, workDeadline, true),
      rows(admin, "profile_fact_evidence", "id,fact_id,source_url,source_type,source_name,last_verified_at", userId, workDeadline),
      dryRun ? rows(admin, "opportunity_records", "id,source_url,external_id,organization,position", userId, workDeadline) : [],
      admin.from("master_cv_versions").select("id,revision,content").eq("user_id", userId).eq("is_current", true).maybeSingle().abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
      admin.from("schedule_runs").select("run_id,finished_at,status").eq("user_id", userId).eq("schedule_type", "profile_sync").eq("dry_run", false).in("status", ["completed", "partial"]).gt("processed_records", 0).order("finished_at", { ascending: false }).limit(1).maybeSingle().abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
      admin.from("schedule_runs").select("run_id").eq("user_id", userId).eq("schedule_type", "profile_sync").eq("status", "running").gt("lease_expires_at", new Date().toISOString()).limit(1).maybeSingle().abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
      dryRun ? [] : retryPreparationSources(admin, userId, body.request_id, run.attempt, workDeadline),
    ]);
    if (masterResult.error || profileRunResult.error || activeProfileResult.error) throw new ScheduleError("discovery_input_read_failed");
    if (activeProfileResult.data) throw new ScheduleError("profile_sync_in_progress", 409);
    const maxAge = config.max_profile_age_hours * 3600000;
    const latest = profileRunResult.data;
    if (!latest || Date.now() - Date.parse(latest.finished_at) > maxAge) throw new ScheduleError("verified_profile_unavailable_or_stale", 409);
    const approvedSources = new Set(normalizedSources(settings.approved_profile_sources).map(sourceKey));
    const supportedFacts = new Set(evidence.filter(e => approvedSources.has(sourceKey(e)) && Date.now() - Date.parse(e.last_verified_at) <= maxAge).map(e => e.fact_id));
    const facts = profile.filter(f => supportedFacts.has(f.id) && Date.now() - Date.parse(f.last_verified_at) <= maxAge);
    if (!facts.length) throw new ScheduleError("verified_profile_unavailable_or_stale", 409);
    const master = masterResult.data;
    // Saving valid opportunities is independent from material availability.
    if (!master?.content?.trim()) errors.push("master_cv_content_unavailable");

    const reserveSearch = Deno.env.get("BRAVE_SEARCH_API_KEY") ? async () => {
      const budget = await reserveDiscoverySearchRequest(admin, userId, workDeadline);
      counts.search_requests_reserved++;
      counts.search_requests_month_to_date = budget.requests_used;
      counts.search_requests_remaining = budget.requests_remaining;
      counts.search_request_limit = budget.request_limit;
      return budget;
    } : undefined;
    const sources = candidateSources(config, errors, {
      deadline: workDeadline,
      searchKey: Deno.env.get("BRAVE_SEARCH_API_KEY"),
      retryUrls,
      reserveSearch,
    });
    const priorPostings = dryRunHistory(history);
    const seen = new Set<string>();
    let projectedCount = counts.daily_discovered;
    async function saveVerified(source: CandidateSource, jobs: any[]) {
      for (const job of jobs) {
        if (Date.now() >= workDeadline) { errors.push("discovery_time_budget_reached"); return; }
        if (counts.discovered >= 600) { errors.push("discovery_record_budget_reached"); return; }
        counts.discovered++;
        if (!job || typeof job !== "object") { counts.rejected_other++; continue; }
        const jobUrl = canonicalUrl(job.url) ?? source.url;
        // A feed may reference individual source URLs, but cannot silently send
        // the verifier to another host; that destination must be separately fetched.
        if (jobUrl !== source.url && new URL(jobUrl).hostname !== new URL(source.url).hostname) {
          errors.push("cross_host_job_url_requires_verification"); continue;
        }
        const result = verifyCandidate(job, jobUrl, settings, errors);
        if (result.rejected) { counts[result.rejected === "domain_irrelevant" ? "rejected_domain" : "rejected_other"]++; continue; }
        const opportunity = result.opportunity;
        if (!opportunity) { counts.rejected_other++; continue; }
        const identity = postingIdentity(opportunity);
        if (seen.has(identity)) { counts.duplicate_count++; continue; }
        seen.add(identity);
        const score = scoreOpportunity(opportunity, facts);
        const record = { ...opportunity, ...score, source_is_single_posting: jobs.length === 1 };
        counts.valid_opportunities++;
        counts[score.classification === "top" ? "top_matches" : "lower_matches"]++;
        if (dryRun) {
          if (priorPostings.has(record)) counts.duplicate_count++;
          else {
            priorPostings.add(record);
            counts.dry_run_new_candidates++;
            projectedCount++;
          }
          counts.processed_records++;
          continue;
        }
        try {
          // Commit history before preparing artifacts; preparation failure cannot
          // roll back a verified opportunity or destroy older versions.
          const { data, error } = await admin.rpc("automation_ingest_opportunities", { p_payload: {
            user_id: userId, request_id: run.run_id, source_name: "opportunity_discovery", opportunities: [record],
          } }).abortSignal(AbortSignal.timeout(requestBudget(workDeadline)));
          if (error || data?.accepted_count !== 1) throw new Error("ingestion_failed");
          const opportunityId = data.accepted[0].opportunity_id;
          counts.processed_records++;
          counts.inserted_count += data.inserted_count;
          counts.updated_count += data.updated_count;
          counts.duplicate_count += data.duplicate_count;
          projectedCount += data.inserted_count;
          if (master?.content?.trim()) {
            try {
              const materials = prepareMaterials(record, facts, master, settings);
              const key = await contentKey(materials);
              const prepared = await admin.rpc("automation_prepare_artifacts", { p_user_id: userId, p_opportunity_id: opportunityId,
                p_cv: materials.cv, p_email: materials.email, p_content_key: key }).abortSignal(AbortSignal.timeout(requestBudget(workDeadline)));
              if (prepared.error) throw new Error("preparation_failed");
              counts.cvs_generated += prepared.data.cv_created ? 1 : 0;
              counts.drafts_generated += prepared.data.email_created ? 1 : 0;
            } catch { errors.push("application_preparation_failed"); }
          }
        } catch { errors.push("opportunity_ingestion_failed"); }
      }
    }

    search: for await (const batch of sources) {
      for (let cursor = 0; cursor < batch.length; cursor += SOURCE_BATCH_SIZE) {
        if (Date.now() >= workDeadline) { errors.push("discovery_time_budget_reached"); break search; }
        if (counts.discovered >= 600) { errors.push("discovery_record_budget_reached"); break search; }
        const group = batch.slice(cursor, cursor + SOURCE_BATCH_SIZE);
        const pages = await Promise.allSettled(group.map(source => readJobs(source, workDeadline)));
        for (let index = 0; index < pages.length; index++) {
          const page = pages[index];
          if (page.status === "fulfilled") await saveVerified(group[index], page.value);
          else errors.push("opportunity_source_read_failed");
        }
      }
      // Keep lower matches and preserve previously saved opportunities. Finish
      // the direct-source/retry batch before deciding whether more search is needed.
      if (projectedCount >= target) break;
    }
    if (!dryRun) {
      counts.daily_discovered = await dailyCount(admin, userId, run.started_at, runDeadline);
      counts.daily_shortfall = Math.max(0, target - counts.daily_discovered);
    }
    const unmetQuota = (dryRun ? projectedCount : counts.daily_discovered) < target;
    if (unmetQuota) errors.unshift("daily_target_not_reached");
    counts.warning_count = errors.length;
    const sourceConfigurationMissing = errors.includes("search_provider_not_configured") || errors.includes("approved_search_configuration_unavailable") || errors.includes("search_request_budget_exhausted") || errors.includes("search_request_budget_unavailable");
    const status = unmetQuota ? (!counts.processed_records && sourceConfigurationMissing ? "blocked" : "failed")
      : errors.length ? (counts.processed_records ? "partial" : "failed") : "completed";
    await finishRun(admin, run, status, counts, [...new Set(errors)]);
    return json({ run_id: run.run_id, status, dry_run: dryRun, counts, errors: [...new Set(errors)] });
  } catch (error) {
    const safe = error instanceof ScheduleError ? error : new ScheduleError("discovery_failed");
    if (admin && run?.acquired) {
      const status = safe.status === 409 ? "blocked" : "failed";
      const failures = [...new Set([safe.code, ...errors])];
      if (counts.daily_shortfall > 0 && (counts.dry_run_new_candidates ?? 0) < counts.daily_shortfall &&
          !failures.includes("daily_target_not_reached")) failures.unshift("daily_target_not_reached");
      counts.warning_count = failures.length;
      await finishRun(admin, run, status, counts, failures).catch(() => {});
      return json({ run_id: run.run_id, status, reason: safe.code, counts, errors: failures }, safe.status);
    }
    return errorResponse(safe);
  }
}
if (import.meta.main) Deno.serve(handleDiscovery);
