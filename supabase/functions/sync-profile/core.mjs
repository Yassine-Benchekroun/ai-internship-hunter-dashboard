// Deterministic extraction only: source text is data, never worker instructions.
export const MAX_FACTS = 500;
const aliases = new Map([
  ['sklearn', 'scikit-learn'], ['scikitlearn', 'scikit-learn'],
  ['opencv', 'OpenCV'], ['opencvpython', 'OpenCV'],
  ['pytorch', 'PyTorch'], ['tensorflow', 'TensorFlow'], ['python', 'Python'],
  ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['nodejs', 'Node.js'],
  ['nextjs', 'Next.js'], ['numpy', 'NumPy'], ['pandas', 'Pandas'],
]);
const terms = ['Python', 'JavaScript', 'TypeScript', 'React', 'Next.js', 'Node.js', 'SQL',
  'PostgreSQL', 'Supabase', 'Docker', 'Git', 'Machine Learning', 'Computer Vision',
  'TensorFlow', 'PyTorch', 'OpenCV', 'opencv-python', 'scikit-learn', 'scikit learn',
  'sklearn', 'FastAPI', 'Django', 'Pandas', 'NumPy', 'AWS', 'Azure', 'Google Cloud',
  'Keras', 'Hugging Face', 'C++', 'Java', 'Rust', 'Go', 'R', 'MATLAB', 'Arduino',
  'SFML', 'HTML', 'CSS', 'Firebase', 'NoSQL', 'PL/SQL', 'Supervised Learning',
  'Unsupervised Learning', 'Data Scraping', 'Data Cleaning', 'Deep Learning'];

export const cleanText = (value, max = 1500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const normalizeName = (name) => aliases.get(cleanText(name).toLowerCase().replace(/[\s_.-]+/g, '')) ?? cleanText(name, 180);
export const normalizeCategory = (category) => ({ skills: 'skill', technologies: 'technology', libraries: 'library', frameworks: 'framework' })[category.toLowerCase()] ?? category.toLowerCase();
export const factKey = (category, name) => `${normalizeCategory(category)}|${normalizeName(name).toLowerCase().replace(/[\s_.-]+/g, '')}`;

export function isPublicAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  // Only global-unicast IPv6 and public IPv4. IPv4-mapped IPv6 is rejected.
  if (ip.includes(':')) return /^[23][0-9a-f]{0,3}:/.test(ip) && !ip.startsWith('2001:db8:');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ip.split('.').map(Number);
  return n.every(v => v <= 255) && ![0, 10, 127].includes(n[0]) && n[0] < 224
    && !(n[0] === 169 && n[1] === 254) && !(n[0] === 172 && n[1] >= 16 && n[1] <= 31)
    && !(n[0] === 192 && [0, 168].includes(n[1])) && !(n[0] === 100 && n[1] >= 64 && n[1] <= 127)
    && !(n[0] === 198 && [18, 19, 51].includes(n[1])) && !(n[0] === 203 && n[1] === 0);
}

export function canonicalSourceUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || url.hash || url.search || !host.includes('.') || host.endsWith('.')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

export function sourceKey(source) {
  return `${source.source_type.toLowerCase()}|${source.source_name.toLowerCase()}|${canonicalSourceUrl(source.source_url) ?? ''}`;
}

export function normalizedSources(value) {
  if (!Array.isArray(value)) return [];
  const output = new Map();
  for (const item of value) {
    const type = cleanText(item?.source_type, 40).toLowerCase();
    const name = cleanText(item?.source_name, 160);
    const url = canonicalSourceUrl(item?.source_url);
    if (!['github', 'portfolio'].includes(type) || !name || !url) continue;
    const source = { source_type: type, source_name: name, source_url: url };
    output.set(sourceKey(source), source);
  }
  return [...output.values()];
}

async function publicDns(host) {
  const answers = await Promise.allSettled([Deno.resolveDns(host, 'A'), Deno.resolveDns(host, 'AAAA')]);
  return answers.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

export async function fetchText(url, headers = {}, { fetcher = fetch, resolve = publicDns, maxBytes = 1500000, timeoutMs = 15000 } = {}) {
  const parsed = new URL(url);
  // Query strings are permitted for a constructed GitHub API request only.
  const sourceUrl = new URL(parsed); sourceUrl.search = '';
  if (!canonicalSourceUrl(sourceUrl.href)) throw new Error('Unsafe source URL');
  // Include DNS in the same request deadline. An unresponsive resolver must not
  // bypass the worker's total source-inspection budget.
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('Source request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let addresses;
  try { addresses = await Promise.race([resolve(parsed.hostname), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
  signal.throwIfAborted();
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error('Source address is not public');
  const response = await fetcher(parsed.href, { headers, redirect: 'error', signal });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('Source response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let size = 0; let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Source response is too large'); }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function addFact(facts, fact) {
  fact = { ...fact, category: normalizeCategory(fact.category), name: normalizeName(fact.name) };
  const key = factKey(fact.category, fact.name);
  const existing = facts.get(key);
  if (!existing) { facts.set(key, fact); return; }
  // Same source has one evidence row in the established backend contract.
  for (const evidence of fact.evidence) {
    const prior = existing.evidence.find(item => sourceKey(item) === sourceKey(evidence));
    if (!prior) existing.evidence.push(evidence);
    else if (!prior.evidence.includes(evidence.evidence)) prior.evidence = cleanText(`${prior.evidence}; ${evidence.evidence}`, 4000);
  }
}

function evidenceFor(source, locator, excerpt) {
  return { ...source, evidence: cleanText(`${locator}: ${excerpt}`, 4000) };
}

export function extractExplicitTechnologies(text, source, locator, facts) {
  // A mention in prose, topic tag, dependency file, or tutorial is not a claim.
  const sections = String(text).replace(/```[\s\S]*?```/g, '').split(/\r?\n/);
  let explicitSection = false; let sectionLevel = 7;
  for (const line of sections) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const title = heading[2].replace(/[^\p{L}\p{N}& /-]/gu, '').trim();
      if (/^(?:technical\s+)?(?:skills(?: & technologies)?|technologies|tech stack|technology stack|tools(?: and technologies)?|frameworks|libraries|built with)\s*[:\-]?$/i.test(title)) {
        explicitSection = true; sectionLevel = heading[1].length;
      } else if (heading[1].length <= sectionLevel) explicitSection = false;
    }
    const inline = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:skills|technologies|tech stack|technology stack|built with|implemented (?:in|with)|tools|frameworks|libraries)(?:\*\*)?\s*:\s*(.+)$/i);
    if (!inline && (!explicitSection || heading)) continue;
    const claim = cleanText(inline ? inline[1] : line, 1000);
    if (!claim || /^(?:[-*]\s*)?(?:(?:currently|still)\s+)?learning\b|\b(?:planned|future|todo|not yet|wish|aspir(?:e|ing)|interested in|plan to learn)\b/i.test(claim)) continue;
    // A negated or explicitly uncertain mention is not evidence of ability.
    // Skip the whole line conservatively rather than assigning negation to the
    // wrong term in a compound sentence.
    if (/\b(?:no|not|never|without|unfamiliar|lack(?:s|ing)?|unknown|unsure|unproven|haven['’]t|hasn['’]t|don['’]t|doesn['’]t|can['’]t|cannot)\b/i.test(claim)) continue;
    for (const term of terms) {
      const regex = new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
      if (!regex.test(claim)) continue;
      addFact(facts, { category: 'technology', name: term,
        description: 'Explicitly listed technology in an approved source.', verification_status: 'verified',
        evidence: [evidenceFor(source, locator, claim)] });
    }
  }
}

export function boundedSourceReader({ readText = fetchText, now = Date.now, budgetMs = 90000 } = {}) {
  const deadline = now() + budgetMs;
  return async (url, headers = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Source inspection budget exhausted');
    return await readText(url, headers, { timeoutMs: Math.max(1, Math.min(15000, remaining)) });
  };
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

export function portfolioText(html) {
  return decodeHtml(String(html).replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => `\n${'#'.repeat(Number(level))} ${body.replace(/<[^>]+>/g, '')}\n`)
    .replace(/<\/section>/gi, '\n# END SECTION\n')
    .replace(/<\/(?:p|div|li|article|tr|ul|ol)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim());
}

export function extractPortfolio(html, source, facts) {
  // Timeline dates frequently precede their own heading. Keep that explicitly
  // tagged date with its heading instead of attaching it to the previous item.
  const scopedHtml = String(html).replace(/(<(?:span|time)\b[^>]*(?:class=["'][^"']*(?:date|period)[^"']*["']|datetime=["'][^"']*["'])[^>]*>[\s\S]*?<\/(?:span|time)>)(\s*<h[3-6]\b[^>]*>[\s\S]*?<\/h[3-6]>)/gi, '$2\n$1');
  const text = portfolioText(scopedHtml);
  if (!text) throw new Error('Portfolio returned no readable text');
  const before = facts.size;
  extractExplicitTechnologies(text, source, `${source.source_url} explicit skills/technology section`, facts);
  let section = null; let entry = null; let parts = []; let sectionLevel = 0; let entryLevel = 0;
  const flush = () => {
    if (section && entry && parts.length) addFact(facts, { category: section, name: entry,
      description: cleanText(parts.join(' '), 1500), verification_status: 'verified',
      evidence: [evidenceFor(source, `${source.source_url} heading "${entry}"`, parts.join(' '))] });
    entry = null; parts = [];
  };
  for (const line of text.split(/\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      const title = cleanText(heading[2], 180);
      const category = ({ projects: 'project', 'key projects': 'project', education: 'education', experience: 'experience', 'work experience': 'experience' })[title.toLowerCase()];
      const level = heading[1].length;
      if (category) { flush(); section = category; sectionLevel = level; }
      else if (section && level > sectionLevel && (!entry || level <= entryLevel)) { flush(); entry = title; entryLevel = level; }
      else if (section && entry && level > entryLevel) parts.push(title);
      else { flush(); section = null; }
    } else if (entry && line.trim()) parts.push(cleanText(line, 1500));
  }
  flush();
  return facts.size - before;
}

export function githubOwner(sourceUrl) {
  const url = new URL(sourceUrl); const parts = url.pathname.split('/').filter(Boolean);
  return url.hostname === 'github.com' && parts.length === 1 && /^[A-Za-z0-9-]+$/.test(parts[0]) ? parts[0] : null;
}

export async function syncGithub(source, facts, { readText = fetchText, maxPages = 5, maxReadmes = 35 } = {}) {
  const parsed = new URL(source.source_url); const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'github.com' && segments.length === 2 && segments.every(s => /^[A-Za-z0-9_.-]+$/.test(s))) {
    // A repository approval is narrower than account approval. Do not enumerate
    // any other repositories or follow links from its README.
    const readme = await readText(`https://api.github.com/repos/${segments.map(encodeURIComponent).join('/')}/readme`,
      { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'ai-internship-hunter-profile-sync' });
    const before = facts.size;
    extractExplicitTechnologies(readme, source, `${source.source_url}/blob/HEAD/README.md`, facts);
    return { discovered: facts.size - before, complete: true, warnings: [] };
  }
  const owner = githubOwner(source.source_url);
  if (!owner) throw new Error('GitHub source must be a public profile URL');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-internship-hunter-profile-sync' };
  let complete = false; const repositories = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = JSON.parse(await readText(`https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=full_name&page=${page}`, headers));
    if (!Array.isArray(result)) throw new Error('GitHub returned an unexpected shape');
    repositories.push(...result.filter(repo => repo && typeof repo.name === 'string' && !repo.fork
      && String(repo.owner?.login ?? '').toLowerCase() === owner.toLowerCase()));
    if (result.length < 100) { complete = true; break; }
  }
  const warnings = [];
  if (!complete) warnings.push('GitHub repository pagination limit reached');
  let readmeCount = 0;
  for (const repository of repositories) {
    const name = cleanText(repository.name, 120);
    const repositoryUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const description = cleanText(repository.description, 1500);
    addFact(facts, { category: 'project', name, description: description || 'Repository listed in the approved GitHub account.',
      verification_status: 'verified', evidence: [evidenceFor(source, `${repositoryUrl} repository metadata`, description || name)] });
    const language = cleanText(repository.language, 80);
    if (language) addFact(facts, { category: 'technology', name: language,
      description: 'Primary language reported for a repository in the approved GitHub account.', verification_status: 'verified',
      evidence: [evidenceFor(source, `${repositoryUrl} repository language`, language)] });
    if (readmeCount >= maxReadmes) { complete = false; continue; }
    readmeCount++;
    try {
      const readme = await readText(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`, { ...headers, Accept: 'application/vnd.github.raw+json' });
      extractExplicitTechnologies(readme, source, `${repositoryUrl}/blob/HEAD/README README`, facts);
    } catch (error) {
      if (error?.message !== 'Source returned HTTP 404') { complete = false; warnings.push('A GitHub README could not be inspected'); }
    }
  }
  if (repositories.length > maxReadmes) warnings.push('GitHub README inspection limit reached');
  return { discovered: repositories.length, complete, warnings: [...new Set(warnings)] };
}

export function missingFacts(existingFacts, existingEvidence, completeSources, currentFacts) {
  const completeKeys = new Set(completeSources.map(sourceKey));
  const byFact = new Map();
  for (const evidence of existingEvidence) {
    const list = byFact.get(evidence.fact_id) ?? [];
    list.push(evidence); byFact.set(evidence.fact_id, list);
  }
  return existingFacts.filter(fact => {
    const evidence = byFact.get(fact.id) ?? [];
    return evidence.length > 0 && evidence.every(item => completeKeys.has(sourceKey(item)))
      && !currentFacts.has(factKey(fact.category, fact.name));
  }).map(({ category, name }) => ({ category, name }));
}
