import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const GMAIL_PROVIDER = "gmail";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16_000;
const GOOGLE_TIMEOUT_MS = 15_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

type JsonObject = Record<string, unknown>;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
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

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return isObject(value) ? value as T : null;
}

function cleanAction(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isSafeConfiguredUrl(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonBody(request: Request): Promise<JsonObject> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("body_too_large");
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error("body_must_be_object");
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

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
}

async function googleTokenRequest(params: Record<string, string>): Promise<JsonObject> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: withTimeout(),
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok || !isObject(parsed)) throw new Error("google_token_exchange_failed");
  return parsed;
}

function accessTokenFrom(response: JsonObject): string {
  const token = response.access_token;
  if (typeof token !== "string" || token.length < 10 || token.length > 4096) throw new Error("google_access_token_missing");
  return token;
}

function refreshTokenFrom(response: JsonObject): string | null {
  const token = response.refresh_token;
  if (token === undefined || token === null || token === "") return null;
  if (typeof token !== "string" || token.length < 10 || token.length > 4096) throw new Error("google_refresh_token_invalid");
  return token;
}

function expiresAtFrom(response: JsonObject): string {
  const seconds = Number(response.expires_in);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86_400) throw new Error("google_token_expiry_invalid");
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}

function scopesFrom(response: JsonObject, fallback: string[] = [GMAIL_SCOPE]): string[] {
  if (typeof response.scope === "string") {
    const scopes = [...new Set(response.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
    if (scopes.length) return scopes.slice(0, 20);
  }
  return fallback.slice(0, 20);
}

async function gmailAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: withTimeout(),
  });
  const parsed: unknown = await response.json().catch(() => null);
  const email = isObject(parsed) && typeof parsed.emailAddress === "string" ? parsed.emailAddress.trim() : "";
  if (!response.ok || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("gmail_profile_failed");
  return email.slice(0, 320);
}

async function revokeGoogleToken(token: string): Promise<boolean> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: withTimeout(),
  });
  // Google returns 400 when a token is already invalid or revoked. Local
  // credentials are cleared in either case.
  return response.ok || response.status === 400;
}

async function connection(adminClient: ReturnType<typeof createClient>, userId: string): Promise<ProviderConnection | null> {
  const result = await adminClient.rpc("provider_oauth_get_connection", { p_user_id: userId });
  if (result.error) throw new Error("connection_lookup_failed");
  return firstRow<ProviderConnection>(result.data);
}

async function markError(adminClient: ReturnType<typeof createClient>, userId: string): Promise<void> {
  await adminClient.rpc("provider_oauth_mark_error", { p_user_id: userId, p_error: "oauth_provider_error" });
}

async function finishCallback(status: "connected" | "denied" | "error"): Promise<Response> {
  const returnUrl = Deno.env.get("OAUTH_RETURN_URL");
  if (isSafeConfiguredUrl(returnUrl)) {
    const target = new URL(returnUrl);
    target.searchParams.set("provider", GMAIL_PROVIDER);
    target.searchParams.set("status", status);
    return new Response(null, {
      status: 303,
      headers: { Location: target.toString(), "Cache-Control": "no-store" },
    });
  }
  return json({ ok: status === "connected", provider: GMAIL_PROVIDER, status }, status === "error" ? 502 : 200);
}

async function handleCallback(request: Request, adminClient: ReturnType<typeof createClient>, clientId: string, clientSecret: string, redirectUri: string): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!state) return json({ error: "OAuth state is missing" }, 400);

  const stateHash = await sha256Hex(state);
  const consumed = await adminClient.rpc("provider_oauth_consume", { p_state_hash: stateHash });
  const stateRow = firstRow<{ user_id: string; provider: string; redirect_uri: string }>(consumed.data);
  if (consumed.error || !stateRow || stateRow.provider !== GMAIL_PROVIDER || stateRow.redirect_uri !== redirectUri) {
    return json({ error: "OAuth state is invalid or expired" }, 400);
  }

  const userId = stateRow.user_id;
  if (url.searchParams.get("error")) {
    await markError(adminClient, userId);
    return finishCallback("denied");
  }

  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code || code.length > 4096) {
    await markError(adminClient, userId);
    return finishCallback("error");
  }

  try {
    const existing = await connection(adminClient, userId);
    const tokenResponse = await googleTokenRequest({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const accessToken = accessTokenFrom(tokenResponse);
    const refreshToken = refreshTokenFrom(tokenResponse) ?? existing?.refresh_token ?? null;
    if (!refreshToken) throw new Error("google_refresh_token_missing");
    const email = await gmailAccountEmail(accessToken);
    const stored = await adminClient.rpc("provider_oauth_store_connection", {
      p_user_id: userId,
      p_provider: GMAIL_PROVIDER,
      p_account_email: email,
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_token_type: typeof tokenResponse.token_type === "string" ? tokenResponse.token_type : "Bearer",
      p_scopes: scopesFrom(tokenResponse),
      p_access_token_expires_at: expiresAtFrom(tokenResponse),
    });
    if (stored.error) throw new Error("connection_store_failed");
    return finishCallback("connected");
  } catch {
    await markError(adminClient, userId);
    return finishCallback("error");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = publishableKey();
  const privilegedKey = serviceKey();
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  const redirectUri = Deno.env.get("OAUTH_REDIRECT_URI")?.trim();
  if (!supabaseUrl || !publicKey || !privilegedKey || !clientId || !clientSecret || !isSafeConfiguredUrl(redirectUri)) {
    return json({ error: "Provider OAuth is not configured" }, 503);
  }

  const adminClient = createClient(supabaseUrl, privilegedKey, { auth: { autoRefreshToken: false, persistSession: false } });

  if (request.method === "GET") {
    if (!new URL(request.url).searchParams.has("state")) return json({ error: "OAuth callback is missing state" }, 400);
    return handleCallback(request, adminClient, clientId, clientSecret, redirectUri);
  }
  if (request.method !== "POST") return json({ error: "Only POST and OAuth callback GET are supported" }, 405);

  let body: JsonObject;
  try {
    body = await readJsonBody(request);
  } catch {
    return json({ error: "Request body must be a small JSON object" }, 400);
  }

  const action = cleanAction(body.action);
  if (!["start", "status", "refresh", "disconnect"].includes(action)) return json({ error: "Unsupported provider OAuth action" }, 400);

  const user = await callerUser(request, supabaseUrl, publicKey);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (action === "start") {
    const state = randomState();
    const stateHash = await sha256Hex(state);
    const stateExpiry = new Date(Date.now() + STATE_TTL_MS).toISOString();
    const started = await adminClient.rpc("provider_oauth_begin", {
      p_user_id: user.id,
      p_provider: GMAIL_PROVIDER,
      p_state_hash: stateHash,
      p_redirect_uri: redirectUri,
      p_expires_at: stateExpiry,
    });
    if (started.error) return json({ error: "Could not start provider OAuth" }, 500);

    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", GMAIL_SCOPE);
    authorization.searchParams.set("access_type", "offline");
    authorization.searchParams.set("include_granted_scopes", "true");
    authorization.searchParams.set("prompt", "consent");
    authorization.searchParams.set("state", state);
    return json({ ok: true, provider: GMAIL_PROVIDER, authorization_url: authorization.toString() });
  }

  let current: ProviderConnection | null;
  try {
    current = await connection(adminClient, user.id);
  } catch {
    return json({ error: "Could not read provider connection" }, 500);
  }

  if (action === "status") {
    return json({
      ok: true,
      provider: GMAIL_PROVIDER,
      status: current?.status ?? "not_connected",
      account_email: current?.account_email ?? null,
      access_token_expires_at: current?.access_token_expires_at ?? null,
      scopes: current?.scopes ?? [],
    });
  }

  if (action === "refresh") {
    if (!current?.refresh_token) return json({ error: "No provider refresh session is available" }, 409);
    try {
      const tokenResponse = await googleTokenRequest({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: current.refresh_token,
        grant_type: "refresh_token",
      });
      const stored = await adminClient.rpc("provider_oauth_store_connection", {
        p_user_id: user.id,
        p_provider: GMAIL_PROVIDER,
        p_account_email: current.account_email,
        p_access_token: accessTokenFrom(tokenResponse),
        p_refresh_token: refreshTokenFrom(tokenResponse),
        p_token_type: typeof tokenResponse.token_type === "string" ? tokenResponse.token_type : current.token_type,
        p_scopes: scopesFrom(tokenResponse, current.scopes),
        p_access_token_expires_at: expiresAtFrom(tokenResponse),
      });
      if (stored.error) throw new Error("connection_store_failed");
      return json({ ok: true, provider: GMAIL_PROVIDER, status: "connected" });
    } catch {
      await markError(adminClient, user.id);
      return json({ error: "Provider session refresh failed" }, 502);
    }
  }

  let remoteRevocationFailed = false;
  const tokenToRevoke = current?.refresh_token ?? current?.access_token ?? null;
  if (tokenToRevoke) {
    try {
      remoteRevocationFailed = !(await revokeGoogleToken(tokenToRevoke));
    } catch {
      remoteRevocationFailed = true;
    }
  }
  const revoked = await adminClient.rpc("provider_oauth_revoke_connection", { p_user_id: user.id });
  if (revoked.error) return json({ error: "Could not disconnect provider" }, 500);
  return json({
    ok: true,
    provider: GMAIL_PROVIDER,
    status: "revoked",
    provider_revocation: remoteRevocationFailed ? "not_confirmed" : "confirmed",
  });
});
