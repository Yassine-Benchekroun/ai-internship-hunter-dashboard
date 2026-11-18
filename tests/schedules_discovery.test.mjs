import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { jsonLdJobs, verifyJob, scoreOpportunity, prepareMaterials, contentKey, canonicalUrl } from '../supabase/functions/discover-opportunities/core.mjs';

const settings = { opportunity_types: ['internship','research'], target_countries: ['France'], match_threshold: 70 };
const job = { '@type':'JobPosting',title:'Machine Learning Research Intern',hiringOrganization:{name:'Example Lab'},description:'Research in computer vision and machine learning.',skills:'Python, PyTorch',jobLocation:{address:{addressLocality:'Paris',addressCountry:'FR'}},validThrough:'2099-01-01' };
const source = 'https://careers.example.org/jobs/123';
const facts = [
  { category:'technology',name:'Python',verification_status:'verified' },
  { category:'project',name:'Vision model',description:'Computer Vision with Python',verification_status:'verified' },
  { category:'technology',name:'PyTorch',verification_status:'needs_review' },
];
test('only structured postings are extracted; nested graph supported and broken data ignored', () => {
  assert.deepEqual(jsonLdJobs(`<script type="application/ld+json">{"@graph":[${JSON.stringify(job)}]}</script>`), [job]);
  assert.deepEqual(jsonLdJobs('<h1>AI Internship</h1><script type="application/ld+json">oops</script>'), []);
});
test('microdata fields stay within their organization and address scope', () => {
  const html = '<div itemscope itemtype="https://schema.org/JobPosting"><h1 itemprop="title">AI Intern</h1><div itemprop="hiringOrganization" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">A Lab</span></div><div itemprop="jobLocation" itemscope itemtype="https://schema.org/Place"><div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><meta itemprop="addressCountry" content="FR"></div></div><div itemprop="description">Machine learning research.</div></div>';
  const parsed = jsonLdJobs(html)[0];
  assert.equal(parsed.title,'AI Intern'); assert.equal(parsed.hiringOrganization.name,'A Lab');
  assert.equal(parsed.jobLocation.address.addressCountry,'FR'); assert.equal(parsed.name,undefined);
});
test('verifier preserves unknown facts and rejects unrelated, expired and unverified country items', () => {
  const record = verifyJob(job, source, settings).opportunity;
  assert.equal(record.country, 'France'); assert.equal(record.city, 'Paris');
  assert.equal(record.work_mode, 'Unknown'); assert.equal(record.verified_recipient, null);
  assert.equal(verifyJob({...job,title:'Accounting Intern',description:'Prepare tax reports',skills:''},source,settings).rejected,'domain_irrelevant');
  assert.equal(verifyJob({...job,validThrough:'2000-01-01'},source,settings).rejected,'expired');
  assert.equal(verifyJob({...job,jobLocation:null,jobLocationType:'TELECOMMUTE'},source,settings).opportunity.country,'Unknown');
  assert.equal(verifyJob({...job,title:'AI Change Management Intern'},source,settings).rejected,'domain_irrelevant');
  assert.equal(verifyJob({...job,title:'Senior Machine Learning Engineer'},source,settings).rejected,'domain_irrelevant');
});
test('unverified candidate skills do not raise scores; status cannot change classification', () => {
  const record = verifyJob(job,source,settings).opportunity;
  const score = scoreOpportunity(record,facts,settings.match_threshold);
  assert.deepEqual(score.verified_skills,['Python']); assert.deepEqual(score.missing_skills,['PyTorch']);
  assert.equal(score.classification,'lower'); assert.equal(score.score_breakdown.eligibility,0);
  assert.deepEqual(scoreOpportunity({...record,application_status:'already_sent'},facts,70), score);
  assert.equal(scoreOpportunity(record,facts,score.match_score).classification,'top');
});
test('targeted materials preserve Master CV dates/content and never fabricate recipients or credentials', async () => {
  const record = verifyJob(job,source,settings).opportunity;
  Object.assign(record,scoreOpportunity(record,facts,70));
  const master={content:'Education: 2023–2027\nProject: Vision model.\n'};
  const material = prepareMaterials(record,facts,master,{sender_identity_name:'Test Candidate'});
  assert.ok(material.cv.content.endsWith(master.content));
  assert.equal(material.email.recipient,null); assert.equal(material.readiness,'Needs review');
  assert.doesNotMatch(material.cv.content,/PyTorch/);
  assert.equal(await contentKey(material),await contentKey(prepareMaterials(record,facts,master,{sender_identity_name:'Test Candidate'})));
  assert.throws(()=>prepareMaterials(record,facts,{},{}),/master_cv/);
});
test('only explicit application contact is used; unrelated emails are ignored', () => {
  assert.equal(verifyJob({...job,email:'info@example.org'},source,settings).opportunity.verified_recipient,null);
  assert.equal(verifyJob({...job,applicationContact:{'@type':'ContactPoint',email:'hiring@example.org'}},source,settings).opportunity.verified_recipient,'hiring@example.org');
});
test('source normalization removes tracking without changing case-sensitive path or vacancy identifiers', () => {
  assert.equal(canonicalUrl('https://careers.example.org/Job?utm_source=x&id=12#apply'),'https://careers.example.org/Job?id=12');
  assert.equal(canonicalUrl('https://user:password@example.org/jobs'),null);
});

test('null and malformed optional members do not abort valid posting verification', () => {
  const record = verifyJob({...job, identifier:null,
    jobLocation:[null, false, {address:null}, job.jobLocation],
    applicantLocationRequirements:[null, false, {}],
    skills:[null, undefined, {}, 'Python'], qualifications:[null, {name:'PyTorch'}],
    educationRequirements:[null], experienceRequirements:[null],
  },source,settings).opportunity;
  assert.equal(record.country,'France');
  assert.deepEqual(record.requirements,['Python','PyTorch']);
  assert.equal(record.external_id,null);
  const extracted = jsonLdJobs(`<script type="application/ld+json">${JSON.stringify({itemListElement:[null,{item:job}]})}</script>`);
  assert.deepEqual(extracted,[job]);
});

// Exercise the production search and verifier boundaries without loading Deno
// runtime imports or starting the Edge HTTP handler.
const endpointSource = await readFile(new URL('../supabase/functions/discover-opportunities/index.ts', import.meta.url), 'utf8');
const endpointJs = stripTypeScriptTypes(endpointSource.replace(/^import .+;\r?\n/gm,''), {mode:'strip'});
const coreUrl = new URL('../supabase/functions/discover-opportunities/core.mjs', import.meta.url).href;
const boundaries = await import(`data:text/javascript;base64,${Buffer.from(`
import {canonicalUrl,verifyJob} from ${JSON.stringify(coreUrl)};
const fetchText = () => { throw new Error('Unexpected network access in test'); };
class ScheduleError extends Error { constructor(code,status=500){ super(code);this.code=code;this.status=status; } }
${endpointJs}`).toString('base64')}`);

test('unexpected candidate failure is rejected independently and the next posting still verifies', () => {
  const errors=[];
  const bad=boundaries.verifyCandidate({},source,settings,errors,()=>{throw new TypeError('Malformed upstream data');});
  const good=boundaries.verifyCandidate(job,source,settings,errors);
  assert.equal(bad.rejected,'invalid_posting_data');
  assert.equal(good.opportunity.position,job.title);
  assert.deepEqual(errors,['opportunity_verification_failed']);
});

test('search shares a fixed deadline and bounds each request to remaining time', async () => {
  let now=0; const calls=[]; const errors=[];
  const config={search_queries:['first query','second query']};
  const sources=await boundaries.candidateSources(config,30,errors,{
    deadline:15000, searchKey:'test-key', now:()=>now,
    fetcher:async (url,_headers,{timeoutMs})=>{
      calls.push({url,timeoutMs}); now+=timeoutMs;
      return JSON.stringify({web:{results:Array.from({length:20},(_,i)=>({url:`https://jobs.example.org/${calls.length}/${i}`}))}});
    },
  });
  assert.deepEqual(calls.map(call=>call.timeoutMs),[10000,5000]);
  assert.equal(sources.length,40);
  assert.deepEqual(errors,['discovery_time_budget_reached']);
  assert.equal(calls.every(call=>new URL(call.url).searchParams.get('q')==='first query'),true);
});

test('expired search budget issues no network requests and preserves approved sources', async () => {
  const errors=[]; let calls=0;
  const sources=await boundaries.candidateSources({approved_search_sources:[null,{source_url:source}],search_queries:['query']},30,errors,{
    deadline:100, now:()=>100, searchKey:'test-key', fetcher:async()=>{calls++;throw new Error('must not fetch');},
  });
  assert.equal(calls,0);
  assert.deepEqual(sources,[{url:source,kind:'jsonld'}]);
  assert.deepEqual(errors,['invalid_search_source','discovery_time_budget_reached']);
});

test('outer fetch deadline also bounds a stalled resolver before HTTP begins', async () => {
  let suppliedTimeout;
  const pending=boundaries.timedFetchText(source,{},Date.now()+20,async(_url,_headers,options)=>{
    suppliedTimeout=options.timeoutMs;
    return new Promise(()=>{});
  });
  await assert.rejects(pending,error=>error.code==='discovery_source_timeout');
  assert.ok(suppliedTimeout>=1 && suppliedTimeout<=20);
  assert.throws(()=>boundaries.requestBudget(100,10000,()=>100),error=>error.code==='discovery_time_budget_reached');
});
