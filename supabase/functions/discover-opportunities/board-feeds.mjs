import { canonicalUrl, countryName, isInternshipTitle } from './core.mjs';
import { portfolioText } from '../sync-profile/core.mjs';

const greenhouseApiHost = 'boards-api.greenhouse.io';
const greenhousePostingHosts = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io']);
const leverPostingHosts = new Map([
  ['api.lever.co', 'jobs.lever.co'],
  ['api.eu.lever.co', 'jobs.eu.lever.co'],
]);
const boardName = '[a-z0-9][a-z0-9_-]{0,79}';
const greenhouseFeedPath = new RegExp(`^/v1/boards/(${boardName})/jobs$`, 'i');
const greenhouseDetailPath = new RegExp(`^/v1/boards/(${boardName})/jobs/([1-9][0-9]*)$`, 'i');
const greenhousePostingPath = new RegExp(`^/(${boardName})/jobs/([1-9][0-9]*)$`, 'i');
const leverFeedPath = new RegExp(`^/v0/postings/(${boardName})$`, 'i');
const leverId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function boardFeed(url) {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;
  const source = new URL(canonical);
  const greenhouse = source.hostname === greenhouseApiHost && greenhouseFeedPath.exec(source.pathname);
  if (greenhouse && [...source.searchParams].length === 1 && source.searchParams.get('content') === 'true') {
    return { kind: 'greenhouse_jobs', board: greenhouse[1] };
  }
  const postingHost = leverPostingHosts.get(source.hostname);
  const lever = postingHost && leverFeedPath.exec(source.pathname);
  if (lever && [...source.searchParams].length === 1 && source.searchParams.get('mode') === 'json') {
    return { kind: 'lever_jobs', board: lever[1], postingHost };
  }
  return null;
}

export function boardFeedKind(url) {
  return boardFeed(url)?.kind ?? null;
}

function customPostingId(url) {
  const id = url.searchParams.get('gh_jid');
  const keys = [...url.searchParams.keys()];
  const path = url.pathname.replace(/\/$/, '');
  return (path === '/jobs' || path === `/detail/${id}`) && /^[1-9][0-9]*$/.test(id ?? '') &&
    url.searchParams.getAll('gh_jid').length === 1 && keys.every(key => key === 'gh_jid' || key === 'gh_src') ? id : null;
}

// Public posting URLs are accepted only for the exact employer board and ID
// that served the evidence. Custom destinations need independent verification.
function postingUrl(rawUrl, id, source) {
  const url = canonicalUrl(rawUrl);
  if (!url) return null;
  const target = new URL(url);
  const path = target.pathname.replace(/\/$/, '').toLowerCase();
  const board = source.board.toLowerCase();
  if (source.kind === 'greenhouse_jobs') {
    if (source.approvedPostingHost && target.hostname === source.approvedPostingHost && customPostingId(target) === String(id)) {
      return `${target.origin}${target.pathname.replace(/\/$/, '')}?gh_jid=${id}`;
    }
    if (!greenhousePostingHosts.has(target.hostname) || path !== `/${board}/jobs/${id}`) return null;
    const host = target.hostname === 'job-boards.eu.greenhouse.io' ? target.hostname : 'job-boards.greenhouse.io';
    return `https://${host}/${source.board}/jobs/${id}`;
  }
  if (target.hostname !== source.postingHost || path !== `/${board}/${id.toLowerCase()}`) return null;
  return `${target.origin}${target.pathname.replace(/\/$/, '')}`;
}

const countryAliases = new Map(Object.entries({
  'united states': 'US', 'u.s.': 'US', usa: 'US', 'u.s.a.': 'US',
  france: 'FR', germany: 'DE', deutschland: 'DE', spain: 'ES', españa: 'ES',
  'united arab emirates': 'AE', uae: 'AE', 'u.a.e.': 'AE', 'saudi arabia': 'SA',
  china: 'CN', '中国': 'CN', japan: 'JP', '日本': 'JP', morocco: 'MA', maroc: 'MA', 'المغرب': 'MA',
  'united kingdom': 'GB', uk: 'GB', 'u.k.': 'GB', canada: 'CA', india: 'IN',
  israel: 'IL', netherlands: 'NL', australia: 'AU', singapore: 'SG', ireland: 'IE',
  italy: 'IT', switzerland: 'CH', poland: 'PL', sweden: 'SE', belgium: 'BE', qatar: 'QA',
}));
const countries = new Intl.DisplayNames('en', { type: 'region', fallback: 'none' });
const documentedUsCities = new Set([
  'atlanta, ga', 'austin, tx', 'bellevue, wa', 'boston, ma', 'cambridge, ma', 'chicago, il',
  'cupertino, ca', 'denver, co', 'fremont, ca', 'irvine, ca', 'los angeles, ca', 'menlo park, ca',
  'mountain view, ca', 'new york, ny', 'new york city, ny', 'palo alto, ca', 'phoenix, az',
  'pittsburgh, pa', 'redmond, wa', 'san diego, ca', 'san francisco, ca', 'san jose, ca',
  'san mateo, ca', 'santa clara, ca', 'seattle, wa', 'sunnyvale, ca', 'washington, dc',
]);

function regionName(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
  const name = countries.of(code);
  if (!name) return null;
  const normalized = countryName(code);
  return normalized === code ? name : normalized;
}

function locationAddress(raw, country) {
  const words = typeof raw === 'string' ? raw.trim().split(',').map(value => value.trim()).filter(Boolean) : [];
  const last = words.at(-1)?.toLowerCase() ?? '';
  const explicit = countryAliases.get(last);
  const inferred = explicit ?? (documentedUsCities.has(words.join(', ').toLowerCase()) ? 'US' : null);
  const name = regionName(country) ?? regionName(inferred);
  if (!name) return null;
  const city = explicit && words.length > 1 ? words[0] : explicit ? '' : words[0] ?? '';
  return { addressCountry: name, ...(city && !/^remote$/i.test(city) ? { addressLocality: city } : {}) };
}

function greenhouseDescription(value) {
  if (typeof value !== 'string') return '';
  // Greenhouse encodes HTML in its JSON response. Decode only the layers
  // needed to recover markup, so portfolioText can remove markup and scripts.
  let decoded = value;
  for (let i = 0; i < 2 && /&(?:amp;)?lt;\/?[a-z!/]/i.test(decoded); i++) {
    decoded = decoded.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  }
  return portfolioText(decoded);
}

function greenhouseJob(job, source, organization) {
  if (job.internal_job_id === null || !Number.isSafeInteger(job.id) || job.id <= 0) return null;
  const url = postingUrl(job.absolute_url, job.id, source);
  const description = greenhouseDescription(job.content);
  if (!url || !description) return null;
  const rawLocation = typeof job.location?.name === 'string' ? job.location.name : '';
  const addresses = rawLocation.split(/\s*;\s*|\s+\/\s+/).map(location => locationAddress(location)).filter(Boolean);
  if (!addresses.length && rawLocation) {
    // Official office records can disambiguate an explicitly matching job city.
    const city = rawLocation.split(',')[0].trim().toLowerCase();
    for (const office of Array.isArray(job.offices) ? job.offices : []) {
      if (typeof office?.location !== 'string' || office.location.split(',')[0].trim().toLowerCase() !== city) continue;
      const address = locationAddress(office.location);
      if (address) addresses.push(address);
    }
  }
  return {
    '@type': 'JobPosting', title: job.title, description, hiringOrganization: { name: organization },
    url, identifier: String(job.id), jobLocation: addresses.map(address => ({ address })),
    validThrough: job.application_deadline,
  };
}

function leverJob(job, source, organization) {
  if (typeof job.id !== 'string' || !leverId.test(job.id)) return null;
  const url = postingUrl(job.hostedUrl, job.id, source);
  const opening = job.descriptionPlain || job.description;
  if (!url || typeof opening !== 'string' || !opening.trim()) return null;
  const sections = Array.isArray(job.lists) ? job.lists.filter(section => typeof section?.content === 'string') : [];
  const description = [opening, ...sections.map(section => section.content)].map(portfolioText).join('\n');
  const primary = job.categories?.location;
  const locations = Array.isArray(job.categories?.allLocations) ? job.categories.allLocations : [];
  const addresses = [...new Set([primary, ...locations])]
    .map(location => locationAddress(location, location === primary ? job.country : null)).filter(Boolean);
  return {
    '@type': 'JobPosting', title: job.text, description, hiringOrganization: { name: organization },
    url, identifier: job.id, jobLocation: addresses.map(address => ({ address })),
    jobLocationType: job.workplaceType === 'remote' ? 'TELECOMMUTE' : undefined,
    qualifications: sections.filter(section => /\b(?:qualification|requirement)s?\b/i.test(section.text ?? ''))
      .map(section => portfolioText(section.content)),
  };
}

export function boardFeedJobs(url, payload, organization, approvedPostingHost) {
  const source = boardFeed(url);
  if (!source || typeof organization !== 'string' || !organization.trim() || organization.length > 250) {
    throw new Error('Invalid public job board configuration');
  }
  const greenhouse = source.kind === 'greenhouse_jobs';
  if (approvedPostingHost !== undefined) {
    if (!greenhouse || typeof approvedPostingHost !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(approvedPostingHost)) {
      throw new Error('Invalid public job board posting host');
    }
    source.approvedPostingHost = approvedPostingHost.toLowerCase();
  }
  const records = greenhouse ? payload?.jobs : payload;
  if (!Array.isArray(records)) throw new Error('Invalid public job board response');
  const jobs = [];
  for (const record of records) {
    const title = greenhouse ? record?.title : record?.text;
    if (typeof title !== 'string' || !isInternshipTitle(title)) continue;
    const job = greenhouse ? greenhouseJob(record, source, organization) : leverJob(record, source, organization);
    if (job) jobs.push(job);
  }
  return jobs;
}

export function greenhousePostingEndpoint(url, approvedFeeds = []) {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;
  const target = new URL(canonical);
  if (greenhousePostingHosts.has(target.hostname)) {
    const posting = greenhousePostingPath.exec(target.pathname);
    return posting ? `https://${greenhouseApiHost}/v1/boards/${posting[1]}/jobs/${posting[2]}` : null;
  }

  const id = customPostingId(target);
  if (!id || !Array.isArray(approvedFeeds)) return null;
  const boards = new Set();
  for (const feed of approvedFeeds) {
    if (typeof feed?.posting_host !== 'string' || feed.posting_host.toLowerCase() !== target.hostname) continue;
    const approved = boardFeed(feed.source_url ?? feed.url);
    if (approved?.kind === 'greenhouse_jobs') boards.add(approved.board.toLowerCase());
  }
  if (boards.size !== 1) return null;
  const [board] = boards;
  return `https://${greenhouseApiHost}/v1/boards/${board}/jobs/${id}`;
}

export function greenhousePostingJob(sourceUrl, apiUrl, payload) {
  const canonical = canonicalUrl(sourceUrl);
  const canonicalApi = canonicalUrl(apiUrl);
  if (!canonical || !canonicalApi || !payload || typeof payload !== 'object') return null;
  const api = new URL(canonicalApi);
  const detail = api.hostname === greenhouseApiHost && !api.search && greenhouseDetailPath.exec(api.pathname);
  if (!detail || String(payload.id) !== detail[2] || typeof payload.company_name !== 'string' ||
      !payload.company_name.trim() || payload.company_name.length > 250) return null;
  const source = { kind: 'greenhouse_jobs', board: detail[1], approvedPostingHost: new URL(canonical).hostname };
  const expected = postingUrl(canonical, payload.id, source);
  const job = greenhouseJob(payload, source, payload.company_name);
  return job && expected && job.url === expected ? job : null;
}
