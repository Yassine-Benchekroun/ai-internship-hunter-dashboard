// Deterministic evidence extraction. Web pages never provide worker instructions.
import { normalizeName, portfolioText } from '../sync-profile/core.mjs';
import { parseHTML } from 'linkedom/worker';

const text = (value, max = 12000) => typeof value === 'string' ? portfolioText(value).replace(/# END SECTION/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
const countryNames = { US: 'United States', USA: 'United States', FR: 'France', DE: 'Germany', ES: 'Spain', AE: 'United Arab Emirates', SA: 'Saudi Arabia', CN: 'China', JP: 'Japan' };
export const countryName = value => countryNames[text(value).toUpperCase()] ?? text(value);
export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}
export function jsonLdJobs(html) {
  const jobs = [];
  const { document } = parseHTML(String(html));
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (list(value['@type']).includes('JobPosting')) jobs.push(value);
    if (value['@graph']) visit(value['@graph']);
    if (value.itemListElement) for (const item of list(value.itemListElement)) visit(item?.item ?? item);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)); } catch { /* Invalid structured data is never guessed. */ }
  }
  // Schema.org microdata is also explicit publisher evidence. Scope each field
  // to its nearest item so organization/address names never become a job title.
  const item = scope => {
    const result = { '@type': (scope.getAttribute('itemtype') ?? '').split('/').pop() };
    for (const element of scope.querySelectorAll('[itemprop]')) {
      if (element.parentElement?.closest('[itemscope]') !== scope) continue;
      const value = element.hasAttribute('itemscope') ? item(element) :
        element.getAttribute('content') ?? element.getAttribute('datetime') ??
        (['A','LINK'].includes(element.tagName) ? element.getAttribute('href') : null) ??
        (element.getAttribute('itemprop') === 'description' ? element.innerHTML : element.textContent);
      for (const key of element.getAttribute('itemprop').split(/\s+/)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        result[key] = result[key] === undefined ? value : [...list(result[key]), value];
      }
    }
    return result;
  };
  for (const scope of document.querySelectorAll('[itemscope][itemtype$="/JobPosting"]')) visit(item(scope));
  return jobs;
}
export function verifyJob(job, sourceUrl, settings, now = new Date()) {
  if (!job || typeof job !== 'object' || !list(job['@type']).includes('JobPosting')) return { rejected: 'invalid_posting_data' };
  const organization = text(job.hiringOrganization?.name, 250);
  const position = text(job.title, 250);
  const description = text(job.description);
  const source = canonicalUrl(sourceUrl);
  if (!organization || !position || !description || !source) return { rejected: 'missing_verified_fields' };
  const domain = /\b(?:artificial intelligence|machine learning|deep learning|computer vision|data science|AI|ML|NLP|robotics|software|research scientist|intelligence artificielle|vision par ordinateur|aprendizaje automático|künstliche intelligenz)\b|人工智能|机器学习|機械学習|コンピュータビジョン/i;
  const isIntern = /\b(?:intern(?:ship)?|stage|stagiaire|praktikum|research assistant|research opportunity|visiting student)\b/i.test(position);
  const isResearch = /\b(?:research|lab|university)\b/i.test(position);
  const nonTechnicalTitle = /\b(?:accounting|sales|marketing|administrative|change management|communications|content manager|mechanical technician|MBA|operations planning|business development|finance|legal|public policy|human resources|talent acquisition|procurement|event management|investment analyst|investment services|sector analyst|equity support|IT support|technical support|recruitment|enablement|strategic program management|hardware engineer|safety reporting|service designer|UX designer|antenna design|mechanical engineering|satellite programs|thermal\s*&\s*manufacturing)\b/i;
  const unrelatedRole = nonTechnicalTitle.test(position);
  if (!domain.test(`${position} ${description}`) || !isIntern || unrelatedRole) return { rejected: 'domain_irrelevant' };
  const opportunityType = isResearch ? 'research' : 'internship';
  if (!settings.opportunity_types?.includes(opportunityType)) return { rejected: 'type_not_configured' };
  const locations = list(job.jobLocation).filter(item => item && typeof item === 'object')
    .map(item => item.address).filter(address => address && typeof address === 'object');
  const countries = locations.map(item => countryName(typeof item.addressCountry === 'object' ? item.addressCountry?.name : item.addressCountry)).filter(Boolean);
  const country = countries.find(item => settings.target_countries?.some(c => c.toLowerCase() === item.toLowerCase()));
  // A remote flag alone does not establish worldwide eligibility.
  const remoteCountries = list(job.applicantLocationRequirements).filter(item => item && typeof item === 'object')
    .map(item => countryName(item.name ?? item.addressCountry)).filter(Boolean);
  const remoteCountry = remoteCountries.find(item => settings.target_countries?.some(c => c.toLowerCase() === item.toLowerCase()));
  if (!country && !remoteCountry && (countries.length || remoteCountries.length)) return { rejected: 'country_not_configured' };
  const deadline = typeof job.validThrough === 'string' && /^\d{4}-\d{2}-\d{2}/.test(job.validThrough) && Number.isFinite(Date.parse(job.validThrough)) ? job.validThrough.slice(0, 10) : null;
  if (deadline && new Date(`${deadline}T23:59:59Z`) < now) return { rejected: 'expired' };
  const requirements = [job.skills, job.qualifications, job.educationRequirements, job.experienceRequirements].flatMap(list)
    .filter(v => v !== null && v !== undefined).map(v => text(typeof v === 'object' ? v.name ?? v.description : v)).filter(Boolean);
  const contact = job.applicationContact;
  const recipient = contact?.['@type'] === 'ContactPoint' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email ?? '') ? contact.email : null;
  const amount = job.baseSalary?.value;
  const funding = job.baseSalary?.currency && (typeof amount === 'number' || typeof amount?.value === 'number') ? `${typeof amount === 'number' ? amount : amount.value} ${job.baseSalary.currency}${amount?.unitText ? ` / ${text(amount.unitText, 40)}` : ''}` : 'Not listed';
  return { opportunity: {
    organization, position, description, source_url: source, country: country ?? remoteCountry ?? 'Unknown',
    city: text(locations.find(item => countryName(typeof item.addressCountry === 'object' ? item.addressCountry?.name : item.addressCountry) === country)?.addressLocality, 160) || 'Unknown',
    opportunity_type: opportunityType, work_mode: job.jobLocationType === 'TELECOMMUTE' ? 'remote' : 'Unknown',
    deadline, funding, professor_researcher: null, research_area: text(job.occupationalCategory, 300) || 'Not listed', requirements,
    external_id: text(job.identifier && typeof job.identifier === 'object' ? job.identifier.value : job.identifier, 200) || null,
    domain_relevant: true, domain_relevance_reason: 'AI/ML/software research internship evidenced by the source posting.',
    verified_recipient: recipient, recipient_source_url: recipient ? source : null,
  } };
}
const vocabulary = ['Python','C++','Java','JavaScript','TypeScript','SQL','MATLAB','R','PyTorch','TensorFlow','scikit-learn','sklearn','OpenCV','Pandas','NumPy','Docker','Git','Machine Learning','Deep Learning','Computer Vision','NLP','Robotics','Data Science'];
function mentions(haystack, needle) {
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(haystack);
}
export const MATCH_THRESHOLD = 70;
export function classifyOpportunity(score) {
  return score >= MATCH_THRESHOLD ? 'top' : 'lower';
}
export function scoreOpportunity(opportunity, facts) {
  const verified = facts.filter(f => f.verification_status === 'verified');
  const requirementText = opportunity.requirements.join(' ');
  const fullText = `${opportunity.position} ${opportunity.description} ${requirementText}`;
  const requested = [...new Set(vocabulary.filter(term => mentions(requirementText || fullText, term)).map(normalizeName))];
  const skills = verified.filter(f => ['skill','technology','framework','library'].includes(f.category));
  const matched = requested.filter(term => skills.some(f => normalizeName(f.name).toLowerCase() === term.toLowerCase()));
  const topics = ['Machine Learning','Deep Learning','Computer Vision','NLP','Robotics','Data Science'].filter(term => mentions(fullText, term));
  const relevantProjects = verified.filter(f => f.category === 'project' && [...matched, ...topics].some(term => mentions(`${f.name} ${f.description ?? ''}`, term)));
  const matchedTopics = topics.filter(term => verified.some(f => mentions(`${f.name} ${f.description ?? ''}`, term)));
  const degrees = ['bachelor', 'master', 'phd'].filter(term => mentions(requirementText, term));
  const education = verified.filter(f => f.category === 'education');
  const degreeMatch = degrees.some(term => education.some(f => mentions(`${f.name} ${f.description ?? ''}`, term)));
  const breakdown = {
    technical: requested.length ? Math.round(35 * matched.length / requested.length) : 0,
    projects: Math.min(25, relevantProjects.length * 10),
    topic: topics.length ? Math.round(20 * matchedTopics.length / topics.length) : 0,
    education: degreeMatch ? 10 : 0, eligibility: 0, access: 0,
  };
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { match_score: score, score_breakdown: { ...breakdown, explanation: {
    technical: { requested, matched }, projects: relevantProjects.map(f => f.name), topic: matchedTopics,
    education: degreeMatch ? 'Degree wording overlaps; enrollment/graduation requirements require review.' : 'Not established',
    eligibility: 'Not established; no work authorization inferred', access: 'Not established; target-country preference is not access evidence',
  } }, verified_skills: matched, missing_skills: requested.filter(term => !matched.includes(term)), projects: relevantProjects.map(f => f.name),
  classification: classifyOpportunity(score) };
}
export function prepareMaterials(opportunity, facts, master, identity) {
  if (!master?.content?.trim()) throw new Error('master_cv_content_unavailable');
  const relevant = facts.filter(f => f.verification_status === 'verified' && (opportunity.projects.includes(f.name) || opportunity.verified_skills.includes(normalizeName(f.name))));
  const highlighted = relevant.map(f => `- ${f.name}${f.description ? `: ${f.description}` : ''}`).join('\n');
  // The approved CV remains verbatim. The preface only emphasizes verified facts.
  const content = `${identity.sender_identity_name ? `${identity.sender_identity_name}\n\n` : ''}Application focus: ${opportunity.position} — ${opportunity.organization}\n\n${highlighted ? `Relevant verified skills and projects\n${highlighted}\n\n` : ''}${master.content}`;
  const skillLine = opportunity.verified_skills.length ? `My verified background includes ${opportunity.verified_skills.slice(0, 5).join(', ')}. ` : '';
  const projectLine = opportunity.projects.length ? `Relevant projects include ${opportunity.projects.slice(0, 2).join(' and ')}. ` : '';
  const closing = identity.sender_identity_name || '[Your name — review required]';
  return {
    cv: { content, change_summary: 'Emphasized evidenced skills/projects for this posting; approved Master CV preserved verbatim.' },
    email: { recipient: opportunity.verified_recipient, subject: `Application — ${opportunity.position}`,
      body: `Dear Hiring Team,\n\nI am interested in the ${opportunity.position} opportunity at ${opportunity.organization}, listed at ${opportunity.source_url}.\n\n${skillLine}${projectLine}I would welcome the opportunity to discuss how my background relates to this work. My CV is prepared for your review.\n\nThank you for your consideration.\n\nBest regards,\n${closing}` },
    readiness: 'Needs review',
  };
}
export async function contentKey(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
