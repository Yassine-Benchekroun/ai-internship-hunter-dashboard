import test from 'node:test';
import assert from 'node:assert/strict';
import { addFact, boundedSourceReader, canonicalSourceUrl, extractExplicitTechnologies, extractPortfolio, factKey,
  fetchText, isPublicAddress, missingFacts, normalizedSources, syncGithub,
} from '../supabase/functions/sync-profile/core.mjs';

const source = { source_type: 'github', source_name: 'approved', source_url: 'https://github.com/example' };
const portfolio = { source_type: 'portfolio', source_name: 'portfolio', source_url: 'https://portfolio.example.com' };

test('timeline dates stay with their own education entry and section labels never become facts', () => {
  const facts = new Map();
  extractPortfolio('<section><h2>Education</h2><div><span class="timeline-date">2025 – Present</span><h3>Masters</h3><h4>University A</h4><p>Current study.</p></div><div><span class="timeline-date">2023 – 2025</span><h3>Preparatory classes</h3><h4>University B</h4><p>Foundation.</p></div></section><section><div>Learning</div><h2>Certificates</h2></section>', portfolio, facts);
  const entries = [...facts.values()];
  assert.match(entries[0].description, /2025 – Present/);
  assert.doesNotMatch(entries[0].description, /2023|University B/);
  assert.match(entries[1].description, /2023 – 2025/);
  assert.doesNotMatch(entries[1].description, /Learning/);
});

test('approval of a profile README repository never enumerates other repositories', async () => {
  const calls = []; const facts = new Map();
  await syncGithub({ ...source, source_url:'https://github.com/example/example' }, facts, { readText: async url => { calls.push(url); return '## Skills\nPython'; } });
  assert.equal(calls.length, 1); assert.match(calls[0], /\/repos\/example\/example\/readme$/);
  assert.equal(facts.size, 1);
});

test('unchanged explicit evidence is deterministic and aliases deduplicate', () => {
  const text = '# Project\n## Tech stack\nPython, sklearn, scikit learn, scikit-learn, OpenCV, opencv-python';
  const facts = new Map();
  extractExplicitTechnologies(text, source, 'README', facts);
  const first = JSON.stringify([...facts.values()]);
  extractExplicitTechnologies(text, source, 'README', facts);
  assert.equal(JSON.stringify([...facts.values()]), first);
  assert.deepEqual([...facts.values()].map(f => f.name).sort(), ['OpenCV', 'Python', 'scikit-learn']);
  assert.equal(factKey('technologies', 'sklearn'), factKey('technology', 'scikit-learn'));
  assert.match(facts.get('technology|scikitlearn').evidence[0].evidence, /README/);
});

test('incidental prose, code dependencies and future ambitions never become verified skills', () => {
  const facts = new Map();
  extractExplicitTechnologies('Python tutorial for visitors\n```\nSkills: React\n```\n## Skills\nLearning TensorFlow next year\n## Dependencies\nNumPy', source, 'README', facts);
  assert.equal(facts.size, 0);
});

test('negative and uncertain technology mentions never become verified facts', () => {
  for (const claim of ['No experience with TensorFlow or PyTorch', 'Not proficient in Python',
    'Unfamiliar with OpenCV', 'Never used AWS', "I haven't used Docker", 'We lack SQL experience']) {
    const facts = new Map();
    extractExplicitTechnologies(`## Skills\n${claim}`, source, 'README', facts);
    assert.equal(facts.size, 0, claim);
  }
  const facts = new Map();
  extractExplicitTechnologies('## Skills\nNoSQL, Python, Machine Learning', source, 'README', facts);
  assert.equal(facts.has(factKey('technology', 'NoSQL')), true);
  assert.equal(facts.has(factKey('technology', 'Python')), true);
  assert.equal(facts.has(factKey('technology', 'Machine Learning')), true);
});

test('all source requests share a budget and receive only their remaining request time', async () => {
  let time = 0; const limits = [];
  const reader = boundedSourceReader({ now: () => time, budgetMs: 90000,
    readText: async (_url, _headers, options) => { limits.push(options.timeoutMs); return 'text'; } });
  await reader('https://example.com');
  time = 85000;
  await reader('https://example.com');
  time = 90000;
  await assert.rejects(reader('https://example.com'), /budget exhausted/);
  assert.deepEqual(limits, [15000, 5000]);
});

test('portfolio only reads explicit sections and retains factual education dates verbatim', () => {
  const facts = new Map();
  extractPortfolio('<script>Skills: Docker</script><p>Read this React tutorial.</p><h2>Skills</h2><p>Python, OpenCV</p><h2>Education</h2><h3>Example degree</h3><p>Example University, 2022–2026</p><h2>Projects</h2><h3>Vision model</h3><p>Image classifier using Python.</p>', portfolio, facts);
  assert.equal(facts.has(factKey('technology', 'React')), false);
  assert.equal(facts.has(factKey('technology', 'Docker')), false);
  assert.equal(facts.get(factKey('education', 'Example degree')).description, 'Example University, 2022–2026');
  assert.equal(facts.get(factKey('project', 'Vision model')).description, 'Image classifier using Python.');
});

test('missing facts require complete success for every evidence source and respect aliases', () => {
  const existing = [{ id: 'one', category: 'technology', name: 'sklearn' }, { id: 'two', category: 'technology', name: 'Python' }];
  const evidence = [{ fact_id: 'one', ...source }, { fact_id: 'two', ...source }, { fact_id: 'two', ...portfolio }];
  const facts = new Map(); addFact(facts, { category: 'technology', name: 'scikit-learn', evidence: [{ ...source, evidence: 'verified' }] });
  assert.deepEqual(missingFacts(existing, evidence, [source], facts), []);
  assert.deepEqual(missingFacts(existing, evidence, [source, portfolio], facts), [{ category: 'technology', name: 'Python' }]);
  assert.deepEqual(missingFacts(existing, evidence, [], new Map()), []);
});

test('GitHub excludes forks, ignores topic tags, includes README direct evidence', async () => {
  const facts = new Map();
  const requests = [];
  const result = await syncGithub(source, facts, { readText: async url => {
    requests.push(url);
    if (url.includes('/users/')) return JSON.stringify([
      { name: 'owned', owner: { login: 'example' }, fork: false, language: 'Python', topics: ['TensorFlow'], description: 'Original project' },
      { name: 'forked', owner: { login: 'example' }, fork: true, language: 'Rust' },
      { name: 'other-owner', owner: { login: 'someone-else' }, language: 'Java' },
    ]);
    return '# Project\n## Built with\nOpenCV';
  } });
  assert.equal(result.complete, true);
  assert.equal(result.discovered, 1);
  assert.equal(requests.length, 2);
  assert.equal(facts.has(factKey('project', 'forked')), false);
  assert.equal(facts.has(factKey('technology', 'Rust')), false);
  assert.equal(facts.has(factKey('technology', 'TensorFlow')), false);
  assert.equal(facts.has(factKey('technology', 'OpenCV')), true);
});

test('GitHub pagination and README failures leave coverage incomplete', async () => {
  const repos = Array.from({ length: 100 }, (_, i) => ({ name: `repo-${i}`, owner: { login: 'example' }, fork: false }));
  const result = await syncGithub(source, new Map(), { maxPages: 1, maxReadmes: 1, readText: async url => {
    if (url.includes('/users/')) return JSON.stringify(repos);
    throw new Error('Source returned HTTP 429');
  } });
  assert.equal(result.complete, false);
  assert.equal(result.warnings.length, 3);
});

test('approved source URLs reject credentials, query secrets, local networks and unusual ports', () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://x.internal', 'https://example.com:8443', 'https://example.com?token=abc']) {
    assert.equal(canonicalSourceUrl(url), null, url);
  }
  assert.deepEqual(normalizedSources([{ ...source, source_url: 'http://github.com/example' }]), []);
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('93.184.216.34'), true);
});

test('fetch validates DNS, forbids redirects, and enforces streamed byte limits', async () => {
  let invoked = false;
  await assert.rejects(fetchText('https://source.example.com', {}, { resolve: async () => ['10.0.0.1'], fetcher: async () => { invoked = true; } }), /not public/);
  assert.equal(invoked, false);
  await assert.rejects(fetchText('https://source.example.com', {}, { maxBytes: 4, resolve: async () => ['93.184.216.34'], fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('12345');
  } }), /too large/);
});
