#!/usr/bin/env node

/**
 * Aion CLI — Aion Outreach Platform
 *
 * Usage:
 *   aion setup     — first-time setup wizard
 *   aion start     — start the Aion server
 *   aion status    — check if running
 *   aion stop      — stop the server
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AION_DIR = join(homedir(), '.aion');
const CONFIG_PATH = join(AION_DIR, 'config.json');
const PID_PATH = join(AION_DIR, 'aion.pid');
const DATA_DIR = join(AION_DIR, 'data');

const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

function log(msg) {
  console.log(`[Aion] ${msg}`);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ── Config ──
const DEFAULT_CONFIG = {
  version: PKG.version,
  sender_name: '',
  sender_email: '',
  gmail_client_id: '',
  gmail_client_secret: '',
  gmail_refresh_token: '',
  daily_send_limit: 100,
  max_leads_per_campaign: 500,
  port: 7443,
  first_run: true,
};

function loadConfig() {
  ensureDir(AION_DIR);
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
}

function saveConfig(cfg) {
  ensureDir(AION_DIR);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── Setup Wizard ──
async function runSetup() {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║           Aion — Setup Wizard            ║
  ║    Intelligent Outreach Platform         ║
  ╚══════════════════════════════════════════╝
  `);

  const cfg = loadConfig();
  const rl = (await import('readline')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q, def) => new Promise(r => rl.question(`  ${q} [${def}]: `, a => r(a || def)));

  try {
    cfg.sender_name = await ask('Your name (appears in emails)', cfg.sender_name || '');
    cfg.sender_email = await ask('Your email address (Gmail)', cfg.sender_email || '');
    cfg.daily_send_limit = parseInt(await ask('Daily send limit (Gmail free: ~500)', String(cfg.daily_send_limit)));
    cfg.max_leads_per_campaign = parseInt(await ask('Max leads per campaign', String(cfg.max_leads_per_campaign)));

    console.log(`
  Setup Summary:
    Name:         ${cfg.sender_name || '(not set)'}
    Email:        ${cfg.sender_email || '(not set)'}
    Daily Limit:  ${cfg.daily_send_limit}
    Max/Campaign: ${cfg.max_leads_per_campaign}
    `);

    cfg.first_run = false;
    saveConfig(cfg);
    console.log(`  ✅ Configuration saved to ~/.aion/config.json`);
    console.log(`  Run "aion start" to start the server.`);
  } finally {
    rl.close();
  }
}

// ── Start Server ──
async function startServer() {
  const cfg = loadConfig();

  if (cfg.first_run) {
    log('First run detected. Running setup wizard...');
    await runSetup();
    // Re-read config after setup
    Object.assign(cfg, loadConfig());
  }

  // Check if already running
  if (existsSync(PID_PATH)) {
    const pid = parseInt(readFileSync(PID_PATH, 'utf-8').trim());
    try {
      process.kill(pid, 0);
      log(`Server already running (PID ${pid})`);
      return;
    } catch {
      // Stale PID, clean it
      log('Removing stale PID file');
    }
  }

  ensureDir(DATA_DIR);

  const serverPath = join(__dirname, '..', 'lib', 'server.mjs');
  log(`Starting Aion v${PKG.version} on port ${cfg.port}...`);

  const proc = spawn(process.execPath, [serverPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      AION_PORT: String(cfg.port || 7443),
      AION_HOME: AION_DIR,
    },
  });

  writeFileSync(PID_PATH, String(proc.pid));

  proc.on('exit', (code, signal) => {
    log(`Server exited (code: ${code}, signal: ${signal})`);
    try { writeFileSync(PID_PATH, ''); } catch {}
  });

  // Handle parent signals — forward to child
  process.on('SIGINT', () => {
    log('Shutting down...');
    proc.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  });
  process.on('SIGTERM', () => {
    proc.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  });

  // Wait a moment, then show status
  setTimeout(() => {
    log(`Server running on https://localhost:${cfg.port || 7443}`);
    log(`PID: ${proc.pid}`);
  }, 1000);
}

// ── Status ──
function status() {
  if (!existsSync(PID_PATH)) {
    log('Not running');
    return;
  }
  const raw = readFileSync(PID_PATH, 'utf-8').trim();
  if (!raw) {
    log('Not running');
    return;
  }
  const pid = parseInt(raw);
  try {
    process.kill(pid, 0);
    log(`Running (PID ${pid})`);
    const cfg = loadConfig();
    console.log(`  Web UI: https://localhost:${cfg.port || 7443}`);
    console.log(`  Data:   ${DATA_DIR}`);
  } catch {
    log('Not running (stale PID)');
    writeFileSync(PID_PATH, '');
  }
}

// ── Stop ──
function stop() {
  if (!existsSync(PID_PATH)) {
    log('Not running');
    return;
  }
  const raw = readFileSync(PID_PATH, 'utf-8').trim();
  if (!raw) {
    log('Not running');
    return;
  }
  const pid = parseInt(raw);
  try {
    process.kill(pid, 'SIGTERM');
    log(`Stopped (PID ${pid})`);
  } catch {
    log('Not running');
  }
  try { writeFileSync(PID_PATH, ''); } catch {}
}

// ── Main ──
const cmd = process.argv[2] || 'start';

switch (cmd) {
  case 'setup':
    await runSetup();
    break;
  case 'start':
    await startServer();
    break;
  case 'status':
    status();
    break;
  case 'stop':
    stop();
    break;
  default:
    console.log(`
  Aion v${PKG.version} — Intelligent Outreach Platform

  Usage:
    aion setup     Set up sender identity and preferences
    aion start     Start the Aion server (default)
    aion status    Check if the server is running
    aion stop      Stop the server
    `);
}
