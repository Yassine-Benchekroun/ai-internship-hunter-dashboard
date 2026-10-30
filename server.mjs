import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
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
  threshold: 70,
  countries: ['United States', 'France', 'Germany', 'Spain', 'United Arab Emirates', 'Saudi Arabia', 'China', 'Japan'],
  qualityTarget: 30,
  search: '',
  filters: { country: 'All', type: 'All', status: 'All', sort: 'score' },
  selected: [],
  emailDrafts: {}
};

async function ensureStore() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dataFile)) await writeFile(dataFile, JSON.stringify(initialState, null, 2), 'utf8');
}

async function readState() {
  await ensureStore();
  return JSON.parse(await readFile(dataFile, 'utf8'));
}

async function writeState(nextState) {
  await ensureStore();
  const payload = {
    ...initialState,
    ...nextState,
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

    if (req.method === 'PUT' && url.pathname === '/api/state') {
      const nextState = JSON.parse(await readRequestBody(req));
      if (!Array.isArray(nextState.opportunities) || !Array.isArray(nextState.applications)) {
        return sendJson(res, 400, { error: 'State must contain opportunities and applications arrays.' });
      }
      return sendJson(res, 200, await writeState(nextState));
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

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Internship Hunter local server: http://127.0.0.1:${port}/`);
  console.log(`JSON store: ${dataFile}`);
});

