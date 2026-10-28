import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const MAX_BODY_BYTES = 2_000_000;

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
      // Fall through to the supported single-key names.
    }
  }
  return Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported" }, 405);

  const expectedKey = Deno.env.get("INGEST_API_KEY");
  const ownerUserId = Deno.env.get("INGEST_OWNER_USER_ID");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const privilegedKey = serviceKey();
  const suppliedKey = request.headers.get("x-ingest-api-key")?.trim() ?? "";
  if (!expectedKey || !ownerUserId || !supabaseUrl || !privilegedKey) return json({ error: "Ingestion is not configured" }, 503);
  if (!suppliedKey || suppliedKey !== expectedKey) return json({ error: "Unauthorized" }, 401);

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: "Request body is too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Request body must be a JSON object" }, 400);

  const client = createClient(supabaseUrl, privilegedKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const payload = { ...(body as Record<string, unknown>), user_id: ownerUserId };
  const { data, error } = await client.rpc("automation_ingest_opportunities", { p_payload: payload });
  if (error) return json({ error: "Ingestion rejected" }, 400);
  return json(data);
});
