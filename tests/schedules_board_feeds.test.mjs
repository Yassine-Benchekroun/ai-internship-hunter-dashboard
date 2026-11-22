import test from 'node:test';
import assert from 'node:assert/strict';
import { boardFeedJobs, boardFeedKind, greenhousePostingEndpoint, greenhousePostingJob } from '../supabase/functions/discover-opportunities/board-feeds.mjs';
import { verifyJob } from '../supabase/functions/discover-opportunities/core.mjs';

const greenhouse = 'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true';
const lever = 'https://api.eu.lever.co/v0/postings/example?mode=json';
const id = 'a0f43a5e-6e8f-48ff-80ef-0dc955cae513';
const settings = { target_countries: ['France', 'United States'], opportunity_types: ['internship', 'research'] };

test('job board endpoints are restricted to known public listing routes', () => {
  assert.equal(boardFeedKind(greenhouse), 'greenhouse_jobs');
  assert.equal(boardFeedKind(lever), 'lever_jobs');
  assert.equal(boardFeedKind(greenhouse.replace('content=true', 'content=false')), null);
  assert.equal(boardFeedKind(`${lever}&mode=html`), null);
  assert.equal(boardFeedKind(greenhouse.replace('.io/', '.io.example.org/')), null);
  assert.equal(boardFeedKind(lever.replace('/example?', '/example/123?')), null);
});

test('Greenhouse jobs retain employer evidence and reject unrelated or substituted posting links', () => {
  const job = {
    id: 123, internal_job_id: 456, title: 'Machine Learning Research Intern',
    absolute_url: 'https://boards.greenhouse.io/example/jobs/123?utm_source=feed',
    content: '&amp;lt;p&amp;gt;Build computer vision models using Python.&amp;lt;/p&amp;gt;',
    location: { name: 'San Francisco, CA' },
  };
  const [posting, ...rest] = boardFeedJobs(greenhouse, { jobs: [
    job,
    { ...job, title: 'Machine Learning Engineer' },
    { ...job, internal_job_id: null },
    { ...job, absolute_url: 'https://job-boards.greenhouse.io/different/jobs/123' },
    { ...job, absolute_url: 'https://job-boards.greenhouse.io/example/jobs/999' },
    { ...job, absolute_url: 'https://private.example.org/example/jobs/123' },
  ] }, 'Example Company');
  assert.deepEqual(rest, []);
  const { opportunity } = verifyJob(posting, posting.url, settings);
  assert.equal(opportunity.organization, 'Example Company');
  assert.equal(opportunity.source_url, 'https://job-boards.greenhouse.io/example/jobs/123');
  assert.equal(opportunity.country, 'United States');
  assert.equal(opportunity.city, 'San Francisco');
  assert.equal(opportunity.description, 'Build computer vision models using Python.');
});

test('Lever jobs normalize documented fields and enforce regional host and exact job ID', () => {
  const job = {
    id, text: 'Machine Learning Internship', descriptionPlain: 'Applied machine learning.',
    hostedUrl: `https://jobs.eu.lever.co/example/${id}`, country: 'FR', workplaceType: 'remote',
    categories: { location: 'Paris', allLocations: ['Paris', 'London, United Kingdom'] },
    lists: [{ text: 'Qualifications', content: '<li>Python</li>' }],
  };
  const [posting, ...rest] = boardFeedJobs(lever, [job, { ...job, hostedUrl: job.hostedUrl.replace('jobs.eu.', 'jobs.') },
    { ...job, hostedUrl: job.hostedUrl.replace('/example/', '/other/') }], 'Example Company');
  assert.deepEqual(rest, []);
  const { opportunity } = verifyJob(posting, posting.url, settings);
  assert.equal(opportunity.country, 'France');
  assert.equal(opportunity.city, 'Paris');
  assert.equal(opportunity.work_mode, 'remote');
  assert.deepEqual(opportunity.requirements, ['Python']);
  assert.equal(verifyJob(posting, posting.url, { ...settings, target_countries: ['Japan'] }).rejected, 'country_not_configured');
  assert.throws(() => boardFeedJobs(lever, { jobs: [] }, 'Example Company'), /Invalid public job board response/);
});

test('a custom job link requires a configured host and exact published Greenhouse ID', () => {
  const job = {
    id: 123, internal_job_id: 456, title: 'Machine Learning Research Intern',
    absolute_url: 'https://careers.example.org/jobs?gh_jid=123',
    content: 'Build computer vision models using Python.', location: { name: 'Paris, France' },
  };
  assert.deepEqual(boardFeedJobs(greenhouse, { jobs: [job] }, 'Example Company'), []);
  const [posting, ...rest] = boardFeedJobs(greenhouse, { jobs: [job,
    { ...job, absolute_url: job.absolute_url.replace('123', '124') },
    { ...job, absolute_url: job.absolute_url.replace('/jobs', '/elsewhere') },
    { ...job, absolute_url: job.absolute_url.replace('careers.example.org', 'wrong.example.org') },
  ] }, 'Example Company', 'careers.example.org');
  assert.equal(posting.url, job.absolute_url);
  assert.deepEqual(rest, []);
});

test('official and explicitly approved custom URLs are tied to a verified Greenhouse detail response', () => {
  const official = 'https://job-boards.greenhouse.io/example/jobs/123';
  const custom = 'https://careers.example.org/jobs?gh_jid=123';
  const approved = [{ source_url: greenhouse, posting_host: 'careers.example.org' }];
  const endpoint = 'https://boards-api.greenhouse.io/v1/boards/example/jobs/123';
  const job = { id: 123, company_name: 'Verified Employer', title: 'AI Intern', content: 'AI internship.',
    application_deadline: '2099-01-01', location: { name: 'Paris, France' } };
  assert.equal(greenhousePostingEndpoint(official), endpoint);
  assert.equal(greenhousePostingEndpoint(custom), null);
  assert.equal(greenhousePostingEndpoint(`${custom}&gh_src=tracking`, approved), endpoint);
  assert.equal(greenhousePostingEndpoint(custom, [...approved, { ...approved[0], source_url: greenhouse.replace('/example/', '/different/') }]), null);
  assert.equal(greenhousePostingJob(custom, endpoint, { ...job, absolute_url: custom }).validThrough, '2099-01-01');
  assert.equal(greenhousePostingJob(official, endpoint, { ...job, absolute_url: official }).hiringOrganization.name, 'Verified Employer');
  assert.equal(greenhousePostingJob(official, endpoint, { ...job, absolute_url: official.replace('/example/', '/other/') }), null);
  assert.equal(greenhousePostingJob(custom, endpoint, { ...job, absolute_url: custom, id: 456 }), null);
  assert.equal(greenhousePostingJob(custom, endpoint, { ...job, absolute_url: official }), null);
});
