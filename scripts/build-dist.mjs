import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { portEnv, readPorts } from './ports.mjs';
import { NPM_BIN } from './proc.mjs';

const SERVE_MJS = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const DIST_REAL = fs.realpathSync(DIST);
const PORT = Number(process.env.CLIENT_PORT) || Number(process.env.PORT) || 18800;
const API_PORT = Number(process.env.API_PORT) || 18802;

// When the install sits behind a reverse proxy on a single domain
// (https://openclaw.example.com) and the operator routes /api/* to the
// API, this flag tells the browser to use \`/api\` instead of a
// host:port URL. We resolve it once at startup — flipping the value
// requires a restart, which is consistent with how API_PORT / CLIENT_PORT
// work.
const USE_RELATIVE_API_URL = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.USE_RELATIVE_API_URL || '').toLowerCase()
);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

// Service-worker files must not be cached long-term or users get stuck on
// old bundles. Everything else can use the default (immutable hashed names).
const NO_CACHE_FILES = new Set(['sw.js', 'registerSW.js', 'workbox-window.prod.es5.mjs']);

function injectRuntimeConfig(html, hostHeader) {
  let cfg;
  if (USE_RELATIVE_API_URL) {
    // Same-origin path. The reverse proxy (nginx, Caddy, …) routes
    // /api/* to the API and /ws/* to the API's websocket endpoints.
    // No host or port leaks into the bundle, so the same build works
    // for every domain that fronts it.
    cfg = JSON.stringify({ apiBaseUrl: '/api' });
  } else {
    const hostname = (hostHeader || '').split(':')[0] || 'localhost';
    const apiBaseUrl = 'http://' + hostname + ':' + API_PORT + '/api';
    cfg = JSON.stringify({ apiBaseUrl, apiPort: API_PORT });
  }
  const tag = '<script>window.__OPENCLAW_CONFIG__=' + cfg + ';</script>';
  if (html.includes('</head>')) return html.replace('</head>', '  ' + tag + '\\n  </head>');
  return tag + html;
}

/**
 * Resolve a request URL to a file inside DIST without permitting
 * directory traversal or symlink escapes.
 *
 *  - URL-decode and parse so query strings and \`..\` segments collapse
 *    via WHATWG \`URL\`. Anything that decodes to a path outside DIST
 *    falls back to the SPA shell.
 *  - \`fs.realpathSync\` follows symlinks before the prefix check so a
 *    symlinked file inside DIST that points elsewhere can't escape.
 *  - Returns \`null\` when the request is unresolvable; the caller then
 *    falls back to index.html (SPA behavior).
 */
function resolveSafePath(reqUrl) {
  let pathname;
  try {
    pathname = new URL(reqUrl || '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') return path.join(DIST, 'index.html');
  // Reject NUL bytes outright (some Node APIs treat them inconsistently).
  if (decoded.includes('\\0')) return null;
  const candidate = path.join(DIST, decoded);
  // \`path.join(DIST, '../foo')\` resolves above DIST. Compare against
  // both the canonical and real (symlink-resolved) DIST roots.
  const sep = path.sep;
  if (!candidate.startsWith(DIST + sep) && candidate !== DIST) return null;
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return candidate; // file doesn't exist yet — caller will 404 / SPA-fallback
  }
  if (!real.startsWith(DIST_REAL + sep) && real !== DIST_REAL) return null;
  return real;
}

http.createServer((req, res) => {
  let filePath = resolveSafePath(req.url);
  if (filePath === null) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    if (mime === 'text/html') {
      const html = fs.readFileSync(filePath, 'utf-8');
      const out = injectRuntimeConfig(html, req.headers.host);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(out);
      return;
    }
    const data = fs.readFileSync(filePath);
    const headers = { 'Content-Type': mime };
    if (NO_CACHE_FILES.has(path.basename(filePath))) {
      headers['Cache-Control'] = 'no-cache';
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('client listening on port ' + PORT);
});
`.trimStart();

export function deploy() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const API_SRC = path.join(root, 'api');
  const CLIENT_SRC = path.join(root, 'client');

  const dist = path.join(os.homedir(), '.openclaw_client');
  const apiDist = path.join(dist, 'api');
  const clientDist = path.join(dist, 'client');
  const dataDir = path.join(dist, 'data');

  function run(cmd, args = [], cwd = root) {
    try {
      execFileSync(cmd, args, { cwd, stdio: 'pipe' });
    } catch (err) {
      const output = err.stdout?.toString() || '';
      const stderr = err.stderr?.toString() || '';
      if (output) process.stderr.write(output);
      if (stderr) process.stderr.write(stderr);
      throw err;
    }
  }

  const { apiPort, clientPort } = readPorts();

  function buildEnvWithHeapFloor() {
    const base = { ...process.env, ...portEnv() };
    const floorMb = Number(process.env.OPENCLAW_BUILD_MAX_OLD_SPACE_MB) || 4096;
    const existing = base.NODE_OPTIONS || '';
    if (/--max-old-space-size=/.test(existing)) return base;
    base.NODE_OPTIONS = `${existing} --max-old-space-size=${floorMb}`.trim();
    return base;
  }
  const buildEnv = buildEnvWithHeapFloor();

  process.stdout.write('📦 Installing dependencies...\n');
  run(NPM_BIN, ['ci', '--include=dev'], API_SRC);
  run(NPM_BIN, ['ci', '--include=dev'], CLIENT_SRC);

  process.stdout.write('🔨 Building...\n');
  try {
    execFileSync(NPM_BIN, ['run', 'build'], { cwd: API_SRC, stdio: 'pipe', env: buildEnv });
  } catch (err) {
    const output = err.stdout?.toString() || '';
    const stderr = err.stderr?.toString() || '';
    if (output) process.stderr.write(output);
    if (stderr) process.stderr.write(stderr);
    throw err;
  }
  // VITE_API_PORT is embedded into the bundle as a fallback; the
  // runtime resolves the actual API origin from the page's hostname so
  // the same build works on localhost, LAN, and Tailscale.
  try {
    execFileSync(NPM_BIN, ['run', 'build'], { cwd: CLIENT_SRC, stdio: 'pipe', env: buildEnv });
  } catch (err) {
    const output = err.stdout?.toString() || '';
    const stderr = err.stderr?.toString() || '';
    if (output) process.stderr.write(output);
    if (stderr) process.stderr.write(stderr);
    throw err;
  }

  mkdirSync(apiDist, { recursive: true });
  mkdirSync(clientDist, { recursive: true });

  cpSync(path.join(API_SRC, 'build'), path.join(apiDist, 'build'), {
    recursive: true,
    force: true,
  });
  const ptyBridgeSrc = path.join(API_SRC, 'pty-bridge.py');
  if (existsSync(ptyBridgeSrc)) {
    cpSync(ptyBridgeSrc, path.join(apiDist, 'build', 'pty-bridge.py'), { force: true });
  }
  cpSync(path.join(API_SRC, 'package.json'), path.join(apiDist, 'package.json'));
  cpSync(path.join(API_SRC, 'package-lock.json'), path.join(apiDist, 'package-lock.json'));

  cpSync(path.join(CLIENT_SRC, 'dist'), path.join(clientDist, 'dist'), {
    recursive: true,
    force: true,
  });

  mkdirSync(dataDir, { recursive: true });
  const canonicalDbPath = path.join(dataDir, 'openclaw.sqlite');

  const envDist = path.join(apiDist, '.env');

  // We seed only what the runtime can't figure out on its own.
  //   - DB_PATH and PORT must match where the install actually lives.
  //   - JWT_SECRET must persist across reinstalls or every login token
  //     gets invalidated, so we generate it once.
  //   - ALLOWED_DOMAIN / API_PUBLIC_URL are deliberately omitted: the
  //     API has a permissive CORS default and derives public URLs from
  //     the request host. Users who want strict CORS set
  //     `ALLOWED_DOMAIN=...` and `OPENCLAW_STRICT_CORS=1` themselves.
  const seedDefaults = {
    NODE_ENV: 'production',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    DB_PATH: canonicalDbPath,
    PORT: String(apiPort),
  };
  const overrides = {
    DB_PATH: canonicalDbPath,
    PORT: String(apiPort),
  };

  if (!existsSync(envDist)) {
    writeFileSync(
      envDist,
      Object.entries(seedDefaults)
        .map(([k, v]) => `${k}=${v}`)
        .concat('')
        .join('\n')
    );
  } else {
    const seen = new Set();
    const lines = readFileSync(envDist, 'utf-8').split('\n');
    const updated = lines.map((line) => {
      for (const [k, v] of Object.entries(overrides)) {
        if (line.startsWith(`${k}=`)) {
          seen.add(k);
          return `${k}=${v}`;
        }
      }
      return line;
    });
    for (const [k, v] of Object.entries(overrides)) {
      if (!seen.has(k)) updated.push(`${k}=${v}`);
    }
    writeFileSync(envDist, updated.join('\n'));
  }

  if (!existsSync(canonicalDbPath)) {
    const legacyDb = [
      path.join(apiDist, 'build', 'data', 'openclaw.sqlite'),
      path.join(apiDist, 'data', 'openclaw.sqlite'),
    ].find((p) => existsSync(p));
    if (legacyDb) cpSync(legacyDb, canonicalDbPath);
  }

  writeFileSync(path.join(clientDist, 'serve.mjs'), SERVE_MJS);

  const runnerSrc = path.join(root, 'scripts', 'service-runner.mjs');
  if (existsSync(runnerSrc)) {
    cpSync(runnerSrc, path.join(dist, 'service-runner.mjs'), { force: true });
  }

  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const updateDir = path.join(dist, 'update');

  if (!existsSync(path.join(updateDir, '.git'))) {
    process.stdout.write('📥 Setting up update source...\n');
    try {
      execFileSync(
        'git',
        ['clone', '--depth', '1', 'https://github.com/lotsoftick/openclaw_client.git', updateDir],
        { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
    } catch {
      process.stdout.write('  ⚠️  Could not clone update source (updates will use local repo)\n');
    }
  }

  const sourceRepo = existsSync(path.join(updateDir, 'package.json')) ? updateDir : root;
  writeFileSync(
    path.join(dist, 'meta.json'),
    JSON.stringify({
      version: rootPkg.version,
      sourceRepo,
    })
  );

  process.stdout.write('📦 Installing production dependencies...\n');
  run(NPM_BIN, ['ci', '--omit=dev'], apiDist);
}
