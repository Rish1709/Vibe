/**
 * One command for local development: `npm run dev`.
 *
 * 1. Starts MongoDB and Redis in Docker and waits until they're healthy.
 * 2. Runs the API, the worker and the web app side by side, each line prefixed with its name.
 * 3. Ctrl+C (or any of them crashing) stops all three.
 *
 * No dependencies: plain child processes, so it works the same on Windows, macOS and Linux.
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const COLORS = { api: 36, worker: 35, web: 32 };
const SERVICES = [
  { name: 'api', script: 'dev:api' },
  { name: 'worker', script: 'dev:worker' },
  { name: 'web', script: 'dev:web' },
];

const log = (message) => process.stdout.write(`${message}\n`);
const label = (name) => `\x1b[${COLORS[name] ?? 37}m${name.padEnd(6)}\x1b[0m│ `;

log('Starting MongoDB and Redis (Docker)…');
const infra = spawnSync('docker', ['compose', 'up', '-d', '--wait', 'mongo', 'redis'], {
  stdio: 'inherit',
  shell: isWindows,
});
if (infra.status !== 0) {
  log('\nCould not start the databases. Is Docker Desktop running?');
  if (isWindows) log("If Docker Desktop won't start, try: scripts\\windows\\start-docker.ps1");
  process.exit(1);
}

const children = [];
let stopping = false;

/** Kills a process and everything it started (npm → tsx → node), so no orphan holds a port. */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  log('\nStopping api, worker and web… (databases keep running: `npm run infra:down` stops them)');
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 500);
}

/** Prefixes each complete line of a stream with the service label. */
function pipeWithLabel(stream, name) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${label(name)}${line}\n`);
  });
  stream.on('end', () => {
    if (pending) process.stdout.write(`${label(name)}${pending}\n`);
  });
}

for (const { name, script } of SERVICES) {
  const child = spawn('npm', ['run', script], {
    shell: isWindows,
    // Its own process group on macOS/Linux, so the whole tree can be stopped together.
    detached: !isWindows,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);
  pipeWithLabel(child.stdout, name);
  pipeWithLabel(child.stderr, name);
  child.on('exit', (code) => {
    if (stopping) return;
    log(`\n${label(name)}exited with code ${code ?? 'unknown'}; stopping the others.`);
    stopAll(code ?? 1);
  });
}

log('\nAPI     http://localhost:4000  (health: /health/ready)');
log('Web     http://localhost:5173  ← open this');
log('Press Ctrl+C to stop.\n');

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
