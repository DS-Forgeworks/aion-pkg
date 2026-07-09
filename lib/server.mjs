#!/usr/bin/env node

/**
 * Aion Backend Server
 * Self-contained Node.js HTTPS server (no Express, no npm deps beyond openclaw + ws).
 * Serves static files from ../web/, JSON APIs for lead management, campaigns,
 * templates, settings, stats, user auth, and WebSocket proxy support.
 *
 * Usage:
 *   AION_PORT=7443 node lib/server.mjs
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, statSync, unlinkSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, scryptSync, generateKeyPairSync } from 'crypto';
import { execSync } from 'child_process';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AION_DIR = process.env.AION_HOME || join(os.homedir(), '.aion');
const CONFIG_PATH = join(AION_DIR, 'config.json');
const DB_DIR = join(AION_DIR, 'data');
const KEY_PATH = join(AION_DIR, 'server.key');
const CERT_PATH = join(AION_DIR, 'server.crt');
const USERS_PATH = join(DB_DIR, 'users.json');

// ── Bootstrap ──
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
if (!existsSync(AION_DIR)) mkdirSync(AION_DIR, { recursive: true });
if (!existsSync(USERS_PATH)) writeFileSync(USERS_PATH, '[]');

// ── Config ──
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

// ── JSON File DB ──
function dbPath(name) {
  return join(DB_DIR, `${name}.json`);
}

function readDB(name) {
  const p = dbPath(name);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

function writeDB(name, data) {
  writeFileSync(dbPath(name), JSON.stringify(data, null, 2));
}

// ── User / Auth System ──

/** In-memory session store: token → { userId, username, role, createdAt } */
const sessions = new Map();

function readUsers() {
  try {
    return JSON.parse(readFileSync(USERS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function createUser(username, password, role = 'user') {
  const users = readUsers();
  if (users.find(u => u.username === username)) {
    throw new Error('Username already exists');
  }
  const salt = randomBytes(16).toString('hex');
  const password_hash = hashPassword(password, salt);
  const user = {
    id: randomBytes(8).toString('hex'),
    username,
    password_hash,
    salt,
    role,
    created_at: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  return { id: user.id, username: user.username, role: user.role, created_at: user.created_at };
}

function authenticateUser(username, password) {
  const users = readUsers();
  const user = users.find(u => u.username === username);
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash) return null;
  return user;
}

function createSession(user) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role || 'user',
    createdAt: Date.now(),
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;

  // Lazy expiry check (24h)
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

function requireAuth(req) {
  // Also accept x-api-key as an alternative auth for backward compat
  const apiKey = req.headers['x-api-key'];
  const cfg = loadConfig();
  if (apiKey && apiKey === (cfg.api_key || process.env.AION_API_KEY)) {
    return { userId: 'api', username: 'api', role: 'admin' };
  }

  const authHeader = req.headers['x-session-token'] || req.headers['authorization'];
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null;
  return getSession(token);
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/truetype',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.map': 'application/json',
};

// ── Self-signed TLS via openssl ──
function ensureCert() {
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) return;
  console.log('[Aion] Generating self-signed TLS certificate...');

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  writeFileSync(KEY_PATH, privateKey);

  try {
    execSync(
      `openssl req -x509 -new -key "${KEY_PATH}" -days 365 -out "${CERT_PATH}" -subj '/CN=Aion/O=Aion Outreach/C=US' -addext 'subjectAltName=DNS:localhost,DNS:aion.local,IP:127.0.0.1' 2>/dev/null`,
      { timeout: 15000 }
    );
  } catch {
    execSync(
      `openssl req -x509 -new -key "${KEY_PATH}" -days 365 -out "${CERT_PATH}" -subj '/CN=Aion/O=Aion Outreach/C=US' 2>/dev/null`,
      { timeout: 15000 }
    );
  }

  if (!existsSync(CERT_PATH)) {
    console.error('[Aion] ERROR: Could not generate TLS certificate. Install openssl and retry.');
    process.exit(1);
  }
  console.log(`[Aion] TLS cert generated at ${CERT_PATH}`);
}

// ── Old API Auth (backward compat) ──
function checkAPIKeyAuth(req) {
  const cfg = loadConfig();
  const key = cfg.api_key || process.env.AION_API_KEY;
  if (!key) return true;
  const header = req.headers['x-api-key'];
  const url = new URL(req.url, 'http://localhost');
  const query = url.searchParams.get('key');
  return header === key || query === key;
}

// ── Body parser ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ── Response helpers ──
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Session-Token, Authorization',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(body);
}

function sendError(res, status, msg) {
  sendJSON(res, status, { error: msg });
}

function sendFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  try {
    const stat = statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendError(res, 404, 'File not found');
  }
}

// ── Simple path-to-regexp matcher ──
function matchRoute(pattern, pathname) {
  const parts = pattern.split('/');
  const pParts = pathname.split('/');
  if (parts.length !== pParts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      params[parts[i].slice(1)] = pParts[i];
    } else if (parts[i] !== pParts[i]) {
      return null;
    }
  }
  return params;
}

/** Check if a path requires auth. Returns false for public endpoints. */
function isPublicRoute(pathname) {
  return pathname === '/api/health' ||
         pathname === '/api/auth/login' ||
         pathname === '/api/network' ||
         (!pathname.startsWith('/api/'));
}

// ── Helper: filter user data ──
function filterUserData(session, items, userIdField = 'user_id') {
  if (!session) return [];
  if (session.role === 'admin' || session.userId === 'api') return items;
  return items.filter(i => i[userIdField] === session.userId);
}

// ── Route table ──
const routes = [
  // ── Health ──
  { method: 'GET', pattern: '/api/health', handler: () => ({ status: 'ok', version: '1.0.0' }) },

  // ── Auth ──
  { method: 'POST', pattern: '/api/auth/login', handler: async (_, body) => {
    const { username, password } = body;
    if (!username || !password) return [400, { error: 'Username and password required' }];
    const user = authenticateUser(username, password);
    if (!user) return [401, { error: 'Invalid credentials' }];
    const token = createSession(user);
    return { token, user: { id: user.id, username: user.username, role: user.role } };
  }},

  { method: 'POST', pattern: '/api/auth/logout', handler: async (_, __, ___, session) => {
    // Token passed in body or header
    destroySession(session ? session.token : null);
    return { status: 'ok' };
  }},

  { method: 'GET', pattern: '/api/auth/me', handler: async (_, __, ___, session) => {
    if (!session) return [401, { error: 'Not authenticated' }];
    return { user: { id: session.userId, username: session.username, role: session.role } };
  }},

  // ── Config ──
  { method: 'GET', pattern: '/api/config', handler: () => {
    const cfg = loadConfig();
    return {
      sender_name: cfg.sender_name || '',
      sender_email: cfg.sender_email || '',
      daily_send_limit: cfg.daily_send_limit || 100,
      max_leads_per_campaign: cfg.max_leads_per_campaign || 500,
      setup_complete: !cfg.first_run,
    };
  }},

  { method: 'POST', pattern: '/api/config', handler: async (_, body) => {
    const cfg = loadConfig();
    if (body.sender_name !== undefined) cfg.sender_name = body.sender_name;
    if (body.sender_email !== undefined) cfg.sender_email = body.sender_email;
    if (body.daily_send_limit !== undefined) cfg.daily_send_limit = parseInt(body.daily_send_limit) || 100;
    if (body.max_leads_per_campaign !== undefined) cfg.max_leads_per_campaign = parseInt(body.max_leads_per_campaign) || 500;
    cfg.first_run = false;
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return { status: 'ok' };
  }},

  // ── Users (admin only) ──
  { method: 'GET', pattern: '/api/users', handler: async (_, __, ___, session) => {
    if (!session || session.role !== 'admin') return [403, { error: 'Admin only' }];
    return { users: readUsers().map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at })) };
  }},

  { method: 'POST', pattern: '/api/users', handler: async (_, body, ___, session) => {
    if (!session || session.role !== 'admin') return [403, { error: 'Admin only' }];
    try {
      const user = createUser(body.username, body.password, body.role || 'user');
      return { status: 'ok', user };
    } catch (e) {
      return [400, { error: e.message }];
    }
  }},

  // ── Leads ──
  { method: 'GET', pattern: '/api/leads', handler: (_, __, url, session) => {
    const leads = readDB('leads');
    const filterStatus = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    let filtered = filterUserData(session, leads);
    if (filterStatus) filtered = filtered.filter(l => l.status === filterStatus);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(l =>
        (l.name || '').toLowerCase().includes(q) ||
        (l.email || '').toLowerCase().includes(q) ||
        (l.company || '').toLowerCase().includes(q)
      );
    }
    return { leads: filtered, total: leads.length, filtered: filtered.length };
  }},

  { method: 'POST', pattern: '/api/leads', handler: async (_, body, __, session) => {
    const leads = readDB('leads');
    const lead = {
      id: randomBytes(8).toString('hex'),
      ...body,
      user_id: session ? session.userId : null,
      status: body.status || 'sourced',
      created_at: new Date().toISOString(),
    };
    leads.unshift(lead);
    writeDB('leads', leads);
    return { status: 'ok', lead };
  }},

  { method: 'PATCH', pattern: '/api/leads/:id', handler: async (params, body, __, session) => {
    const leads = readDB('leads');
    const idx = leads.findIndex(l => l.id === params.id);
    if (idx === -1) return [404, { error: 'Lead not found' }];

    // Ownership check
    if (session && session.role !== 'admin' && session.userId !== 'api' && leads[idx].user_id !== session.userId) {
      return [403, { error: 'Not your lead' }];
    }

    Object.assign(leads[idx], body, { updated_at: new Date().toISOString() });
    writeDB('leads', leads);
    return { status: 'ok', lead: leads[idx] };
  }},

  { method: 'DELETE', pattern: '/api/leads/:id', handler: async (params, _, __, session) => {
    const leads = readDB('leads');
    const idx = leads.findIndex(l => l.id === params.id);
    if (idx === -1) return [404, { error: 'Lead not found' }];

    // Ownership check
    if (session && session.role !== 'admin' && session.userId !== 'api' && leads[idx].user_id !== session.userId) {
      return [403, { error: 'Not your lead' }];
    }

    writeDB('leads', leads.filter(l => l.id !== params.id));
    return { status: 'ok' };
  }},

  // ── Campaigns ──
  { method: 'GET', pattern: '/api/campaigns', handler: (_, __, ___, session) => {
    return { campaigns: filterUserData(session, readDB('campaigns')) };
  }},

  { method: 'POST', pattern: '/api/campaigns', handler: async (_, body, __, session) => {
    const campaigns = readDB('campaigns');
    const campaign = {
      id: randomBytes(8).toString('hex'), ...body,
      user_id: session ? session.userId : null,
      status: 'draft',
      sent_count: 0, reply_count: 0,
      created_at: new Date().toISOString(),
    };
    campaigns.unshift(campaign);
    writeDB('campaigns', campaigns);
    return { status: 'ok', campaign };
  }},

  { method: 'PATCH', pattern: '/api/campaigns/:id', handler: async (params, body, __, session) => {
    const campaigns = readDB('campaigns');
    const idx = campaigns.findIndex(c => c.id === params.id);
    if (idx === -1) return [404, { error: 'Campaign not found' }];

    if (session && session.role !== 'admin' && session.userId !== 'api' && campaigns[idx].user_id !== session.userId) {
      return [403, { error: 'Not your campaign' }];
    }

    Object.assign(campaigns[idx], body, { updated_at: new Date().toISOString() });
    writeDB('campaigns', campaigns);
    return { status: 'ok', campaign: campaigns[idx] };
  }},

  // ── Templates ──
  { method: 'GET', pattern: '/api/templates', handler: (_, __, ___, session) => {
    return { templates: filterUserData(session, readDB('templates')) };
  }},

  { method: 'POST', pattern: '/api/templates', handler: async (_, body, __, session) => {
    const templates = readDB('templates');
    const tmpl = {
      id: randomBytes(8).toString('hex'), ...body,
      user_id: session ? session.userId : null,
      created_at: new Date().toISOString(),
    };
    templates.unshift(tmpl);
    writeDB('templates', templates);
    return { status: 'ok', template: tmpl };
  }},

  { method: 'DELETE', pattern: '/api/templates/:id', handler: async (params, _, __, session) => {
    const templates = readDB('templates');
    const idx = templates.findIndex(t => t.id === params.id);
    if (idx === -1) return [404, { error: 'Template not found' }];

    if (session && session.role !== 'admin' && session.userId !== 'api' && templates[idx].user_id !== session.userId) {
      return [403, { error: 'Not your template' }];
    }

    writeDB('templates', templates.filter(t => t.id !== params.id));
    return { status: 'ok' };
  }},

  // ── Stats ──
  { method: 'GET', pattern: '/api/stats', handler: (_, __, ___, session) => {
    const allLeads = filterUserData(session, readDB('leads'));
    const allCampaigns = filterUserData(session, readDB('campaigns'));
    return {
      total_leads: allLeads.length,
      sourced: allLeads.filter(l => l.status === 'sourced').length,
      contacted: allLeads.filter(l => l.status === 'contacted').length,
      qualified: allLeads.filter(l => l.status === 'qualified').length,
      total_campaigns: allCampaigns.length,
      active_campaigns: allCampaigns.filter(c => c.status === 'running').length,
      total_sent: allCampaigns.reduce((a, c) => a + (c.sent_count || 0), 0),
      total_replies: allCampaigns.reduce((a, c) => a + (c.reply_count || 0), 0),
    };
  }},

  // ── Network info ──
  { method: 'GET', pattern: '/api/network', handler: () => {
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({ name, address: net.address });
        }
      }
    }
    return { addresses };
  }},
];

// ── Route a request (shared by HTTP handler and WebSocket proxy) ──
async function routeRequest(method, url, body, session) {
  const parsedUrl = new URL(url, 'http://localhost');
  const path = parsedUrl.pathname;

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchRoute(route.pattern, path);
    if (!params) continue;

    let parsedBody = {};
    if (method === 'POST' || method === 'PATCH') {
      parsedBody = body || {};
    }

    const result = await route.handler(params, parsedBody, parsedUrl, session);

    if (Array.isArray(result)) {
      return { status: result[0], body: result[1] };
    }
    return { status: method === 'POST' ? 201 : 200, body: result };
  }

  return null;
}

// ── HTTP Request Handler ──
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Auth: get session for this request
  let session = null;
  if (path.startsWith('/api/')) {
    // Public routes don't require auth
    if (!isPublicRoute(path)) {
      session = requireAuth(req);
      if (!session) {
        sendError(res, 401, 'Authentication required. Provide x-session-token header or x-api-key.');
        return;
      }
    }
  }

  try {
    // Try matching API routes via the shared router
    if (path.startsWith('/api/')) {
      let body = {};
      if (method === 'POST' || method === 'PATCH') {
        body = await parseBody(req);
      }

      const result = await routeRequest(method, req.url, body, session);
      if (result) {
        sendJSON(res, result.status, result.body);
        return;
      }

      sendError(res, 404, 'API endpoint not found');
      return;
    }

    // ── Static file serving ──
    const webDir = join(ROOT, 'web');
    let filePath = path === '/' ? join(webDir, 'index.html') : join(webDir, path);

    // Security: prevent directory traversal
    if (!filePath.startsWith(webDir)) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(webDir, 'index.html');
    }

    sendFile(res, filePath);

  } catch (err) {
    console.error('[Aion] Server error:', err);
    sendError(res, 500, 'Internal server error');
  }
}

// ── WebSocket Proxy Handler ──
async function handleWsRequest(ws, msg) {
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (msg.type === 'request') {
    const { id, method, path, headers, body } = msg;

    // Authenticate: check x-api-key or x-session-token in WS query or headers
    const fakeReq = { headers: { 'x-session-token': headers?.['x-session-token'] || null } };
    let session = requireAuth(fakeReq);

    if (!session && path.startsWith('/api/') && !isPublicRoute(path)) {
      ws.send(JSON.stringify({
        type: 'response',
        id,
        status: 401,
        body: { error: 'Authentication required' },
      }));
      return;
    }

    try {
      const result = await routeRequest(method, path, body, session);

      if (result) {
        const response = { type: 'response', id, status: result.status, body: result.body };
        ws.send(JSON.stringify(response));
      } else {
        // Static file proxy — read and return the file
        const webDir = join(ROOT, 'web');
        let filePath = path === '/' ? join(webDir, 'index.html') : join(webDir, path);

        if (!filePath.startsWith(webDir)) {
          ws.send(JSON.stringify({ type: 'response', id, status: 403, body: { error: 'Forbidden' } }));
          return;
        }

        if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
          const ext = extname(filePath).toLowerCase();
          const contentType = MIME[ext] || 'application/octet-stream';
          const content = readFileSync(filePath, 'utf-8');
          ws.send(JSON.stringify({
            type: 'response',
            id,
            status: 200,
            contentType,
            body: content,
          }));
        } else {
          // Try index.html for SPA routing
          const indexPath = join(webDir, 'index.html');
          if (existsSync(indexPath)) {
            const content = readFileSync(indexPath, 'utf-8');
            ws.send(JSON.stringify({
              type: 'response',
              id,
              status: 200,
              contentType: 'text/html',
              body: content,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'response',
              id,
              status: 404,
              body: { error: 'Not found' },
            }));
          }
        }
      }
    } catch (err) {
      console.error('[Aion] WS router error:', err);
      ws.send(JSON.stringify({
        type: 'response',
        id,
        status: 500,
        body: { error: 'Internal server error' },
      }));
    }
  }
}

// ── Boot ──
const PORT = parseInt(process.env.AION_PORT || '7443');

ensureCert();

const tlsOpts = {
  key: readFileSync(KEY_PATH),
  cert: readFileSync(CERT_PATH),
};

const { createServer } = await import('https');
const server = createServer(tlsOpts, handleRequest);

// ── WebSocket Server ──
// Use the ws package (added to package.json dependencies)
let wss = null;
try {
  const { WebSocketServer } = await import('ws');
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');

    // Auth via query param: ?key=API_KEY
    const queryKey = url.searchParams.get('key');
    const cfg = loadConfig();
    const serverKey = cfg.api_key || process.env.AION_API_KEY;

    if (serverKey && queryKey !== serverKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    console.log('[Aion] WebSocket client connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsRequest(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      console.log('[Aion] WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[Aion] WebSocket error:', err.message);
    });
  });

  console.log('[Aion] WebSocket server ready on /ws');
} catch (err) {
  console.log('[Aion] ws package not available, WebSocket server disabled.');
  console.log('[Aion] Install with: npm install ws');
}

server.listen(PORT, '0.0.0.0', () => {
  const cfg = loadConfig();
  console.log(`[Aion] Server running on https://0.0.0.0:${PORT}`);
  console.log(`[Aion] Data directory: ${DB_DIR}`);
  console.log(`[Aion] Web UI: https://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
