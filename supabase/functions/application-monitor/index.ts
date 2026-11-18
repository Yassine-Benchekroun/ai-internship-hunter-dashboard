import { authorizeSchedule, beginRun, finishRun, errorResponse } from "../_shared/schedule.ts";

const GMAIL_PROVIDER = "gmail";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MAX_MESSAGES = 50;
const GOOGLE_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_PAGES = 4;
const APPLICATION_PAGE_SIZE = 100;
const MAX_APPLICATION_PAGES = 10;
const ACTIVE_STATES = ["sent", "already_sent", "waiting", "no_response", "follow_up_needed", "replied", "interview"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

type JsonObject = Record<string, unknown>;
type AdminClient = any;

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
  last_response_at: string | null;
  notes: string | null;
  provider_thread_id?: string | null;
  provider_message_id?: string | null;
};

type GmailMessage = {
  id: string;
  threadId: string | null;
  internalDate: string | null;
  headers: Record<string, string>;
};

type MonitorAction = {
  application: ApplicationRecord;
  kind: "reply" | "follow_up" | "review" | "waiting";
  message: GmailMessage | null;
  status?: string;
  followUpAt?: string;
  followUpKey?: string;
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

export function scopesAllowReadOnly(scopes: unknown): boolean {
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
  if (!scopesAllowReadOnly(scopes)) throw new MonitorError("provider_scope_invalid", 409);
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

export function emailAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  const address = cleanText(angle?.[1] ?? value, 320).toLowerCase();
  return /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(address) ? address : "";
}

export function normalizedSubject(value: string): string {
  return cleanText(value, 500).replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").toLowerCase();
}

export function messageReceivedAt(message: GmailMessage): string | null {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const parsed = Date.parse(message.headers.date ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function deliveredTo(message: GmailMessage, accountEmail: string): boolean {
  const addresses = `${message.headers.to ?? ""},${message.headers.cc ?? ""},${message.headers["delivered-to"] ?? ""}`
    .split(",").map(emailAddress).filter(Boolean);
  return addresses.includes(accountEmail.toLowerCase());
}

export function matchesApplication(application: ApplicationRecord, message: GmailMessage, accountEmail: string): boolean {
  const from = emailAddress(message.headers.from ?? "");
  const recipient = emailAddress(application.recipient_email ?? "");
  const received = Date.parse(messageReceivedAt(message) ?? "");
  const sent = Date.parse(application.sent_at ?? "");
  if (!from || !recipient || from !== recipient || from === accountEmail.toLowerCase() || !deliveredTo(message, accountEmail)) return false;
  if (!Number.isFinite(received) || !Number.isFinite(sent) || received <= sent) return false;
  if (application.provider_thread_id && message.threadId === application.provider_thread_id) return true;
  const subject = normalizedSubject(application.email_subject ?? "");
  return Boolean(subject && normalizedSubject(message.headers.subject ?? "") === subject);
}

function plausibleApplication(application: ApplicationRecord, message: GmailMessage, accountEmail: string): boolean {
  const sent = Date.parse(application.sent_at ?? "");
  const received = Date.parse(messageReceivedAt(message) ?? "");
  const subject = normalizedSubject(message.headers.subject ?? "");
  const distinctive = `${application.organization} ${application.position}`.toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !["application", "internship", "research", "intern", "with", "the"].includes(word));
  const related = Boolean(application.provider_thread_id && message.threadId === application.provider_thread_id) ||
    distinctive.some((word) => subject.includes(word));
  return Boolean(emailAddress(application.recipient_email ?? "") &&
    emailAddress(message.headers.from ?? "") === emailAddress(application.recipient_email ?? "") &&
    deliveredTo(message, accountEmail) && related && Number.isFinite(sent) && Number.isFinite(received) && received > sent);
}

// Metadata only: an ordinary reply stays Replied. An explicit, new subject can
// identify a lifecycle event; vague, conflicting or negated language never does.
export function classifyResponse(message: GmailMessage, application: ApplicationRecord): string {
  const subject = normalizedSubject(message.headers.subject ?? "");
  if (subject === normalizedSubject(application.email_subject ?? "") || /\b(no|not|cancelled|canceled|possible|potential)\b/.test(subject)) return "replied";
  const matches = [
    [/\binterview invitation\b|\binvitation to interview\b/, "interview"],
    [/\b(?:internship|employment|job|research) offer\b|\boffer letter\b/, "offer"],
    [/\bapplication rejected\b|\bapplication unsuccessful\b/, "rejected"],
    [/\bposition closed\b|\bapplication closed\b/, "closed"],
  ].filter(([pattern]) => (pattern as RegExp).test(subject));
  return matches.length === 1 ? matches[0][1] as string : "replied";
}

export type MailboxScan = { messages: GmailMessage[]; complete: boolean; error?: string };
type GmailReader = (token: string, path: string, params: URLSearchParams) => Promise<JsonObject>;

export async function listApplicationMessages(accessToken: string, application: ApplicationRecord, reader: GmailReader = gmailJson, deadline = Date.now() + 95_000): Promise<MailboxScan> {
  const recipient = emailAddress(application.recipient_email ?? "");
  const sent = Date.parse(application.sent_at ?? "");
  if (!recipient || !Number.isFinite(sent) || !normalizedSubject(application.email_subject ?? "")) {
    return { messages: [], complete: false, error: "application_identifiers_missing" };
  }
  // Unix timestamps avoid Gmail's date-string timezone interpretation. Only
  // messages from this application's known contact are considered.
  const query = `from:(${recipient}) after:${Math.floor(sent / 1000)} -in:sent -in:drafts`;
  const messages = new Map<string, GmailMessage>();
  let pageToken = "";
  const seenTokens = new Set<string>();
  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    if (Date.now() >= deadline) break;
    const params = new URLSearchParams({ maxResults: String(MAX_MESSAGES), q: query, includeSpamTrash: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const list = await reader(accessToken, "messages", params);
    if (list.messages !== undefined && !Array.isArray(list.messages)) throw new MonitorError("gmail_message_list_invalid", 502);
    const refs = (list.messages ?? []) as Array<Record<string, unknown>>;
    for (const ref of refs) {
      if (Date.now() >= deadline) return { messages: [...messages.values()], complete: false, error: "mailbox_scan_incomplete" };
      if (typeof ref.id !== "string" || !ref.id || messages.has(ref.id)) continue;
      const detail = await reader(accessToken, `messages/${encodeURIComponent(ref.id)}`, new URLSearchParams([
        ["format", "metadata"], ["metadataHeaders", "From"], ["metadataHeaders", "To"],
        ["metadataHeaders", "Cc"], ["metadataHeaders", "Subject"], ["metadataHeaders", "Date"],
        ["metadataHeaders", "In-Reply-To"], ["metadataHeaders", "References"], ["metadataHeaders", "Delivered-To"],
      ]));
      const message = messageFromPayload(detail);
      if (!message) throw new MonitorError("gmail_message_metadata_invalid", 502);
      messages.set(message.id, message);
    }
    pageToken = typeof list.nextPageToken === "string" ? list.nextPageToken : "";
    if (!pageToken) return { messages: [...messages.values()], complete: true };
    if (seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);
  }
  return { messages: [...messages.values()], complete: false, error: "mailbox_scan_incomplete" };
}

export function actionsFor(applications: ApplicationRecord[], scans: Map<string, MailboxScan>, accountEmail: string,
  followUpDays: number, now = Date.now()): { actions: MonitorAction[]; ambiguousMessages: number } {
  const messages = new Map<string, GmailMessage>();
  for (const scan of scans.values()) for (const message of scan.messages) messages.set(message.id, message);
  const assigned = new Map<string, GmailMessage[]>();
  const ambiguousApps = new Set<string>();
  const ambiguousIds = new Set<string>();
  for (const message of messages.values()) {
    const matches = applications.filter((application) => matchesApplication(application, message, accountEmail));
    const plausible = applications.filter((application) => plausibleApplication(application, message, accountEmail));
    if (matches.length === 1) {
      const list = assigned.get(matches[0].id) ?? [];
      list.push(message);
      assigned.set(matches[0].id, list);
    } else if (matches.length > 1 || plausible.length) {
      ambiguousIds.add(message.id);
      for (const application of matches.length ? matches : plausible) ambiguousApps.add(application.id);
    }
  }
  const actions: MonitorAction[] = [];
  for (const application of applications) {
    const scan = scans.get(application.id);
    // No no-reply conclusions or follow-ups when any portion of the search failed.
    if (!scan?.complete) continue;
    if (ambiguousApps.has(application.id)) {
      actions.push({ application, kind: "review", message: null });
      continue;
    }
    const replies = (assigned.get(application.id) ?? [])
      .sort((a, b) => Date.parse(messageReceivedAt(b)!) - Date.parse(messageReceivedAt(a)!));
    if (replies.length) {
      const lastResponse = Date.parse(application.last_response_at ?? "");
      const latest = replies[0];
      if (!Number.isFinite(lastResponse) || Date.parse(messageReceivedAt(latest)!) >= lastResponse) {
        actions.push({ application, kind: "reply", message: latest, status: classifyResponse(latest, application) });
      }
      continue;
    }
    if (application.last_response_at || !["sent", "already_sent", "waiting", "no_response", "follow_up_needed"].includes(application.application_status)) continue;
    const sent = Date.parse(application.sent_at ?? "");
    const due = application.follow_up_at ? Date.parse(application.follow_up_at) : sent + followUpDays * 86_400_000;
    if (!Number.isFinite(sent) || !Number.isFinite(due) || sent > now) continue;
    const followUpAt = new Date(due).toISOString();
    if (due <= now) {
      actions.push({ application, kind: "follow_up", message: null, followUpAt,
        followUpKey: `followup:${application.id}:${new Date(sent).toISOString()}:${followUpAt}` });
    } else if (application.application_status !== "waiting" || !application.follow_up_at) {
      actions.push({ application, kind: "waiting", message: null, followUpAt });
    }
  }
  return { actions, ambiguousMessages: ambiguousIds.size };
}

export function followUpBody(application: ApplicationRecord, senderName: string): string {
  const organization = cleanText(application.organization, 200);
  const position = cleanText(application.position, 200);
  return `Hello,\n\nI’m following up on my application for ${position} at ${organization}. I remain interested in the opportunity and would appreciate any update when convenient.\n\nThank you for your time.\n\nBest regards,\n${cleanText(senderName, 160)}`;
}

async function applicationsFor(admin: AdminClient, userId: string, includeTerminal: boolean): Promise<ApplicationRecord[]> {
  const applications: ApplicationRecord[] = [];
  for (let page = 0; page < MAX_APPLICATION_PAGES; page += 1) {
    let query = admin.from("application_records")
      .select("id, opportunity_id, organization, position, recipient_email, email_subject, sent_at, application_status, follow_up_at, last_response_at, notes, provider_thread_id, provider_message_id")
      .eq("user_id", userId).order("id").range(page * APPLICATION_PAGE_SIZE, (page + 1) * APPLICATION_PAGE_SIZE - 1);
    query = query.in("application_status", includeTerminal ? [...ACTIVE_STATES, "offer", "rejected", "closed"] : ACTIVE_STATES);
    const result = await query;
    if (result.error) throw new MonitorError("application_lookup_failed", 502);
    const rows = result.data ?? [];
    applications.push(...rows);
    if (rows.length < APPLICATION_PAGE_SIZE) return applications;
  }
  throw new MonitorError("application_scan_limit_reached", 409);
}

const REVIEW_NOTE = "Mailbox correlation requires manual review; no application status was inferred.";

export async function applyAction(admin: AdminClient, userId: string, action: MonitorAction, senderName: string): Promise<JsonObject> {
  const payload: JsonObject = { user_id: userId, application_id: action.application.id };
  if (action.kind === "reply" && action.message) {
    Object.assign(payload, { application_status: action.status ?? "replied", last_response_at: messageReceivedAt(action.message),
      provider: GMAIL_PROVIDER, provider_message_id: action.message.id, provider_thread_id: action.message.threadId,
      message_received_at: messageReceivedAt(action.message) });
  } else if (action.kind === "follow_up") {
    if (!senderName.trim()) throw new MonitorError("verified_sender_identity_missing", 409);
    Object.assign(payload, { application_status: "follow_up_needed", follow_up_at: action.followUpAt, follow_up_key: action.followUpKey,
      follow_up_draft: { is_current: true, recipient: emailAddress(action.application.recipient_email ?? ""),
        subject: `Re: ${cleanText(action.application.email_subject, 240)}`, body: followUpBody(action.application, senderName) } });
  } else if (action.kind === "review") {
    if (action.application.notes?.includes(REVIEW_NOTE)) return { duplicate: true };
    Object.assign(payload, { application_status: action.application.application_status, needs_review: true,
      notes: [action.application.notes, REVIEW_NOTE].filter(Boolean).join("\n") });
  } else {
    Object.assign(payload, { application_status: "waiting", follow_up_at: action.followUpAt });
  }
  const result = await admin.rpc("automation_update_application", { p_payload: payload });
  if (result.error) throw new MonitorError("application_update_rejected", 502);
  return firstRow<JsonObject>(result.data) ?? {};
}

export async function runMonitor(admin: AdminClient, userId: string, body: JsonObject, run: any): Promise<Response> {
  const counts = { processed_records: 0, inserted_count: 0, updated_count: 0, duplicate_count: 0, warning_count: 0,
    applications_inspected: 0, replies_found: 0, statuses_updated: 0, interviews: 0, offers: 0, rejections: 0,
    follow_ups_required: 0, drafts_created: 0, ambiguous_messages: 0, messages_scanned: 0 };
  const errors: string[] = [];
  const dryRun = body.dry_run === true;
  const startedAt = new Date().toISOString();
  let finalStatus = "failed";
  async function complete(status: string, httpStatus = 200): Promise<Response> {
    finalStatus = status;
    const legacy = await admin.rpc("automation_log_application_monitor_run", { p_payload: {
      run_id: run.run_id, user_id: userId, provider: GMAIL_PROVIDER, dry_run: dryRun,
      started_at: startedAt, completed_at: new Date().toISOString(), status,
      applications_considered: counts.applications_inspected, applications_updated: counts.statuses_updated,
      follow_up_drafts_created: counts.drafts_created, duplicates_ignored: counts.duplicate_count,
      messages_scanned: counts.messages_scanned, errors, summary: `Application monitoring ${status}; drafts only.`,
    } });
    if (legacy.error) { errors.push("monitor_history_write_failed"); if (status === "completed") status = "partial"; }
    await finishRun(admin, run, status, { ...counts, follow_up_drafts_created: counts.drafts_created }, errors);
    return json({ run_id: run.run_id, status, dry_run: dryRun, counts, errors }, httpStatus);
  }
  try {
    // The shared schedule row was created before entering this function.
    const [{ data: settingsData, error: settingsError }, { data: configData, error: configError }] = await Promise.all([
      admin.rpc("automation_read_settings", { p_user_id: userId }),
      admin.rpc("automation_read_schedule_config", { p_user_id: userId }),
    ]);
    const settings = firstRow<JsonObject>(settingsData);
    const config = firstRow<JsonObject>(configData);
    if (settingsError || configError || !settings || !config) throw new MonitorError("monitor_configuration_unavailable", 409);
    const followUpDays = Number(config.follow_up_days);
    if (!Number.isInteger(followUpDays) || followUpDays < 1 || followUpDays > 365) throw new MonitorError("follow_up_interval_invalid", 409);
    const current = await providerConnection(admin, userId);
    if (settings.provider_connection_status !== "connected" || !current || current.provider !== GMAIL_PROVIDER ||
      current.status !== "connected" || !emailAddress(current.account_email ?? "") || !scopesAllowReadOnly(current.scopes)) {
      errors.push("provider_not_connected");
      return await complete("blocked", 409);
    }
    const tokenState = await accessTokenFor(admin, userId, current);
    const accountEmail = emailAddress(tokenState.connection.account_email ?? "");
    // Load the complete active set even for a controlled single-application run:
    // otherwise ambiguous replies shared by two applications could look unique.
    const allApplications = await applicationsFor(admin, userId, config.monitor_terminal === true);
    const requestedId = body.application_id;
    if (requestedId !== undefined && !isUuid(requestedId)) throw new MonitorError("application_id_invalid", 400);
    if (requestedId && !allApplications.some((application) => application.id === requestedId)) throw new MonitorError("application_unavailable", 409);
    const selected = requestedId ? allApplications.filter((application) => application.id === requestedId) : allApplications;
    counts.applications_inspected = selected.length;
    const scans = new Map<string, MailboxScan>();
    const deadline = Date.now() + 95_000;
    for (const application of selected) {
      if (Date.now() >= deadline) { errors.push("monitor_time_budget_reached"); break; }
      try {
        const scan = await listApplicationMessages(tokenState.accessToken, application, gmailJson, deadline);
        scans.set(application.id, scan);
        counts.processed_records += 1;
        counts.messages_scanned += scan.messages.length;
        if (!scan.complete) { errors.push(scan.error ?? "mailbox_scan_incomplete"); counts.warning_count += 1; }
      } catch (error) {
        const code = error instanceof MonitorError ? error.code : "mailbox_scan_failed";
        errors.push(code);
        scans.set(application.id, { messages: [], complete: false });
        if (code === "gmail_unauthorized") { await markProviderError(admin, userId); break; }
      }
    }
    const planned = actionsFor(allApplications, scans, accountEmail, followUpDays);
    counts.ambiguous_messages = planned.ambiguousMessages;
    counts.warning_count += planned.ambiguousMessages;
    for (const action of planned.actions) {
      if (action.kind === "reply") counts.replies_found += 1;
      if (action.kind === "follow_up") counts.follow_ups_required += 1;
      if (dryRun) continue;
      try {
        const result = await applyAction(admin, userId, action, cleanText(settings.sender_identity_name, 160));
        if (result.duplicate === true) { counts.duplicate_count += 1; continue; }
        if (result.status_updated !== false) counts.updated_count += 1;
        if (action.kind !== "review" && result.status_updated !== false) counts.statuses_updated += 1;
        if (action.kind === "follow_up" && result.follow_up_draft_id) { counts.drafts_created += 1; counts.inserted_count += 1; }
        if (action.kind === "reply") {
          counts.inserted_count += 1;
          if (action.status === "interview") counts.interviews += 1;
          if (action.status === "offer") counts.offers += 1;
          if (action.status === "rejected") counts.rejections += 1;
        }
      } catch (error) { errors.push(error instanceof MonitorError ? error.code : "application_update_failed"); }
    }
    return await complete(errors.length || counts.ambiguous_messages ? "partial" : "completed");
  } catch (error) {
    const safe = error instanceof MonitorError ? error : new MonitorError("monitor_failed", 502);
    errors.push(safe.code);
    try { return await complete(safe.status === 409 ? "blocked" : "failed", safe.status); }
    catch { return json({ run_id: run.run_id, status: finalStatus, error: "monitor_run_finalize_failed" }, 502); }
  }
}

export async function handleMonitorRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    // authorizeSchedule verifies auth.getUser(token) for browser calls and a
    // private configured credential for scheduler calls; it rejects user_id.
    const { admin, userId, body } = await authorizeSchedule(request, "application_monitor");
    const run = await beginRun(admin, userId, "application_monitor", body);
    if (!run.acquired) return json({ run_id: run.run_id, status: run.status, duplicate: true });
    return await runMonitor(admin, userId, body, run);
  } catch (error) { return errorResponse(error); }
}

if (import.meta.main) Deno.serve(handleMonitorRequest);
