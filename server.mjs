import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AIH_DATA_DIR ? path.resolve(process.env.AIH_DATA_DIR) : path.join(root, 'data');
const dataFile = path.join(dataDir, 'dashboard-data.json');
const distDir = path.join(root, 'dist');
const port = Number(process.env.PORT || 4173);

const initialState = {
  storage: 'json-file',
  opportunities: [],
  applications: [],
  route: 'overview',
  connected: false,
  connectedEmail: null,
  emailProvider: '',
  senderIdentityName: null,
  providerConnectionStatus: 'not_connected',
  emailProviderConnected: false,
  threshold: 70,
  countries: [],
  qualityTarget: 30,
  domainRelevanceEnabled: true,
  opportunityTypes: ['internship', 'research'],
  approvedProfileSources: [],
  search: '',
  filters: { country: 'All', type: 'All', status: 'All', sort: 'score' },
  selected: [],
  emailDrafts: {}
};

function stringList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback.slice();
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function approvedSources(value) {
  if (!Array.isArray(value)) return [];
  return value.map((source) => {
    if (!source || typeof source !== 'object') return null;
    const normalized = {
      source_type: String(source.source_type ?? '').trim(),
      source_name: String(source.source_name ?? '').trim(),
      source_url: String(source.source_url ?? '').trim()
    };
    return normalized.source_type && normalized.source_name && normalized.source_url ? normalized : null;
  }).filter(Boolean);
}

function normalizeSettings(state) {
  const providerConnectionStatus = ['not_connected', 'connected', 'revoked', 'error'].includes(state.providerConnectionStatus)
    ? state.providerConnectionStatus
    : 'not_connected';
  return {
    threshold: Number.isFinite(Number(state.threshold)) ? Math.max(0, Math.min(100, Math.round(Number(state.threshold)))) : 70,
    qualityTarget: Number.isFinite(Number(state.qualityTarget)) ? Math.max(0, Math.min(1000, Math.round(Number(state.qualityTarget)))) : 30,
    domainRelevanceEnabled: state.domainRelevanceEnabled !== false,
    countries: stringList(state.countries),
    opportunityTypes: stringList(state.opportunityTypes, initialState.opportunityTypes),
    approvedProfileSources: approvedSources(state.approvedProfileSources),
    connectedEmail: typeof state.connectedEmail === 'string' ? state.connectedEmail.trim() : null,
    senderIdentityName: typeof state.senderIdentityName === 'string' ? state.senderIdentityName.trim() : null,
    providerConnectionStatus,
    emailProviderConnected: providerConnectionStatus === 'connected'
  };
}

async function ensureStore() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dataFile)) await writeFile(dataFile, JSON.stringify(initialState, null, 2), 'utf8');
}

async function readState() {
  await ensureStore();
  const saved = JSON.parse(await readFile(dataFile, 'utf8'));
  return { ...initialState, ...saved, ...normalizeSettings(saved) };
}

async function writeState(nextState) {
  await ensureStore();
  const normalizedSettings = normalizeSettings(nextState);
  const payload = {
    ...initialState,
    ...nextState,
    ...normalizedSettings,
    storage: 'json-file',
    savedAt: new Date().toISOString()
  };
  await writeFile(dataFile, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function settingsPayload(state) {
  return normalizeSettings(state);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, storage: dataFile });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, await readState());
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, 200, settingsPayload(await readState()));
    }

    if (req.method === 'PUT' && url.pathname === '/api/state') {
      const nextState = JSON.parse(await readRequestBody(req));
      if (!Array.isArray(nextState.opportunities) || !Array.isArray(nextState.applications)) {
        return sendJson(res, 400, { error: 'State must contain opportunities and applications arrays.' });
      }
      return sendJson(res, 200, await writeState(nextState));
    }

    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const settings = JSON.parse(await readRequestBody(req));
      const current = await readState();
      const saved = await writeState({ ...current, ...settings });
      return sendJson(res, 200, settingsPayload(saved));
    }

    if (req.method === 'GET') {
      const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const filePath = path.resolve(distDir, `.${requested}`);
      if (!filePath.startsWith(path.resolve(distDir) + path.sep) || !existsSync(filePath)) {
        return sendJson(res, 404, { error: 'Not found' });
      }
      res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
      res.end(await readFile(filePath));
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Internship Hunter local server: http://127.0.0.1:${port}/`);
    console.log(`JSON store: ${dataFile}`);
  });
}

export { initialState, normalizeSettings, readState, server, settingsPayload, writeState };

