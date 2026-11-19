import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { jsonLdJobs, verifyJob, scoreOpportunity, classifyOpportunity, prepareMaterials, contentKey, canonicalUrl } from '../supabase/functions/discover-opportunities/core.mjs';

const settings = { opportunity_types: ['internship','research'], target_countries: ['France'] };
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
  const score = scoreOpportunity(record,facts);
  assert.deepEqual(score.verified_skills,['Python']); assert.deepEqual(score.missing_skills,['PyTorch']);
  assert.equal(score.classification,'lower'); assert.equal(score.score_breakdown.eligibility,0);
  assert.deepEqual(scoreOpportunity({...record,application_status:'already_sent'},facts), score);
  assert.deepEqual(scoreOpportunity(record,facts,1),score);
  assert.equal(classifyOpportunity(69),'lower');
  assert.equal(classifyOpportunity(70),'top');
});
test('targeted materials preserve Master CV dates/content and never fabricate recipients or credentials', async () => {
  const record = verifyJob(job,source,settings).opportunity;
  Object.assign(record,scoreOpportunity(record,facts));
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
const profileCoreUrl = new URL('../supabase/functions/sync-profile/core.mjs', import.meta.url).href;
const boundaries = await import(`data:text/javascript;base64,${Buffer.from(`
import {canonicalUrl,verifyJob,jsonLdJobs,scoreOpportunity,prepareMaterials,contentKey} from ${JSON.stringify(coreUrl)};
import {normalizedSources,sourceKey} from ${JSON.stringify(profileCoreUrl)};
const corsHeaders = {};
let fixture;
const Deno = {env:{get:()=>fixture?.searchKey}};
const fetchText = async url => {
  fixture.fetched.push(url);
  const document = fixture.documents.get(url);
  if (document == null) throw new Error('Unexpected source in test');
  return document;
};
const authorizeSchedule = async request => ({admin:fixture.admin, userId:fixture.userId, body:await request.json()});
const beginRun = async () => ({acquired:true,run_id:fixture.runId,started_at:fixture.startedAt,attempt:fixture.attempt});
const finishRun = async () => {};
export const setFixture = value => { fixture = value; };
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
  const sources=[];
  for await (const batch of boundaries.candidateSources(config,errors,{
    deadline:15000, searchKey:'test-key', now:()=>now,
    fetcher:async (url,_headers,{timeoutMs})=>{
      calls.push({url,timeoutMs}); now+=timeoutMs;
      return JSON.stringify({web:{results:Array.from({length:20},(_,i)=>({url:`https://jobs.example.org/${calls.length}/${i}`}))}});
    },
  })) sources.push(...batch);
  assert.deepEqual(calls.map(call=>call.timeoutMs),[10000,5000]);
  assert.equal(sources.length,40);
  assert.deepEqual(errors,['discovery_time_budget_reached']);
  assert.deepEqual(calls.map(call=>[new URL(call.url).searchParams.get('q'),new URL(call.url).searchParams.get('offset')]),
    [['first query','0'],['second query','0']]);
});

test('expired search budget issues no network requests and preserves approved sources', async () => {
  const errors=[]; let calls=0;
  const sources=[];
  for await (const batch of boundaries.candidateSources({approved_search_sources:[null,{source_url:source}],search_queries:['query']},errors,{
    deadline:100, now:()=>100, searchKey:'test-key', fetcher:async()=>{calls++;throw new Error('must not fetch');},
  })) sources.push(...batch);
  assert.equal(calls,0);
  assert.deepEqual(sources,[{url:source,kind:'jsonld'}]);
  assert.deepEqual(errors,['invalid_search_source','discovery_time_budget_reached']);
});

test('monthly search request cap is checked before the provider call', async () => {
  const errors=[]; let reservations=0; let calls=0;
  const sources=[];
  for await (const batch of boundaries.candidateSources({search_queries:['query']},errors,{
    deadline:Date.now()+10000, searchKey:'test-key',
    reserveSearch:async()=>{ reservations++; return {allowed:false,request_limit:1000,requests_used:1000,requests_remaining:0}; },
    fetcher:async()=>{ calls++; throw new Error('must not fetch'); },
  })) sources.push(...batch);
  assert.equal(reservations,1);
  assert.equal(calls,0);
  assert.deepEqual(sources,[]);
  assert.deepEqual(errors,['search_request_budget_exhausted']);
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

function runDiscovery({target, daily, previous, postings, dryRun=false, retry=false, checkCount}={}) {
  const userId = 'account-owner';
  const runId = 'discovery-run';
  const startedAt = new Date().toISOString();
  const approvedProfile = {source_type:'portfolio',source_name:'Portfolio',source_url:'https://candidate.example.org'};
  const known = new Map(previous.map(record => [record.source_url, record]));
  const documentUrls = postings.map(record => record.url);
  const config = {
    approved_search_sources:(retry ? [] : documentUrls).map(source_url=>({source_url})),
    search_queries:['AI internships France'],
    max_profile_age_hours:168,
  };
  const fixture = {
    userId, runId, startedAt, attempt:retry ? 2 : 1, fetched:[], ingested:[], prepared:[], countCalls:[],
    documents:new Map(postings.map(posting=>[posting.url, `<script type="application/ld+json">${JSON.stringify(posting)}</script>`])),
    admin:{
      from(table) {
        const query = {
          select(columns) { this.columns=columns; return this; },
          eq(key,value) { if (key==='user_id') assert.equal(value,userId); return this; },
          lt() { return this; }, in() { return this; }, order() { return this; }, range() { return this; },
          gt() { return this; }, limit() { return this; }, maybeSingle() { return this; },
          async abortSignal() {
            const values = {
              profile_facts:facts.filter(fact=>fact.verification_status==='verified').map(fact=>({ ...fact, id:fact.name, last_verified_at:startedAt })),
              profile_fact_evidence:facts.map(fact=>({ ...approvedProfile, fact_id:fact.name, last_verified_at:startedAt })),
              master_cv_versions:{content:'Education history from Master CV'},
              opportunity_records:previous,
              opportunity_ingestion_events:postings.map(posting=>({source_url:posting.url.replace('https://',''),opportunity_records:{raw_payload:{source_url:posting.url}}})),
            };
            if (table==='schedule_runs') {
              if (this.columns==='run_id,finished_at,status') return {data:{finished_at:startedAt,status:'completed'}};
              if (this.columns==='run_id,errors') return {data:[{run_id:'prior-attempt',errors:['application_preparation_failed']}]};
              return {data:null};
            }
            assert.ok(table in values,table);
            return {data:values[table]};
          },
        };
        return query;
      },
      rpc(name,args) {
        return { async abortSignal() {
          if (name==='automation_read_settings') return {data:{...settings,match_threshold:1,daily_opportunity_target:target,approved_profile_sources:[approvedProfile]}};
          if (name==='automation_read_schedule_config') return {data:config};
          if (name==='automation_discovery_daily_count') {
            assert.deepEqual(args,{p_user_id:userId,p_started_at:startedAt});
            fixture.countCalls.push(daily);
            return {data:checkCount?.(daily,fixture.countCalls.length) ?? daily};
          }
          if (name==='automation_ingest_opportunities') {
            assert.equal(args.p_payload.user_id,userId);
            assert.equal(args.p_payload.request_id,runId);
            const [record] = args.p_payload.opportunities;
            fixture.ingested.push(record);
            const insert=known.has(record.source_url) ? 0 : 1;
            if (insert) { known.set(record.source_url,record); daily++; }
            return {data:{accepted_count:1,inserted_count:insert,updated_count:1-insert,duplicate_count:1-insert,accepted:[{opportunity_id:record.source_url}]}};
          }
          if (name==='automation_prepare_artifacts') {
            fixture.prepared.push(args.p_opportunity_id);
            return {data:{cv_created:true,email_created:true}};
          }
          throw new Error(`Unexpected RPC ${name}`);
        } };
      },
    },
  };
  boundaries.setFixture(fixture);
  const request=new Request('https://worker.example.org/discovery',{method:'POST',
    body:JSON.stringify({dry_run:dryRun,request_id:'discovery-request'})});
  return boundaries.handleDiscovery(request).then(response=>response.json()).then(result=>({result,fixture}));
}
const oldPosting = {...job,url:source};
const oldRecord = verifyJob(oldPosting,source,settings).opportunity;
const newPosting = {...job,url:'https://careers.example.org/jobs/456'};

test('confirmed daily progress carries over and a checked old posting does not advance the quota', async () => {
  const {result,fixture}=await runDiscovery({target:2,daily:1,previous:[oldRecord],postings:[oldPosting,newPosting]});
  assert.equal(result.status,'completed');
  assert.equal(result.counts.daily_discovered,2);
  assert.equal(result.counts.daily_shortfall,0);
  assert.equal(result.counts.updated_count,1);
  assert.equal(result.counts.inserted_count,1);
  assert.deepEqual(fixture.countCalls,[1,2]);
  assert.deepEqual(fixture.fetched,[oldPosting.url,newPosting.url]);
  assert.ok(fixture.ingested.every(record=>record.classification==='lower'));
});

test('failed quota preserves saved opportunities and reports unavailable broad search', async () => {
  const {result,fixture}=await runDiscovery({target:30,daily:0,previous:[oldRecord],postings:[oldPosting,newPosting]});
  assert.equal(result.status,'failed');
  assert.equal(result.counts.daily_discovered,1);
  assert.equal(result.counts.daily_shortfall,29);
  assert.equal(result.counts.inserted_count,1);
  assert.deepEqual(result.errors,['daily_target_not_reached','search_provider_not_configured']);
  assert.deepEqual(fixture.prepared,[oldPosting.url,newPosting.url]);
});

test('final quota uses authoritative stored events rather than counting write receipts on the wrong day', async () => {
  const {result}=await runDiscovery({target:1,daily:0,previous:[],postings:[newPosting],checkCount:()=>0});
  assert.equal(result.status,'failed');
  assert.equal(result.counts.daily_discovered,0);
  assert.equal(result.counts.daily_shortfall,1);
  assert.equal(result.counts.inserted_count,1);
});

test('dry run estimates distinct new postings and leaves persisted progress unchanged', async () => {
  const {result,fixture}=await runDiscovery({target:1,daily:0,previous:[oldRecord],postings:[oldPosting,newPosting],dryRun:true});
  assert.equal(result.status,'completed');
  assert.equal(result.counts.daily_discovered,0);
  assert.equal(result.counts.daily_shortfall,1);
  assert.equal(result.counts.dry_run_new_candidates,1);
  assert.equal(result.counts.duplicate_count,1);
  assert.deepEqual(fixture.ingested,[]);
  assert.deepEqual(fixture.prepared,[]);
});

test('a filled daily quota still lets a prior attempt repair its application materials', async () => {
  const {result,fixture}=await runDiscovery({target:1,daily:1,previous:[oldRecord],postings:[oldPosting],retry:true});
  assert.equal(result.status,'completed');
  assert.equal(result.counts.daily_discovered,1);
  assert.equal(result.counts.inserted_count,0);
  assert.deepEqual(fixture.prepared,[oldPosting.url]);
});
