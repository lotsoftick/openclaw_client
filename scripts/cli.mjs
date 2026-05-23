#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy } from './build-dist.mjs';
import {
  bootoutLaunchAgent,
  bootstrapLaunchAgent,
  getLaunchdDomain,
  getPlistPath,
  kickstartLaunchAgent,
  launchAgentIsLoaded,
  LAUNCH_AGENT_LABEL,
  removePlistFile,
  writeLaunchAgentPlist,
} from './launchd.mjs';
import { portEnv, readPorts } from './ports.mjs';
import { IS_DARWIN, IS_WINDOWS, NPM_BIN, killPort, portListening } from './proc.mjs';
import {
  getStartupCmdPath,
  removeWindowsAutostart,
  windowsAutostartInstalled,
  writeWindowsAutostart,
} from './windows-autostart.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(os.homedir(), '.openclaw_client');
const LEGACY_DIST = path.join(os.homedir(), '.openclaw_client');
const API_DIST = path.join(DIST, 'api');
const CLIENT_DIST = path.join(DIST, 'client');
const DATA_DIR = path.join(DIST, 'data');
const LOG_FILE = path.join(DIST, 'openclaw.log');

function currentPorts() {
  const { apiPort, clientPort } = readPorts();
  return { apiPort, clientPort, all: [apiPort, clientPort] };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function killPorts() {
  const { all } = currentPorts();
  for (const port of all) killPort(port);
}

const SYSTEMD_SYSTEM_UNIT = '/etc/systemd/system/openclaw_client.service';
const SYSTEMD_USER_UNIT = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  'openclaw_client.service'
);

function supervisorAction(action) {
  if (IS_DARWIN) {
    if (!existsSync(getPlistPath())) return 'unsupervised';
    try {
      if (action === 'stop') {
        bootoutLaunchAgent();
      } else if (action === 'start') {
        bootstrapLaunchAgent();
      } else {
        /* restart */
        if (launchAgentIsLoaded()) kickstartLaunchAgent();
        else bootstrapLaunchAgent();
      }
      return 'ok';
    } catch {
      return 'failed';
    }
  }

  if (process.platform === 'linux') {
    /* Prefer system unit (the openclaw-setup.sh path) over the per-user
     * unit, since the system unit is what the install script writes.
     * Either is sufficient to claim "supervised". */
    let prefix = null;
    if (existsSync(SYSTEMD_SYSTEM_UNIT)) prefix = [];
    else if (existsSync(SYSTEMD_USER_UNIT)) prefix = ['--user'];
    if (prefix === null) return 'unsupervised';
    try {
      execFileSync('systemctl', [...prefix, action, 'openclaw_client.service'], {
        stdio: 'inherit',
      });
      return 'ok';
    } catch {
      return 'failed';
    }
  }

  /* Windows installs go through the Startup folder — that's a one-shot
   * launcher, not a process supervisor, so we don't try to drive it.
   * Fall through to detach, which is what was happening before. */
  return 'unsupervised';
}

/** Back-compat wrapper used by `fullStart`. */
export function restartViaSupervisor() {
  const r = supervisorAction('restart');
  return r === 'ok' ? 'restarted' : r;
}

function linkGlobal() {
  execFileSync(NPM_BIN, ['link'], { cwd: ROOT, stdio: 'pipe' });
}

function unlinkGlobal() {
  try {
    execFileSync(NPM_BIN, ['unlink', '-g', 'openclaw-client'], { stdio: 'pipe' });
  } catch {
    /* ok */
  }
}

function assertBuilt() {
  const required = [
    path.join(API_DIST, 'build', 'src', 'app.js'),
    path.join(CLIENT_DIST, 'serve.mjs'),
    path.join(CLIENT_DIST, 'dist'),
    path.join(DIST, 'service-runner.mjs'),
  ];
  const missing = required.filter((f) => !existsSync(f));
  if (missing.length) {
    console.log('❌ No build found. Run `npm start` from the openclaw_client repo first.');
    process.exit(1);
  }
}

function installLaunchd() {
  const runner = path.join(DIST, 'service-runner.mjs');
  writeLaunchAgentPlist({
    nodePath: process.execPath,
    runnerPath: runner,
    workDir: DIST,
    stdoutPath: LOG_FILE,
    stderrPath: path.join(DIST, 'openclaw.err.log'),
  });
  bootoutLaunchAgent();
  bootstrapLaunchAgent();
}

function installWindowsAutostart() {
  const runner = path.join(DIST, 'service-runner.mjs');
  writeWindowsAutostart({
    nodePath: process.execPath,
    runnerPath: runner,
    workDir: DIST,
    logPath: LOG_FILE,
  });
}

function detachStart() {
  const fd = openSync(LOG_FILE, 'w');
  const env = { ...process.env, NODE_ENV: 'production', ...portEnv() };
  const common = { stdio: ['ignore', fd, fd], env, detached: true };
  // On Windows, `detached: true` with `windowsHide: true` keeps the servers
  // alive after the parent exits without flashing a console window.
  if (IS_WINDOWS) common.windowsHide = true;
  const api = spawn(process.execPath, ['build/src/app.js'], { cwd: API_DIST, ...common });
  const client = spawn(process.execPath, ['serve.mjs'], { cwd: CLIENT_DIST, ...common });
  api.unref();
  client.unref();
  closeSync(fd);
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ── commands ─────────────────────────────────────────────────────────────────

/** npm start only — full build + deploy + autostart (os-specific) + global link */
export function fullStart() {
  deploy();

  const supervised = supervisorAction('restart');
  if (supervised === 'ok') {
    linkGlobal();
    const { clientPort } = currentPorts();
    console.log('');
    console.log('  🚀 OpenClaw Client is running (restarted via supervisor)');
    console.log(`  🌐 http://localhost:${clientPort}`);
    console.log('  📁 ~/.openclaw_client');
    console.log('  ⚙️  Ports: ~/.openclaw_client/.env');
    console.log('');
    return;
  }
  if (supervised === 'failed') reportSupervisorFailure('restart');

  /* Unsupervised install — legacy detach path. */
  killPorts();
  if (IS_DARWIN) {
    installLaunchd();
  } else if (IS_WINDOWS) {
    installWindowsAutostart();
    detachStart();
  } else {
    detachStart();
  }

  linkGlobal();

  const { clientPort } = currentPorts();
  console.log('');
  console.log('  🚀 OpenClaw Client is running');
  console.log(`  🌐 http://localhost:${clientPort}`);
  if (IS_DARWIN) console.log('  🔄 Starts automatically on login (LaunchAgent)');
  else if (IS_WINDOWS) console.log('  🔄 Starts automatically on login (Startup folder)');
  console.log('  📁 ~/.openclaw_client');
  console.log('  ⚙️  Ports: ~/.openclaw_client/.env');
  console.log('  🛠️  openclaw_client status | stop | restart | uninstall');
  console.log('');
}

function reportSupervisorFailure(action) {
  console.error(
    `\n❌ A process supervisor (systemd unit / LaunchAgent) is installed but\n` +
      `   '${action}' failed. NOT falling back to direct port management — that\n` +
      `   would race the supervisor and produce an EADDRINUSE crash loop.\n\n` +
      `   Inspect:\n` +
      `     systemctl status openclaw_client    # Linux\n` +
      `     launchctl print gui/$UID/com.openclaw.client    # macOS\n` +
      `     journalctl -u openclaw_client -n 50    # Linux\n`
  );
  process.exit(1);
}

/** openclaw_client start — run from existing build only */
function cmdStart() {
  assertBuilt();

  /* If supervised, asking the supervisor to start is the only safe move:
   * `killPorts()` + `detachStart()` would create a second pair of api/client
   * children racing systemd's `Restart=on-failure` respawn for ports
   * 18800/18802. */
  const sup = supervisorAction('start');
  if (sup === 'ok') {
    const { clientPort } = currentPorts();
    console.log('');
    console.log('  🚀 OpenClaw Client started (via supervisor)');
    console.log(`  🌐 http://localhost:${clientPort}`);
    console.log('');
    return;
  }
  if (sup === 'failed') reportSupervisorFailure('start');

  /* Unsupervised — legacy path. */
  killPorts();
  if (IS_DARWIN) {
    installLaunchd();
  } else if (IS_WINDOWS) {
    installWindowsAutostart();
    detachStart();
  } else {
    detachStart();
  }

  const { clientPort } = currentPorts();
  console.log('');
  console.log('  🚀 OpenClaw Client started');
  console.log(`  🌐 http://localhost:${clientPort}`);
  console.log('');
}

function cmdStop() {
  /* Same reasoning as `cmdStart`: a bare `killPorts()` against systemd's
   * supervised children only triggers `Restart=on-failure`, leaving the
   * service flapping. Tell the supervisor to stop. */
  const sup = supervisorAction('stop');
  if (sup === 'ok') {
    console.log('  🛑 OpenClaw Client stopped (via supervisor)');
    return;
  }
  if (sup === 'failed') reportSupervisorFailure('stop');

  /* Unsupervised — legacy path. The macOS branch here is dead code on
   * supervised installs (the plist exists → supervisorAction returns 'ok'),
   * but kept as a defensive cleanup if someone removed the plist by hand. */
  if (IS_DARWIN) bootoutLaunchAgent();
  killPorts();
  console.log('  🛑 OpenClaw Client stopped');
}

function cmdRestart() {
  const sup = supervisorAction('restart');
  if (sup === 'ok') {
    const { clientPort } = currentPorts();
    console.log('  🔄 OpenClaw Client restarted (via supervisor)');
    console.log(`  🌐 http://localhost:${clientPort}`);
    return;
  }
  if (sup === 'failed') reportSupervisorFailure('restart');

  /* Unsupervised — sequence stop+start so the legacy detach path runs. */
  cmdStop();
  cmdStart();
}

function cmdStatus() {
  console.log('');
  console.log('  📦 OpenClaw Client');
  console.log(`  📁 ${DIST}`);

  if (IS_DARWIN) {
    try {
      const out = execFileSync(
        'launchctl',
        ['print', `${getLaunchdDomain()}/${LAUNCH_AGENT_LABEL}`],
        { encoding: 'utf-8' }
      );
      const state = out.match(/^\s*state = (\S+)/m)?.[1] ?? 'unknown';
      const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
      if (state === 'running') {
        console.log(`  ✅ LaunchAgent: running${pid ? ` (pid ${pid})` : ''}`);
      } else {
        console.log(`  ⚠️  LaunchAgent: ${state}`);
      }
    } catch {
      console.log('  ❌ LaunchAgent: not loaded');
    }
  } else if (IS_WINDOWS) {
    if (windowsAutostartInstalled()) {
      console.log(`  ✅ Autostart: installed (${getStartupCmdPath()})`);
    } else {
      console.log('  ❌ Autostart: not installed');
    }
  }

  const { apiPort, clientPort } = currentPorts();
  const api = portListening(apiPort);
  const ui = portListening(clientPort);
  console.log(`  ${api ? '✅' : '❌'} API:    port ${apiPort} ${api ? '(listening)' : '(down)'}`);
  console.log(`  ${ui ? '✅' : '❌'} Client: port ${clientPort} ${ui ? '(listening)' : '(down)'}`);
  console.log(`  📄 Logs: ~/.openclaw_client/openclaw.log`);
  console.log('');
}

async function cmdUninstall(args) {
  const purge = args.includes('--purge');

  if (purge) {
    const dbPath = path.join(DATA_DIR, 'openclaw.sqlite');
    const dbExists = existsSync(dbPath);
    if (dbExists) {
      console.log('');
      console.log('  ⚠️  --purge will delete your OpenClaw database:');
      console.log(`     ${dbPath}`);
      console.log('');
      const ok = await confirm('  Are you sure? (y/N) ');
      if (!ok) {
        console.log('  Cancelled.');
        return;
      }
    }
  }

  if (IS_DARWIN) {
    bootoutLaunchAgent();
    removePlistFile();
  } else if (IS_WINDOWS) {
    removeWindowsAutostart();
  }
  killPorts();
  unlinkGlobal();

  if (existsSync(API_DIST)) rmSync(API_DIST, { recursive: true, force: true });
  if (existsSync(CLIENT_DIST)) rmSync(CLIENT_DIST, { recursive: true, force: true });
  const runner = path.join(DIST, 'service-runner.mjs');
  if (existsSync(runner)) rmSync(runner, { force: true });

  if (purge) {
    if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
    console.log('  🗑️  Uninstalled (all data removed)');
  } else {
    console.log('  🗑️  Uninstalled (database kept in ~/.openclaw_client/data)');
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  OpenClaw Client

  npm start                    Build, deploy, register LaunchAgent, link global CLI
  openclaw_client <command>    Control running service (from any directory)

  Commands:
    start       Start servers from ~/.openclaw_client (no build)
    stop        Stop servers
    restart     Stop + start
    status      Show service status
    uninstall   Remove LaunchAgent, global CLI, api & client artifacts
    uninstall --purge   Also delete database (with confirmation)
`);
}

function isCliMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(here);
  } catch {
    return path.resolve(entry) === path.resolve(here);
  }
}

if (isCliMain()) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }

  try {
    switch (cmd) {
      case 'start':
        cmdStart();
        break;
      case 'stop':
        cmdStop();
        break;
      case 'restart':
        cmdRestart();
        break;
      case 'status':
        cmdStatus();
        break;
      case 'uninstall':
        await cmdUninstall(argv.slice(1));
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        printUsage();
        process.exit(1);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
