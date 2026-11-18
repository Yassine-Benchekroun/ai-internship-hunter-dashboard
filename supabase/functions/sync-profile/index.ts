import { authorizeSchedule, beginRun, finishRun, ScheduleError, errorResponse } from "../_shared/schedule.ts";
import {
  MAX_FACTS, normalizedSources, boundedSourceReader, syncGithub,
  extractPortfolio, missingFacts,
} from "./core.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

// These bounded pages prevent a REST row limit from being mistaken for absent evidence.
async function readAll(admin: any, table: string, columns: string, userId: string) {
  const rows: any[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await admin.from(table).select(columns).eq("user_id", userId)
      .order("id").range(page * 500, (page + 1) * 500 - 1);
    if (error || !Array.isArray(data)) throw new Error("profile_evidence_read_failed");
    rows.push(...data);
    if (data.length < 500) return rows;
  }
  throw new Error("profile_evidence_limit_reached");
}

export async function handleProfileSync(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported" }, 405);
  let admin: any; let userId: string | undefined; let run: any; let dryRun = false;
  let startedAt = new Date().toISOString();
  try {
    const context = await authorizeSchedule(request, "profile_sync");
    admin = context.admin; userId = context.userId;
    dryRun = context.body.dry_run === true;
    run = await beginRun(admin, userId, "profile_sync", context.body);
    if (!run.acquired) return json({ run_id: run.run_id, status: run.status, replay: true });
    startedAt = new Date().toISOString();
    // The schedule-facing RPC is the only path that writes profile facts/history.
    if (!dryRun) {
      const { error } = await admin.rpc("automation_sync_profile", { p_payload: {
        user_id: userId, run_id: run.run_id, started_at: startedAt, status: "running", facts: [],
        sources_checked: [], errors: [], summary: "Approved profile source inspection started.",
      } });
      if (error) throw new Error("profile_run_start_failed");
    }
    const { data: settings, error: settingsError } = await admin.rpc("automation_read_settings", { p_user_id: userId });
    if (settingsError || !settings) throw new Error("profile_settings_unavailable");
    const configuredSources = settings.approved_profile_sources;
    const sources = normalizedSources(configuredSources);
    if (!sources.length) {
      if (!dryRun) {
        const { error } = await admin.rpc("automation_sync_profile", { p_payload: {
          user_id: userId, run_id: run.run_id, started_at: startedAt, completed_at: new Date().toISOString(),
          status: "blocked", facts: [], sources_checked: [], errors: ["approved_sources_unavailable"],
          summary: "No supported approved public sources are configured.",
        } });
        if (error) throw new Error("profile_run_finish_failed");
      }
      await finishRun(admin, run, "blocked", {}, ["approved_sources_unavailable"]);
      return json({ run_id: run.run_id, status: "blocked", reason: "approved_sources_unavailable" }, 409);
    }
    if (!dryRun) {
      const { error } = await admin.rpc("automation_sync_profile", { p_payload: {
        user_id: userId, run_id: run.run_id, started_at: startedAt, status: "running", facts: [],
        sources_checked: sources, errors: [], summary: "Reading approved profile sources.",
      } });
      if (error) throw new Error("profile_run_start_failed");
    }
    const facts = new Map(); const sourceResults = []; const completeSources = []; const errors: string[] = [];
    const readSource = boundedSourceReader({ budgetMs: 90000 });
    let usableSources = 0;
    if (!Array.isArray(configuredSources) || sources.length !== configuredSources.length) errors.push("unsupported_or_invalid_approved_source");
    for (const source of sources) {
      const { data: approved, error: approvalError } = await admin.rpc("is_approved_profile_source", {
        p_user_id: userId, p_source_type: source.source_type, p_source_name: source.source_name, p_source_url: source.source_url,
      });
      if (approvalError || approved !== true) {
        sourceResults.push({ ...source, status: "failed", records_discovered: 0, error: "source_not_approved" });
        errors.push("source_not_approved"); continue;
      }
      try {
        let result;
        if (source.source_type === "github") result = await syncGithub(source, facts, { readText: readSource });
        else {
          const html = await readSource(source.source_url, { Accept: "text/html" });
          result = { discovered: extractPortfolio(html, source, facts), complete: true, warnings: [] };
        }
        usableSources++;
        if (result.complete) completeSources.push(source);
        if (result.warnings.length) errors.push("source_inspection_incomplete");
        sourceResults.push({ ...source, status: result.complete ? "completed" : "partial", records_discovered: result.discovered,
          warnings: result.warnings });
      } catch {
        // Provider/network exception strings may contain URLs, headers, or credentials.
        errors.push("approved_source_read_failed");
        sourceResults.push({ ...source, status: "failed", records_discovered: 0, error: "approved_source_read_failed" });
      }
    }
    const [existingFacts, existingEvidence] = await Promise.all([
      readAll(admin, "profile_facts", "id,category,name,normalized_name,verification_status", userId),
      readAll(admin, "profile_fact_evidence", "id,fact_id,source_type,source_name,source_url", userId),
    ]);
    // No absence claims if extraction has been bounded or a fact has evidence in a failed source.
    const truncated = facts.size > MAX_FACTS;
    if (truncated) errors.push("profile_fact_limit_reached");
    const missing = truncated ? [] : missingFacts(existingFacts.filter(f => f.verification_status !== "rejected"), existingEvidence, completeSources, facts);
    if (missing.length > MAX_FACTS) errors.push("profile_missing_fact_limit_reached");
    const factsPayload = [...facts.values()].slice(0, MAX_FACTS);
    const missingPayload = missing.slice(0, MAX_FACTS);
    const status = errors.length ? (usableSources || factsPayload.length ? "partial" : "failed") : "completed";
    let result: Record<string, any> = {};
    if (!dryRun) {
      const { data, error } = await admin.rpc("automation_sync_profile", { p_payload: {
        user_id: userId, run_id: run.run_id, started_at: startedAt, completed_at: new Date().toISOString(), status,
        sources_checked: sourceResults, facts: factsPayload, missing_facts: missingPayload, errors,
        summary: `${factsPayload.length} evidence-backed facts inspected; ${missingPayload.length} source-missing facts require review.`,
      } });
      if (error) throw new Error("profile_contract_rejected");
      result = data ?? {};
    }
    const counts = {
      processed_records: factsPayload.length, inserted_count: result.records_inserted ?? 0,
      updated_count: result.records_updated ?? 0, duplicate_count: result.duplicates_ignored ?? 0,
      warning_count: errors.length, source_missing: missingPayload.length,
      needs_review: result.records_needing_review ?? 0, sources_inspected: sourceResults.length,
    };
    await finishRun(admin, run, status, counts, errors);
    return json({ ...result, run_id: run.run_id, status, dry_run: dryRun, counts, errors });
  } catch (error) {
    if (error instanceof ScheduleError && !run?.acquired) return errorResponse(error);
    const code = error instanceof Error && /^profile_[a-z_]+$/.test(error.message) ? error.message : "profile_sync_failed";
    if (admin && run?.acquired && userId) {
      if (!dryRun) await admin.rpc("automation_sync_profile", { p_payload: {
        user_id: userId, run_id: run.run_id, started_at: startedAt, completed_at: new Date().toISOString(),
        status: "failed", facts: [], sources_checked: [], errors: [code], summary: "Profile sync failed safely; existing facts preserved.",
      } });
      await finishRun(admin, run, "failed", {}, [code]).catch(() => {});
    }
    return json({ error: code, run_id: run?.run_id }, 500);
  }
}

if (import.meta.main) Deno.serve(handleProfileSync);
