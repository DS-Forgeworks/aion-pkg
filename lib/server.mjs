#!/usr/bin/env node

/**
 * Aion Backend Server
 * Self-contained Node.js HTTPS server (no Express, no npm deps beyond openclaw).
 * Serves static files from ../web/, JSON APIs for lead management, campaigns,
 * templates, settings, and stats.
 *
 * Usage:
 *   AION_PORT=7443 node lib/server.mjs
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, statSync, unlinkSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, generateKeyPairSync } from 'crypto';
import { execSync } from 'child_process';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AION_DIR = process.env.AION_HOME || join(os.homedir(), '.aion');
const CONFIG_PATH = join(AION_DIR, 'config.json');
const DB_DIR = join(AION_DIR, 'data');
const KEY_PATH = join(AION_DIR, 'server.key');
const CERT_PATH = join(AION_DIR, 'server.crt');

// ── Bootstrap ──
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
if (!existsSync(AION_DIR)) mkdirSync(AION_DIR, { recursive: true });

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
    // Use openssl to generate a proper self-signed cert
    execSync(
      `openssl req -x509 -new -key "${KEY_PATH}" -days 365 -out "${CERT_PATH}" -subj '/CN=Aion/O=Aion Outreach/C=US' -addext 'subjectAltName=DNS:localhost,DNS:aion.local,IP:127.0.0.1' 2>/dev/null`,
      { timeout: 15000 }
    );
  } catch {
    // Fallback without -addext (older openssl)
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

// ── API Auth ──
function checkAuth(req) {
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
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
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

// ── Route table ──
const routes = [
  // Format: { method, pattern, handler }
  { method: 'GET', pattern: '/api/health', handler: () => ({ status: 'ok', version: '1.0.0' }) },

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

  { method: 'GET', pattern: '/api/leads', handler: (_, __, url) => {
    const leads = readDB('leads');
    const filterStatus = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    let filtered = leads;
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

  { method: 'POST', pattern: '/api/leads', handler: async (_, body) => {
    const leads = readDB('leads');
    const lead = { id: randomBytes(8).toString('hex'), ...body, status: body.status || 'sourced', created_at: new Date().toISOString() };
    leads.unshift(lead);
    writeDB('leads', leads);
    return { status: 'ok', lead };
  }},

  { method: 'PATCH', pattern: '/api/leads/:id', handler: async (params, body) => {
    const leads = readDB('leads');
    const idx = leads.findIndex(l => l.id === params.id);
    if (idx === -1) return [404, { error: 'Lead not found' }];
    Object.assign(leads[idx], body, { updated_at: new Date().toISOString() });
    writeDB('leads', leads);
    return { status: 'ok', lead: leads[idx] };
  }},

  { method: 'DELETE', pattern: '/api/leads/:id', handler: async (params) => {
    const leads = readDB('leads').filter(l => l.id !== params.id);
    writeDB('leads', leads);
    return { status: 'ok' };
  }},

  { method: 'GET', pattern: '/api/campaigns', handler: () => ({ campaigns: readDB('campaigns') }) },

  { method: 'POST', pattern: '/api/campaigns', handler: async (_, body) => {
    const campaigns = readDB('campaigns');
    const campaign = {
      id: randomBytes(8).toString('hex'), ...body, status: 'draft',
      sent_count: 0, reply_count: 0, created_at: new Date().toISOString(),
    };
    campaigns.unshift(campaign);
    writeDB('campaigns', campaigns);
    return { status: 'ok', campaign };
  }},

  { method: 'PATCH', pattern: '/api/campaigns/:id', handler: async (params, body) => {
    const campaigns = readDB('campaigns');
    const idx = campaigns.findIndex(c => c.id === params.id);
    if (idx === -1) return [404, { error: 'Campaign not found' }];
    Object.assign(campaigns[idx], body, { updated_at: new Date().toISOString() });
    writeDB('campaigns', campaigns);
    return { status: 'ok', campaign: campaigns[idx] };
  }},

  { method: 'GET', pattern: '/api/templates', handler: () => ({ templates: readDB('templates') }) },

  { method: 'POST', pattern: '/api/templates', handler: async (_, body) => {
    const templates = readDB('templates');
    const tmpl = { id: randomBytes(8).toString('hex'), ...body, created_at: new Date().toISOString() };
    templates.unshift(tmpl);
    writeDB('templates', templates);
    return { status: 'ok', template: tmpl };
  }},

  { method: 'DELETE', pattern: '/api/templates/:id', handler: async (params) => {
    const templates = readDB('templates').filter(t => t.id !== params.id);
    writeDB('templates', templates);
    return { status: 'ok' };
  }},

  { method: 'GET', pattern: '/api/stats', handler: () => {
    const leads = readDB('leads');
    const campaigns = readDB('campaigns');
    return {
      total_leads: leads.length,
      sourced: leads.filter(l => l.status === 'sourced').length,
      contacted: leads.filter(l => l.status === 'contacted').length,
      qualified: leads.filter(l => l.status === 'qualified').length,
      total_campaigns: campaigns.length,
      active_campaigns: campaigns.filter(c => c.status === 'running').length,
      total_sent: campaigns.reduce((a, c) => a + (c.sent_count || 0), 0),
      total_replies: campaigns.reduce((a, c) => a + (c.reply_count || 0), 0),
    };
  }},

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

// ── Request Handler ──
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

  // Auth check for API routes
  if (path.startsWith('/api/') && !path.startsWith('/api/health')) {
    if (!checkAuth(req)) {
      sendError(res, 401, 'Unauthorized: missing or invalid API key');
      return;
    }
  }

  try {
    // Try matching API routes
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchRoute(route.pattern, path);
      if (!params) continue;

      let body = {};
      if (method === 'POST' || method === 'PATCH') {
        body = await parseBody(req);
      }

      const result = await route.handler(params, body, url);

      // Handler can return [statusCode, data] for errors
      if (Array.isArray(result)) {
        sendJSON(res, result[0], result[1]);
      } else {
        sendJSON(res, method === 'POST' ? 201 : 200, result);
      }
      return;
    }

    // ── Static file serving ──
    if (path.startsWith('/api/')) {
      sendError(res, 404, 'API endpoint not found');
      return;
    }

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

// ── Boot ──
const PORT = parseInt(process.env.AION_PORT || '7443');

ensureCert();

const tlsOpts = {
  key: readFileSync(KEY_PATH),
  cert: readFileSync(CERT_PATH),
};

const { createServer } = await import('https');
const server = createServer(tlsOpts, handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  const cfg = loadConfig();
  console.log(`[Aion] Server running on https://0.0.0.0:${PORT}`);
  console.log(`[Aion] Data directory: ${DB_DIR}`);
  console.log(`[Aion] Web UI: https://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
