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
  const result = [];
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
export async function candidateSources(config: any, target: number, errors: string[],
  options: { deadline: number; searchKey?: string; fetcher?: typeof fetchText; now?: () => number }) {
  const { deadline, searchKey: key, fetcher = fetchText, now = Date.now } = options;
  const urls = new Map<string, { url: string; kind: string }>();
  for (const entry of config.approved_search_sources ?? []) {
    const url = canonicalUrl(entry?.source_url ?? entry?.url);
    const kind = entry?.kind ?? "jsonld";
    if (url && ["jsonld", "jobposting_json"].includes(kind)) urls.set(url, { url, kind });
    else errors.push("invalid_search_source");
  }
  const queries = (config.search_queries ?? []).filter((q: unknown) => typeof q === "string" && q.length > 0 && q.length <= 300);
  if (queries.length) {
    if (!key) {
      errors.push("search_provider_not_configured");
    } else {
      // Only backend-approved queries are used. Search snippets are locators,
      // never evidence; each result page is fetched and verified separately.
      search: for (const query of queries.slice(0, 16)) {
        for (let offset = 0; offset < 3; offset++) {
          if (now() >= deadline) { errors.push("discovery_time_budget_reached"); break search; }
          try {
            const url = new URL("https://api.search.brave.com/res/v1/web/search");
            url.search = new URLSearchParams({ q: query, count: "20", offset: String(offset) }).toString();
            const results = JSON.parse(await timedFetchText(url.href, { Accept: "application/json", "X-Subscription-Token": key }, deadline, fetcher, now));
            for (const item of results.web?.results ?? []) {
              const candidate = canonicalUrl(item?.url);
              if (candidate) urls.set(candidate, { url: candidate, kind: "jsonld" });
            }
            if ((results.web?.results?.length ?? 0) < 20 || urls.size >= Math.min(180, target * 6)) break;
          } catch {
            if (now() >= deadline) { errors.push("discovery_time_budget_reached"); break search; }
            errors.push("search_provider_request_failed"); break;
          }
        }
        if (urls.size >= Math.min(180, target * 6)) break;
      }
    }
  }
  if (!urls.size) {
    if (errors.includes("discovery_time_budget_reached")) throw new ScheduleError("discovery_time_budget_reached", 408);
    throw new ScheduleError(errors.includes("search_provider_not_configured") ? "search_provider_not_configured" : "approved_search_configuration_unavailable", 409);
  }
  if (urls.size > 180) errors.push("search_candidate_limit_reached");
  return [...urls.values()].slice(0, 180);
}

export function verifyCandidate(job: any, jobUrl: string, settings: any, errors: string[], verifier = verifyJob) {
  try { return verifier(job, jobUrl, settings); }
  catch { errors.push("opportunity_verification_failed"); return { rejected: "invalid_posting_data" }; }
}

export async function handleDiscovery(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported" }, 405);
  let admin: any; let run: any;
  const errors: string[] = [];
  const counts: Record<string, number> = { processed_records: 0, discovered: 0, valid_opportunities: 0, rejected_domain: 0, rejected_other: 0, duplicate_count: 0, inserted_count: 0, updated_count: 0, top_matches: 0, lower_matches: 0, cvs_generated: 0, drafts_generated: 0, warning_count: 0 };
  try {
    const context = await authorizeSchedule(request, "opportunity_discovery");
    admin = context.admin;
    const { userId, body } = context;
    run = await beginRun(admin, userId, "opportunity_discovery", body);
    if (!run.acquired) return json({ run_id: run.run_id, status: run.status, replay: true });
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
    if (!settings.target_countries?.length || !settings.opportunity_types?.length) throw new ScheduleError("search_targets_unavailable", 409);
    const target = Math.min(100, Math.max(1, settings.daily_opportunity_target));
    if (!Number.isFinite(target)) throw new ScheduleError("invalid_daily_target", 409);
    const [profile, evidence, history, masterResult, profileRunResult, activeProfileResult] = await Promise.all([
      rows(admin, "profile_facts", "id,category,name,description,verification_status,last_verified_at", userId, workDeadline, true),
      rows(admin, "profile_fact_evidence", "id,fact_id,source_url,source_type,source_name,last_verified_at", userId, workDeadline),
      rows(admin, "opportunity_records", "id,source_url,external_id,organization,position,first_discovered_at,application_status", userId, workDeadline),
      admin.from("master_cv_versions").select("id,revision,content").eq("user_id", userId).eq("is_current", true).maybeSingle().abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
      admin.from("schedule_runs").select("run_id,finished_at,status").eq("user_id", userId).eq("schedule_type", "profile_sync").eq("dry_run", false).in("status", ["completed", "partial"]).gt("processed_records", 0).order("finished_at", { ascending: false }).limit(1).maybeSingle().abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
      admin.from("schedule_runs").select("run_id").eq("user_id", userId).eq("schedule_type", "profile_sync").eq("status", "running").gt("lease_expires_at", new Date().toISOString()).limit(1).maybeSingle().abortSignal(AbortSignal.timeout(requestBudget(workDeadline))),
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
    // Cap search itself to 25s so collecting result URLs cannot consume the
    // entire work budget before a single source is verified and saved.
    const sources = await candidateSources(config, target, errors, {
      deadline: Math.min(workDeadline, Date.now() + 25000), searchKey: Deno.env.get("BRAVE_SEARCH_API_KEY"),
    });
    const seen = new Set<string>();
    for (const source of sources) {
      if (Date.now() >= workDeadline) { errors.push("discovery_time_budget_reached"); break; }
      let jobs;
      try {
        const document = await timedFetchText(source.url, { Accept: "text/html, application/json" }, workDeadline);
        jobs = source.kind === "jobposting_json" ? JSON.parse(document) : jsonLdJobs(document);
        if (!Array.isArray(jobs)) jobs = [jobs];
      } catch { errors.push("opportunity_source_read_failed"); continue; }
      for (const job of jobs) {
        if (Date.now() >= workDeadline || counts.discovered >= 600) { errors.push("discovery_record_budget_reached"); break; }
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
        const identity = `${opportunity.source_url}|${opportunity.external_id ?? ""}|${opportunity.organization.toLowerCase()}|${opportunity.position.toLowerCase()}`;
        if (seen.has(identity)) { counts.duplicate_count++; continue; }
        seen.add(identity);
        const score = scoreOpportunity(opportunity, facts, settings.match_threshold);
        const record = { ...opportunity, ...score, source_is_single_posting: jobs.length === 1 };
        counts.valid_opportunities++;
        counts[score.classification === "top" ? "top_matches" : "lower_matches"]++;
        if (body.dry_run === true) { counts.processed_records++; continue; }
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
          if (master?.content?.trim()) {
            const materials = prepareMaterials(record, facts, master, settings);
            const key = await contentKey(materials);
            const prepared = await admin.rpc("automation_prepare_artifacts", { p_user_id: userId, p_opportunity_id: opportunityId,
              p_cv: materials.cv, p_email: materials.email, p_content_key: key }).abortSignal(AbortSignal.timeout(requestBudget(workDeadline)));
            if (prepared.error) { errors.push("application_preparation_failed"); continue; }
            counts.cvs_generated += prepared.data.cv_created ? 1 : 0;
            counts.drafts_generated += prepared.data.email_created ? 1 : 0;
          }
        } catch { errors.push("opportunity_ingestion_failed"); }
      }
      // All valid records on the current page are saved, including lower matches.
      if (counts.valid_opportunities >= target) break;
    }
    if (counts.valid_opportunities < target) errors.push("daily_target_not_reached");
    counts.warning_count = errors.length;
    const status = errors.length ? (counts.processed_records ? "partial" : "failed") : "completed";
    await finishRun(admin, run, status, counts, [...new Set(errors)]);
    return json({ run_id: run.run_id, status, dry_run: body.dry_run === true, counts, errors: [...new Set(errors)] });
  } catch (error) {
    const safe = error instanceof ScheduleError ? error : new ScheduleError("discovery_failed");
    if (admin && run?.acquired) {
      const status = safe.status === 409 ? "blocked" : "failed";
      await finishRun(admin, run, status, counts, [safe.code]).catch(() => {});
      return json({ run_id: run.run_id, status, reason: safe.code }, safe.status);
    }
    return errorResponse(safe);
  }
}
if (import.meta.main) Deno.serve(handleDiscovery);
