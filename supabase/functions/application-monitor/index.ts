import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const GMAIL_PROVIDER = "gmail";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MAX_BODY_BYTES = 32_000;
const MAX_APPLICATIONS = 100;
const MAX_MESSAGES = 50;
const GOOGLE_TIMEOUT_MS = 15_000;
const LOOKBACK_DAYS = 180;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

type JsonObject = Record<string, unknown>;
type AdminClient = SupabaseClient<any>;

type ProviderConnection = {
  provider: string;
  account_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string;
  scopes: string[];
  access_token_expires_at: string | null;
  status: "not_connected" | "connected" | "revoked" | "error";
  last_error: string | null;
};

type ApplicationRecord = {
  id: string;
  opportunity_id: string | null;
  organization: string;
  position: string;
  recipient_email: string | null;
  email_subject: string | null;
  sent_at: string | null;
  application_status: string;
  follow_up_at: string | null;
};

type GmailMessage = {
  id: string;
  threadId: string | null;
  internalDate: string | null;
  headers: Record<string, string>;
};

type MonitorAction = {
  application: ApplicationRecord;
  kind: "reply" | "follow_up";
  message: GmailMessage | null;
};

class MonitorError extends Error {
  status: number;
  code: string;

  constructor(code: string, status: number) {
    super(code);
    this.name = "MonitorError";
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return isObject(value) ? value as T : null;
}

function cleanText(value: unknown, maxLength = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function serviceKey(): string | null {
  const secretMap = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretMap) {
    try {
      const parsed = JSON.parse(secretMap) as Record<string, unknown>;
      if (typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch {
      // Fall through to supported single-key names.
    }
  }
  return Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null;
}

function publishableKey(): string | null {
  const publishableMap = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (publishableMap) {
    try {
      const parsed = JSON.parse(publishableMap) as Record<string, unknown>;
      if (typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch {
      // Fall through to supported single-key names.
    }
  }
  return Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? null;
}

function authorizationHeader(request: Request): string | null {
  const value = request.headers.get("Authorization")?.trim() ?? "";
  return /^Bearer\s+\S+$/i.test(value) ? value : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new MonitorError("body_too_large", 413);
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MonitorError("body_must_be_json", 400);
  }
  if (!isObject(parsed)) throw new MonitorError("body_must_be_object", 400);
  return parsed;
}

async function callerUser(request: Request, supabaseUrl: string, publicKey: string): Promise<{ id: string } | null> {
  const authHeader = authorizationHeader(request);
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const userClient = createClient(supabaseUrl, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getUser(token);
  return error || !data.user ? null : { id: data.user.id };
}

async function googleTokenRequest(params: Record<string, string>): Promise<JsonObject> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok || !isObject(parsed)) throw new MonitorError("provider_refresh_failed", 502);
  return parsed;
}

function accessTokenFrom(response: JsonObject): string {
  const token = response.access_token;
  if (typeof token !== "string" || token.length < 10 || token.length > 4096) throw new MonitorError("provider_access_token_missing", 502);
  return token;
}

function expiresAtFrom(response: JsonObject): string {
  const seconds = Number(response.expires_in);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86_400) throw new MonitorError("provider_expiry_invalid", 502);
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}

function scopesFrom(response: JsonObject, fallback: string[]): string[] {
  if (typeof response.scope === "string") {
    const scopes = [...new Set(response.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
    if (scopes.length) return scopes.slice(0, 20);
  }
  return fallback.slice(0, 20);
}

function scopesAllowReadOnly(scopes: unknown): boolean {
  if (!Array.isArray(scopes)) return false;
  const normalized = scopes.filter((scope): scope is string => typeof scope === "string").map((scope) => scope.trim());
  if (!normalized.includes(GMAIL_READONLY_SCOPE)) return false;
  return !normalized.some((scope) => /gmail\.(send|compose|modify)|mail\.google\.com/i.test(scope));
}

async function providerConnection(adminClient: AdminClient, userId: string): Promise<ProviderConnection | null> {
  const result = await adminClient.rpc("provider_oauth_get_connection", { p_user_id: userId });
  if (result.error) throw new MonitorError("provider_lookup_failed", 502);
  return firstRow<ProviderConnection>(result.data);
}

async function markProviderError(adminClient: AdminClient, userId: string): Promise<void> {
  await adminClient.rpc("provider_oauth_mark_error", { p_user_id: userId, p_error: "application_monitor_provider_error" });
}

async function accessTokenFor(
  adminClient: AdminClient,
  userId: string,
  connection: ProviderConnection,
): Promise<{ accessToken: string; connection: ProviderConnection }> {
  const expiresAt = connection.access_token_expires_at ? Date.parse(connection.access_token_expires_at) : 0;
  if (connection.access_token && Number.isFinite(expiresAt) && expiresAt > Date.now() + 30_000) {
    return { accessToken: connection.access_token, connection };
  }
  if (!connection.refresh_token) throw new MonitorError("provider_not_connected", 409);
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  if (!clientId || !clientSecret) throw new MonitorError("provider_refresh_not_configured", 503);

  const tokenResponse = await googleTokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: connection.refresh_token,
    grant_type: "refresh_token",
  });
  const accessToken = accessTokenFrom(tokenResponse);
  const expiresAtValue = expiresAtFrom(tokenResponse);
  const scopes = scopesFrom(tokenResponse, connection.scopes);
  const stored = await adminClient.rpc("provider_oauth_store_connection", {
    p_user_id: userId,
    p_provider: GMAIL_PROVIDER,
    p_account_email: connection.account_email,
    p_access_token: accessToken,
    p_refresh_token: typeof tokenResponse.refresh_token === "string" && tokenResponse.refresh_token
      ? tokenResponse.refresh_token
      : connection.refresh_token,
    p_token_type: typeof tokenResponse.token_type === "string" ? tokenResponse.token_type : connection.token_type,
    p_scopes: scopes,
    p_access_token_expires_at: expiresAtValue,
  });
  if (stored.error) throw new MonitorError("provider_refresh_store_failed", 502);
  return {
    accessToken,
    connection: { ...connection, access_token: accessToken, access_token_expires_at: expiresAtValue, scopes },
  };
}

async function gmailJson(accessToken: string, path: string, params: URLSearchParams): Promise<JsonObject> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  params.forEach((value, key) => url.searchParams.append(key, value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (response.status === 401) throw new MonitorError("gmail_unauthorized", 502);
  if (!response.ok || !isObject(parsed)) throw new MonitorError("gmail_read_failed", 502);
  return parsed;
}

function headerMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const item of value) {
    if (!isObject(item) || typeof item.name !== "string" || typeof item.value !== "string") continue;
    output[item.name.toLowerCase()] = cleanText(item.value, 1000);
  }
  return output;
}

function messageFromPayload(value: JsonObject): GmailMessage | null {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || id.length > 512) return null;
  const payload = isObject(value.payload) ? value.payload : {};
  return {
    id,
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    internalDate: typeof value.internalDate === "string" ? value.internalDate : null,
    headers: headerMap(payload.headers),
  };
}

async function listGmailMessages(accessToken: string, applications: ApplicationRecord[]): Promise<GmailMessage[]> {
  const earliestSent = applications
    .map((application) => application.sent_at ? Date.parse(application.sent_at) : NaN)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)[0];
  const lookback = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const afterDate = new Date(Math.max(earliestSent || lookback, lookback)).toISOString().slice(0, 10).replace(/-/g, "/");
  const list = await gmailJson(accessToken, "messages", new URLSearchParams({
    maxResults: String(MAX_MESSAGES),
    q: `in:anywhere after:${afterDate}`,
  }));
  const refs = Array.isArray(list.messages) ? list.messages as Array<Record<string, unknown>> : [];
  const messages: GmailMessage[] = [];
  for (const ref of refs.slice(0, MAX_MESSAGES)) {
    const id = typeof ref.id === "string" ? ref.id : "";
    if (!id) continue;
    const detail = await gmailJson(accessToken, `messages/${encodeURIComponent(id)}`, new URLSearchParams([
      ["format", "metadata"],
      ["metadataHeaders", "From"],
      ["metadataHeaders", "To"],
      ["metadataHeaders", "Cc"],
      ["metadataHeaders", "Subject"],
      ["metadataHeaders", "Date"],
      ["metadataHeaders", "In-Reply-To"],
      ["metadataHeaders", "References"],
    ]));
    const message = messageFromPayload(detail);
    if (message) messages.push(message);
  }
  return messages;
}

function emailAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return cleanText(angle?.[1] ?? value, 320).toLowerCase();
}

function searchableWords(value: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "application", "internship", "research", "intern", "at"]);
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !stopWords.has(word)))].slice(0, 12);
}

function messageReceivedAt(message: GmailMessage): string | null {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const parsed = Date.parse(message.headers.date ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function matchesApplication(application: ApplicationRecord, message: GmailMessage, accountEmail: string | null = null): boolean {
  const from = emailAddress(message.headers.from ?? "");
  if (!from || (accountEmail && from === accountEmail.toLowerCase())) return false;
  const receivedAt = messageReceivedAt(message);
  if (application.sent_at && receivedAt && Date.parse(receivedAt) < Date.parse(application.sent_at)) return false;
  const recipientMatches = application.recipient_email && from === emailAddress(application.recipient_email);
  const subject = (message.headers.subject ?? "").toLowerCase();
  const words = searchableWords(`${application.organization} ${application.position}`);
  const subjectMatches = words.length > 0 && words.filter((word) => subject.includes(word)).length >= Math.min(2, words.length);
  return Boolean(recipientMatches || subjectMatches);
}

function followUpBody(application: ApplicationRecord): string {
  const organization = cleanText(application.organization, 200) || "your team";
  const position = cleanText(application.position, 200) || "the position";
  return `Hello,\n\nI’m following up regarding my application for ${position} at ${organization}. Please let me know if there is any update when convenient.\n\nBest regards,`;
}

async function applicationsFor(adminClient: AdminClient, userId: string, applicationId: string | null): Promise<ApplicationRecord[]> {
  let query = adminClient.from("application_records")
    .select("id, opportunity_id, organization, position, recipient_email, email_subject, sent_at, application_status, follow_up_at")
    .eq("user_id", userId)
    .order("sent_at", { ascending: false })
    .limit(MAX_APPLICATIONS);
  if (applicationId) query = query.eq("id", applicationId);
  const result = await query;
  if (result.error) throw new MonitorError("application_lookup_failed", 502);
  return (result.data ?? []) as ApplicationRecord[];
}

function actionsFor(applications: ApplicationRecord[], messages: GmailMessage[], accountEmail: string | null): MonitorAction[] {
  const actions: MonitorAction[] = [];
  for (const application of applications) {
    const replies = messages
      .filter((message) => matchesApplication(application, message, accountEmail))
      .sort((left, right) => Date.parse(messageReceivedAt(right) ?? "") - Date.parse(messageReceivedAt(left) ?? ""));
    if (replies.length) {
      actions.push({ application, kind: "reply", message: replies[0] });
      continue;
    }
    const followUpAt = application.follow_up_at ? Date.parse(application.follow_up_at) : NaN;
    if (Number.isFinite(followUpAt) && followUpAt <= Date.now() && ["already_sent", "sent", "waiting", "no_response"].includes(application.application_status)) {
      actions.push({ application, kind: "follow_up", message: null });
    }
  }
  return actions;
}

async function nextDraftVersion(adminClient: AdminClient, userId: string, application: ApplicationRecord): Promise<number> {
  const result = await adminClient.from("email_drafts")
    .select("version")
    .eq("user_id", userId)
    .eq("application_id", application.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new MonitorError("draft_lookup_failed", 502);
  const version = Number(result.data?.version ?? 0);
  return Number.isFinite(version) && version > 0 ? version + 1 : 1;
}

async function logRun(adminClient: AdminClient, payload: JsonObject): Promise<JsonObject> {
  const result = await adminClient.rpc("automation_log_application_monitor_run", { p_payload: payload });
  if (result.error) throw new MonitorError("monitor_log_failed", 502);
  const logged = firstRow<JsonObject>(result.data);
  if (!logged) throw new MonitorError("monitor_log_failed", 502);
  return logged;
}

function safeSummary(dryRun: boolean, errors: string[]): string {
  const mode = dryRun ? "dry run" : "run";
  return errors.length ? `Application Monitor ${mode} completed with ${errors.length} safe error code(s).` : `Application Monitor ${mode} completed.`;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = publishableKey();
  const privilegedKey = serviceKey();
  if (!supabaseUrl || !publicKey || !privilegedKey) return json({ error: "Application Monitor is not configured" }, 503);

  let body: JsonObject;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const monitorError = error instanceof MonitorError ? error : new MonitorError("body_invalid", 400);
    return json({ error: monitorError.code }, monitorError.status);
  }

  const user = await callerUser(request, supabaseUrl, publicKey);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const ownerId = user.id;
  if (typeof body.user_id === "string" && body.user_id !== ownerId) return json({ error: "Monitor is scoped to the signed-in account" }, 403);

  const requestedApplicationId = body.application_id === undefined || body.application_id === null || body.application_id === ""
    ? null
    : typeof body.application_id === "string" && isUuid(body.application_id) ? body.application_id : null;
  if (body.application_id !== undefined && requestedApplicationId === null) return json({ error: "application_id must be a UUID" }, 400);
  const dryRun = body.dry_run === true;
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const adminClient = createClient<any>(supabaseUrl, privilegedKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = {
    run_id: runId,
    status: "completed",
    dry_run: dryRun,
    messages_scanned: 0,
    applications_considered: 0,
    applications_updated: 0,
    follow_up_drafts_created: 0,
    duplicates_ignored: 0,
    errors: [] as string[],
    actions: [] as Array<{ application_id: string; kind: string }>,
  };

  async function persistRun(status: string): Promise<void> {
    result.status = status;
    await logRun(adminClient, {
      run_id: runId,
      user_id: ownerId,
      provider: GMAIL_PROVIDER,
      dry_run: dryRun,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status,
      messages_scanned: result.messages_scanned,
      applications_considered: result.applications_considered,
      applications_updated: result.applications_updated,
      follow_up_drafts_created: result.follow_up_drafts_created,
      duplicates_ignored: result.duplicates_ignored,
      errors: result.errors,
      summary: safeSummary(dryRun, result.errors),
    });
  }

  try {
    const applications = await applicationsFor(adminClient, ownerId, requestedApplicationId);
    result.applications_considered = applications.length;
    if (!applications.length) {
      await persistRun("completed");
      return json(result);
    }

    const current = await providerConnection(adminClient, ownerId);
    if (!current || current.provider !== GMAIL_PROVIDER || current.status !== "connected" || !scopesAllowReadOnly(current.scopes)) {
      result.errors.push("provider_not_connected");
      await persistRun("skipped");
      return json({ ...result, error: "Provider is not connected for read-only monitoring" }, 409);
    }

    const tokenState = await accessTokenFor(adminClient, ownerId, current);
    const messages = await listGmailMessages(tokenState.accessToken, applications);
    result.messages_scanned = messages.length;
    const actions = actionsFor(applications, messages, tokenState.connection.account_email);
    result.actions = actions.map((action) => ({ application_id: action.application.id, kind: action.kind }));

    for (const action of actions) {
      if (action.kind === "reply" && action.message) {
        const receivedAt = messageReceivedAt(action.message);
        if (dryRun) continue;
        const updated = await adminClient.rpc("automation_update_application", {
          p_payload: {
            user_id: ownerId,
            application_id: action.application.id,
            application_status: "replied",
            last_response_at: receivedAt,
            provider: GMAIL_PROVIDER,
            provider_message_id: action.message.id,
            provider_thread_id: action.message.threadId,
            message_received_at: receivedAt,
          },
        });
        if (updated.error) throw new MonitorError("application_update_rejected", 502);
        const updateResult = firstRow<JsonObject>(updated.data);
        if (updateResult?.duplicate === true) result.duplicates_ignored += 1;
        else result.applications_updated += 1;
      } else if (action.kind === "follow_up") {
        if (dryRun) continue;
        const version = await nextDraftVersion(adminClient, ownerId, action.application);
        const updated = await adminClient.rpc("automation_update_application", {
          p_payload: {
            user_id: ownerId,
            application_id: action.application.id,
            application_status: "follow_up_needed",
            follow_up_draft: {
              version,
              is_current: true,
              recipient: action.application.recipient_email,
              subject: action.application.email_subject?.trim() ? `Re: ${cleanText(action.application.email_subject, 240)}` : `Following up — ${cleanText(action.application.position, 180)}`,
              body: followUpBody(action.application),
            },
          },
        });
        if (updated.error) throw new MonitorError("follow_up_draft_rejected", 502);
        result.applications_updated += 1;
        result.follow_up_drafts_created += 1;
      }
    }

    await persistRun(result.errors.length ? "partial" : "completed");
    return json(result);
  } catch (error) {
    const monitorError = error instanceof MonitorError ? error : new MonitorError("monitor_failed", 502);
    if (monitorError.code === "gmail_unauthorized" || monitorError.code === "gmail_read_failed") {
      await markProviderError(adminClient, ownerId);
    }
    result.errors.push(monitorError.code);
    try {
      await persistRun("failed");
    } catch {
      // Keep the response safe even when the run logger is unavailable.
    }
    return json({ ...result, error: monitorError.code }, monitorError.status);
  }
});
