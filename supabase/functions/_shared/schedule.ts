import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

export type ScheduleType = "profile_sync" | "opportunity_discovery" | "application_monitor";
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
export class ScheduleError extends Error {
  constructor(public code: string, public status = 500) { super(code); }
}
function secret(map: string, ...names: string[]): string {
  try {
    const value = JSON.parse(Deno.env.get(map) || "{}").default;
    if (typeof value === "string" && value) return value;
  } catch { /* use individual backend secret */ }
  for (const name of names) { const value = Deno.env.get(name); if (value) return value; }
  throw new ScheduleError("backend_not_configured", 503);
}
async function equalSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

// No endpoint accepts account scope, credentials, source configuration, or facts
// from a browser request. Settings always come from the authenticated owner row.
export async function authorizeSchedule(request: Request, scheduleType?: ScheduleType) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 16_384) throw new ScheduleError("request_too_large", 413);
  let body: Record<string, unknown>;
  try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new ScheduleError("invalid_request", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("invalid_request", 400);
  if ("user_id" in body) throw new ScheduleError("account_scope_is_server_controlled", 403);
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") throw new ScheduleError("invalid_dry_run", 400);
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new ScheduleError("backend_not_configured", 503);
  const key = secret("SUPABASE_SECRET_KEYS", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let userId: string;
  const ticket = request.headers.get("x-schedule-ticket");
  const scheduleKey = request.headers.get("x-schedule-key");
  if (ticket) {
    if (!scheduleType || !/^[a-f0-9]{64}$/.test(ticket)) throw new ScheduleError("unauthorized", 401);
    const { data, error } = await admin.rpc("automation_consume_schedule_ticket", { p_ticket: ticket, p_schedule_type: scheduleType });
    if (error || !data?.user_id) throw new ScheduleError("unauthorized", 401);
    userId = data.user_id;
  } else if (scheduleKey) {
    const expected = Deno.env.get("SCHEDULE_API_KEY");
    const configuredOwner = Deno.env.get("SCHEDULE_OWNER_USER_ID") ?? Deno.env.get("INGEST_OWNER_USER_ID");
    if (!expected || !configuredOwner || !(await equalSecret(scheduleKey, expected))) throw new ScheduleError("unauthorized", 401);
    userId = configuredOwner;
  } else {
    const token = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new ScheduleError("unauthorized", 401);
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) throw new ScheduleError("unauthorized", 401);
    userId = data.user.id;
  }
  const { data: settings, error } = await admin.from("user_settings").select("user_id").eq("user_id", userId).maybeSingle();
  if (error || !settings) throw new ScheduleError("owner_settings_unavailable", 403);
  return { admin, userId, body };
}

export async function beginRun(admin: SupabaseClient<any>, userId: string, type: ScheduleType, body: Record<string, unknown>, sources: unknown[] = []): Promise<any> {
  const requestId = typeof body.request_id === "string" ? body.request_id : crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new ScheduleError("invalid_request_id", 400);
  const { data, error } = await admin.rpc("automation_begin_schedule", { p_user_id: userId, p_schedule_type: type, p_request_id: requestId, p_dry_run: body.dry_run === true, p_sources: sources });
  if (error || !data?.run_id) throw new ScheduleError("run_start_failed");
  return data;
}

export async function finishRun(admin: SupabaseClient<any>, run: { run_id: string }, status: string, counts: Record<string, number> = {}, errors: string[] = []) {
  // Only explicit safe error codes and numeric counters cross the logging boundary.
  const safeErrors = errors.slice(0, 50).map(code => /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "operation_failed");
  const safeCounts = Object.fromEntries(Object.entries(counts).filter(([key, value]) => /^[a-z][a-z0-9_]{0,60}$/.test(key) && Number.isFinite(value) && value >= 0).map(([key, value]) => [key, Math.floor(value)]));
  const { data, error } = await admin.rpc("automation_finish_schedule", { p_run_id: run.run_id, p_status: status, p_counts: safeCounts, p_errors: safeErrors });
  if (error) throw new ScheduleError("run_finish_failed");
  return data;
}

export function errorResponse(error: unknown) {
  const safe = error instanceof ScheduleError ? error : new ScheduleError("operation_failed");
  return new Response(JSON.stringify({ error: safe.code }), { status: safe.status, headers: corsHeaders });
}
