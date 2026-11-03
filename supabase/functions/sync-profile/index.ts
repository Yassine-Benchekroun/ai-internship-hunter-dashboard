import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const MAX_BODY_BYTES = 64_000;
const MAX_SOURCE_BYTES = 1_500_000;
const MAX_FACTS = 500;
const SOURCE_TIMEOUT_MS = 15_000;

type ApprovedSource = {
  source_type: string;
  source_name: string;
  source_url: string;
};

type Evidence = {
  source_type: string;
  source_name: string;
  source_url: string;
  evidence: string;
};

type ProfileFact = {
  category: string;
  name: string;
  description?: string;
  verification_status: "verified" | "needs_review" | "source_missing" | "unverified";
  evidence: Evidence[];
};

type SourceResult = {
  source_type: string;
  source_name: string;
  source_url: string;
  status: "completed" | "failed" | "unsupported";
  records_discovered: number;
  error?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function keyFromSecretMap(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.default === "string" && parsed.default ? parsed.default : null;
  } catch {
    return null;
  }
}

function serviceKey(): string | null {
  return keyFromSecretMap(Deno.env.get("SUPABASE_SECRET_KEYS"))
    ?? Deno.env.get("SUPABASE_SECRET_KEY")
    ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    ?? null;
}

function publishableKey(): string | null {
  return keyFromSecretMap(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"))
    ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
    ?? Deno.env.get("SUPABASE_ANON_KEY")
    ?? null;
}

function authorizationHeader(request: Request): string | null {
  const value = request.headers.get("Authorization")?.trim() ?? "";
  return /^Bearer\s+\S+$/i.test(value) ? value : null;
}

function canonicalSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function sourceKey(source: ApprovedSource): string {
  return [source.source_type.trim().toLowerCase(), source.source_name.trim().toLowerCase(), canonicalSourceUrl(source.source_url)?.toLowerCase() ?? source.source_url.trim().toLowerCase()].join("|");
}

function factKey(category: string, name: string): string {
  return `${category.trim().toLowerCase().replace(/[\s_-]+/g, " ")}|${name.trim().toLowerCase().replace(/[\s_.-]+/g, "")}`;
}

function cleanText(value: unknown, maxLength = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => cleanText(value, 100)).filter(Boolean))];
}

function addFact(facts: Map<string, ProfileFact>, fact: ProfileFact): void {
  const key = factKey(fact.category, fact.name);
  const existing = facts.get(key);
  if (!existing) {
    facts.set(key, fact);
    return;
  }
  existing.description = existing.description || fact.description;
  for (const evidence of fact.evidence) {
    if (!existing.evidence.some((item) => item.source_type === evidence.source_type && item.source_name === evidence.source_name && item.source_url === evidence.source_url)) {
      existing.evidence.push(evidence);
    }
  }
}

function evidenceFor(source: ApprovedSource, text: string): Evidence {
  return {
    source_type: source.source_type,
    source_name: source.source_name,
    source_url: source.source_url,
    evidence: cleanText(text),
  };
}

async function fetchText(url: string, headers: HeadersInit = {}, maxBytes = MAX_SOURCE_BYTES): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) throw new Error("Source response is too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Source response is too large");
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string, headers: HeadersInit = {}): Promise<unknown> {
  const text = await fetchText(url, headers, MAX_SOURCE_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Source returned invalid JSON");
  }
}

function githubOwner(sourceUrl: string): string | null {
  const url = new URL(sourceUrl);
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || !/^[A-Za-z0-9-]+$/.test(segments[0])) return null;
  return segments[0];
}

async function syncGithub(source: ApprovedSource, facts: Map<string, ProfileFact>): Promise<number> {
  const owner = githubOwner(source.source_url);
  if (!owner) throw new Error("GitHub source must be a public profile URL");
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ai-internship-hunter-profile-sync",
  };
  const [profile, repositories] = await Promise.all([
    fetchJson(`https://api.github.com/users/${encodeURIComponent(owner)}`, headers),
    fetchJson(`https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`, headers),
  ]);
  if (!profile || typeof profile !== "object" || !Array.isArray(repositories)) throw new Error("GitHub source returned an unexpected shape");

  const repositoryFacts = (repositories as Array<Record<string, unknown>>)
    .filter((repository) => repository && typeof repository.name === "string" && repository.archived !== true)
    .slice(0, 80);
  for (const repository of repositoryFacts) {
    const repositoryName = cleanText(repository.name, 120);
    const repositoryUrl = typeof repository.html_url === "string" ? repository.html_url : source.source_url;
    const description = cleanText(repository.description, 300);
    addFact(facts, {
      category: "project",
      name: repositoryName,
      description: description || "Public GitHub repository.",
      verification_status: "verified",
      evidence: [evidenceFor(source, `Public GitHub repository ${repositoryUrl}${description ? `: ${description}` : "."}`)],
    });

    const language = cleanText(repository.language, 80);
    if (language) {
      addFact(facts, {
        category: "technology",
        name: language,
        description: `Primary language reported by the public GitHub repository ${repositoryName}.`,
        verification_status: "verified",
        evidence: [evidenceFor(source, `GitHub reports ${language} as the primary language for ${repositoryUrl}.`)],
      });
    }
    for (const topic of uniqueStrings(Array.isArray(repository.topics) ? repository.topics : [])) {
      if (["github", "repository", "portfolio", "project"].includes(topic.toLowerCase())) continue;
      addFact(facts, {
        category: "skill",
        name: topic,
        description: `GitHub topic attached to the public repository ${repositoryName}.`,
        verification_status: "verified",
        evidence: [evidenceFor(source, `GitHub lists ${topic} as a topic for ${repositoryUrl}.`)],
      });
    }
  }
  return repositoryFacts.length;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function visibleHtmlText(html: string): string {
  return decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const portfolioTerms = [
  "Python", "JavaScript", "TypeScript", "React", "Next.js", "Node.js", "SQL", "PostgreSQL", "Supabase",
  "Docker", "Git", "GitHub", "Machine Learning", "Computer Vision", "TensorFlow", "PyTorch", "OpenCV",
  "scikit-learn", "FastAPI", "Django", "Pandas", "NumPy", "AWS", "Azure", "Google Cloud",
];

async function syncPortfolio(source: ApprovedSource, facts: Map<string, ProfileFact>): Promise<number> {
  const html = await fetchText(source.source_url, { Accept: "text/html" });
  const text = visibleHtmlText(html);
  if (!text) throw new Error("Portfolio returned no readable text");
  let discovered = 0;
  for (const term of portfolioTerms) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i");
    if (!pattern.test(text)) continue;
    addFact(facts, {
      category: "technology",
      name: term,
      description: "Technology explicitly mentioned in the approved portfolio.",
      verification_status: "verified",
      evidence: [evidenceFor(source, `The approved portfolio explicitly mentions ${term}.`)],
    });
    discovered += 1;
  }
  return discovered;
}

function normalizedSources(value: unknown): ApprovedSource[] {
  if (!Array.isArray(value)) return [];
  const output: ApprovedSource[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const sourceType = cleanText(record.source_type, 40).toLowerCase();
    const sourceName = cleanText(record.source_name, 160);
    const sourceUrl = canonicalSourceUrl(record.source_url);
    if (!sourceType || !sourceName || !sourceUrl || !["github", "portfolio"].includes(sourceType)) continue;
    const source = { source_type: sourceType, source_name: sourceName, source_url: sourceUrl };
    const key = sourceKey(source);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(source);
    }
  }
  return output;
}

async function readExistingFacts(adminClient: ReturnType<typeof createClient>, userId: string, successfulSources: ApprovedSource[], currentFacts: Map<string, ProfileFact>): Promise<ProfileFact[]> {
  if (!successfulSources.length) return [];
  const [{ data: facts, error: factsError }, { data: evidence, error: evidenceError }] = await Promise.all([
    adminClient.from("profile_facts").select("id, category, name, normalized_name").eq("user_id", userId),
    adminClient.from("profile_fact_evidence").select("fact_id, source_type, source_name, source_url").eq("user_id", userId),
  ]);
  if (factsError || evidenceError) throw new Error("Unable to inspect existing profile evidence");
  const successfulKeys = new Set(successfulSources.map(sourceKey));
  const evidenceByFact = new Map<string, Array<Record<string, unknown>>>();
  for (const row of (evidence ?? []) as Array<Record<string, unknown>>) {
    const source = {
      source_type: cleanText(row.source_type, 40),
      source_name: cleanText(row.source_name, 160),
      source_url: cleanText(row.source_url, 500),
    };
    if (!successfulKeys.has(sourceKey(source))) continue;
    const factId = cleanText(row.fact_id, 100);
    if (!factId) continue;
    const rows = evidenceByFact.get(factId) ?? [];
    rows.push(row);
    evidenceByFact.set(factId, rows);
  }
  const missing: ProfileFact[] = [];
  for (const row of (facts ?? []) as Array<Record<string, unknown>>) {
    const factId = cleanText(row.id, 100);
    const category = cleanText(row.category, 100);
    const name = cleanText(row.name, 200);
    if (!factId || !category || !name || !evidenceByFact.has(factId)) continue;
    const key = factKey(category, name);
    if (currentFacts.has(key)) continue;
    missing.push({ category, name, verification_status: "source_missing", evidence: [] });
  }
  return missing;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  if (!raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object");
  return value as Record<string, unknown>;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported" }, 405);

  const authHeader = authorizationHeader(request);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = publishableKey();
  const privilegedKey = serviceKey();
  if (!authHeader || !supabaseUrl || !publicKey || !privilegedKey) return json({ error: "Profile sync is not configured" }, 503);

  try {
    const body = await readBody(request);
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const userClient = createClient(supabaseUrl, publicKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "Unauthorized" }, 401);

    const userId = userData.user.id;
    if (typeof body.user_id === "string" && body.user_id !== userId) return json({ error: "Profile sync is scoped to the signed-in account" }, 403);

    const adminClient = createClient(supabaseUrl, privilegedKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: settings, error: settingsError } = await adminClient.rpc("automation_read_settings", { p_user_id: userId });
    if (settingsError || !settings || typeof settings !== "object") return json({ error: "No backend settings found for the signed-in account" }, 403);

    const sources = normalizedSources((settings as Record<string, unknown>).approved_profile_sources);
    if (!sources.length) return json({ error: "No supported approved profile sources are configured" }, 409);

    const facts = new Map<string, ProfileFact>();
    const sourceResults: SourceResult[] = [];
    const errors: string[] = [];
    const successfulSources: ApprovedSource[] = [];
    for (const source of sources) {
      const { data: approved, error: approvalError } = await adminClient.rpc("is_approved_profile_source", {
        p_user_id: userId,
        p_source_type: source.source_type,
        p_source_name: source.source_name,
        p_source_url: source.source_url,
      });
      if (approvalError || approved !== true) {
        const message = `${source.source_name}: source is not approved by backend settings`;
        sourceResults.push({ ...source, status: "failed", records_discovered: 0, error: message });
        errors.push(message);
        continue;
      }
      try {
        const discovered = source.source_type === "github"
          ? await syncGithub(source, facts)
          : await syncPortfolio(source, facts);
        successfulSources.push(source);
        sourceResults.push({ ...source, status: "completed", records_discovered: discovered });
      } catch (error) {
        const message = `${source.source_name}: ${cleanText(error instanceof Error ? error.message : "source fetch failed", 240)}`;
        sourceResults.push({ ...source, status: "failed", records_discovered: 0, error: message });
        errors.push(message);
      }
    }

    const missingFacts = await readExistingFacts(adminClient, userId, successfulSources, facts);
    const factsPayload = [...facts.values()].slice(0, MAX_FACTS);
    const missingPayload = missingFacts.slice(0, MAX_FACTS).map(({ category, name }) => ({ category, name }));
    const status = errors.length === 0 ? "completed" : successfulSources.length ? "partial" : "failed";
    const payload = {
      user_id: userId,
      status,
      sources_checked: sourceResults,
      facts: factsPayload,
      missing_facts: missingPayload,
      errors,
      summary: `${status === "completed" ? "Profile sync completed" : "Profile sync completed with source errors"}; ${factsPayload.length} facts discovered from ${successfulSources.length} approved source(s).`,
    };
    const { data: syncResult, error: syncError } = await adminClient.rpc("automation_sync_profile", { p_payload: payload });
    if (syncError) return json({ error: "Profile sync rejected by backend contract" }, 400);
    return json({ ...syncResult, sources_checked: sourceResults, errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile sync failed";
    if (["Request body is too large", "Request body must be valid JSON", "Request body must be a JSON object"].includes(message)) return json({ error: message }, 400);
    return json({ error: "Profile sync failed" }, 500);
  }
});
