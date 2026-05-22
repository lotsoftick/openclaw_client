import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_DIR = path.join(os.homedir(), '.openclaw_client');
export const USER_ENV_FILE = path.join(USER_DIR, '.env');

export const DEFAULT_API_PORT = 18802;
export const DEFAULT_CLIENT_PORT = 18800;

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (const raw of lines) {
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

/** Ensure ~/.openclaw_client/.env exists. Seeds defaults and backfills any missing keys. */
export function ensureUserEnv() {
  fs.mkdirSync(USER_DIR, { recursive: true });
  if (!fs.existsSync(USER_ENV_FILE)) {
    fs.writeFileSync(
      USER_ENV_FILE,
      [
        '# OpenClaw Client — user configuration',
        '# Change these values then run: openclaw_client restart',
        `API_PORT=${DEFAULT_API_PORT}`,
        `CLIENT_PORT=${DEFAULT_CLIENT_PORT}`,
        '# When you front the client with a reverse proxy (e.g. nginx) on a',
        '# single domain like https://openclaw.example.com and route /api/* to',
        '# the API, set this to 1. The browser will then issue same-origin',
        '# requests to /api/* and the API_PORT is no longer exposed.',
        '# USE_RELATIVE_API_URL=0',
        '',
      ].join('\n'),
    );
    return;
  }
  const current = parseEnvFile(USER_ENV_FILE);
  const additions = [];
  if (current.API_PORT === undefined) additions.push(`API_PORT=${DEFAULT_API_PORT}`);
  if (current.CLIENT_PORT === undefined) additions.push(`CLIENT_PORT=${DEFAULT_CLIENT_PORT}`);
  if (additions.length) {
    const existing = fs.readFileSync(USER_ENV_FILE, 'utf-8');
    const sep = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(USER_ENV_FILE, `${existing}${sep}${additions.join('\n')}\n`);
  }
}

/**
 * Parse the truthy set of values commonly used as boolean env vars. Mirrors
 * the convention used by `OPENCLAW_TRUST_PROXY` so all flags accept the same
 * lenient inputs (1/true/yes/on, any case).
 */
export function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

/** Read the USE_RELATIVE_API_URL toggle from ~/.openclaw_client/.env. */
export function readUseRelativeApiUrl() {
  ensureUserEnv();
  return envFlag(parseEnvFile(USER_ENV_FILE).USE_RELATIVE_API_URL);
}

/** Read port configuration from ~/.openclaw_client/.env (creating it first if missing). */
export function readPorts() {
  ensureUserEnv();
  const env = parseEnvFile(USER_ENV_FILE);
  const apiPort = Number(env.API_PORT) || DEFAULT_API_PORT;
  const clientPort = Number(env.CLIENT_PORT) || DEFAULT_CLIENT_PORT;
  return { apiPort, clientPort };
}

/**
 * Derived env vars for spawning child processes.
 *
 * Note we deliberately do NOT export `ALLOWED_DOMAIN`, `API_PUBLIC_URL`,
 * or `VITE_API_BASE_URL` here, even though the API and client both read
 * those vars. Pinning them to `http://localhost:${port}` would block
 * legitimate access from other devices on the user's LAN / Tailscale —
 * the very deployment pattern this app is designed for. Instead:
 *
 *   - `ALLOWED_DOMAIN` is unset by default; the API ships a permissive
 *     CORS policy and an `OPENCLAW_STRICT_CORS=1` opt-in for the strict
 *     allowlist behaviour.
 *   - `API_PUBLIC_URL` is derived per-request from the `Host` header
 *     (with `x-forwarded-*` honoured) — see `routes/message/controller`.
 *   - `VITE_API_BASE_URL` is left empty so the bundle isn't built with
 *     a baked-in `http://localhost:...` URL; the client derives the
 *     API origin at runtime from `__OPENCLAW_CONFIG__` or
 *     `window.location` — see `client/src/shared/api/baseApi`.
 *
 * Users who want strict mode can still set any of those keys in
 * `~/.openclaw_client/.env` or `api/.env`; nothing here overwrites them.
 *
 * `VITE_API_PORT` is exported so the build can embed a sensible default
 * for the runtime URL derivation when the user installs across a
 * non-standard port.
 */
export function portEnv() {
  ensureUserEnv();
  const userEnv = parseEnvFile(USER_ENV_FILE);
  const apiPort = Number(userEnv.API_PORT) || DEFAULT_API_PORT;
  const clientPort = Number(userEnv.CLIENT_PORT) || DEFAULT_CLIENT_PORT;
  return {
    API_PORT: String(apiPort),
    CLIENT_PORT: String(clientPort),
    PORT: String(apiPort),
    VITE_API_PORT: String(apiPort),
    /* Forward USE_RELATIVE_API_URL from the user .env so reverse-proxy
     * installs survive `openclaw_client restart` on Linux/Windows, where
     * `cli.mjs#detachStart` spawns `serve.mjs` directly (no
     * service-runner shim to re-read the file). The value is preserved
     * verbatim so "0" / "false" still suppress the flag downstream. */
    ...(userEnv.USE_RELATIVE_API_URL !== undefined
      ? { USE_RELATIVE_API_URL: userEnv.USE_RELATIVE_API_URL }
      : {}),
  };
}
