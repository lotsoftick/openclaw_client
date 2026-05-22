/**
 * Supervises API + static UI server under one launchd job.
 * Ports come from ~/.openclaw_client/.env (API_PORT, CLIENT_PORT).
 * Installed to ~/.openclaw_client/service-runner.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.dirname(fileURLToPath(import.meta.url));
const API_DIST = path.join(DIST, 'api');
const CLIENT_DIST = path.join(DIST, 'client');
const USER_ENV = path.join(DIST, '.env');
const node = process.execPath;

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const userEnv = parseEnvFile(USER_ENV);
const apiPort = Number(userEnv.API_PORT) || 18802;
const clientPort = Number(userEnv.CLIENT_PORT) || 18800;
// We deliberately do not export ALLOWED_DOMAIN / API_PUBLIC_URL here:
// the API has a permissive CORS default and derives public URLs from
// the request host, so the same install works on localhost, LAN, and
// Tailscale. Users who want strict CORS set ALLOWED_DOMAIN and
// OPENCLAW_STRICT_CORS=1 in ~/.openclaw_client/api/.env themselves.
//
// USE_RELATIVE_API_URL is opt-in and only meaningful for the static
// `serve.mjs` child — it makes the page inject `apiBaseUrl: '/api'`
// into `window.__OPENCLAW_CONFIG__` so the browser issues same-origin
// requests when a reverse proxy fronts the install on a single
// domain. We forward it unconditionally so it survives an upstream
// process restart without re-reading the user .env.
const childEnv = {
  ...process.env,
  NODE_ENV: 'production',
  API_PORT: String(apiPort),
  CLIENT_PORT: String(clientPort),
  PORT: String(apiPort),
  ...(userEnv.USE_RELATIVE_API_URL !== undefined
    ? { USE_RELATIVE_API_URL: userEnv.USE_RELATIVE_API_URL }
    : {}),
};

const children = [];

function killAll(sig = 'SIGTERM') {
  for (const c of children) {
    try {
      c.kill(sig);
    } catch {
      /* ignore */
    }
  }
}

process.on('SIGTERM', () => {
  killAll();
  process.exit(0);
});
process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});

const api = spawn(node, ['build/src/app.js'], {
  cwd: API_DIST,
  env: childEnv,
  stdio: 'inherit',
});

const client = spawn(node, ['serve.mjs'], {
  cwd: CLIENT_DIST,
  env: { ...childEnv, PORT: String(clientPort) },
  stdio: 'inherit',
});

children.push(api, client);

function onChildExit(label, code, signal) {
  const err = signal ? 1 : code ?? 0;
  console.error(`[openclaw] ${label} exited${signal ? ` (signal ${signal})` : ` (code ${code})`}`);
  killAll();
  process.exit(err !== 0 ? 1 : 0);
}

api.on('exit', (code, signal) => onChildExit('api', code, signal));
client.on('exit', (code, signal) => onChildExit('client', code, signal));
