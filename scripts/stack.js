/**
 * Runs the production build of the whole app in Docker: `npm run stack:up`, then open
 * http://localhost:8080. `npm run stack:down` stops it (data volumes are kept).
 *
 * The API and worker read their settings from apps/api/.env at run time. The web image needs one value
 * at build time, the Clerk *publishable* key (public: it ships in the browser bundle), which is read
 * from apps/web/.env.local so there's nothing extra to configure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
};

const action = process.argv[2];
const compose = (args, env = process.env) =>
  spawnSync('docker', ['compose', '--profile', 'app', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  }).status ?? 1;

if (action === 'down') {
  process.exit(compose(['down']));
}
if (action !== 'up') fail('Usage: node scripts/stack.js up|down');

if (!existsSync('apps/api/.env')) {
  fail('apps/api/.env is missing. Copy apps/api/.env.example and fill in your Clerk keys first.');
}

/** Reads one KEY=value line from a dotenv file (values never printed). */
function readEnvValue(file, key) {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] === key) return match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

const publishableKey =
  process.env.VITE_CLERK_PUBLISHABLE_KEY ||
  readEnvValue('apps/web/.env.local', 'VITE_CLERK_PUBLISHABLE_KEY');
if (!publishableKey) {
  fail('VITE_CLERK_PUBLISHABLE_KEY not found in apps/web/.env.local (or the environment).');
}

const env = { ...process.env, VITE_CLERK_PUBLISHABLE_KEY: publishableKey };

// Build first, then start: with `up --build`, the worker (which reuses the API image) could race the
// API's container creation on a first run.
log('Building images (the first build takes a few minutes)…');
if (compose(['build', 'api', 'web'], env) !== 0) fail('Image build failed (output above).');

log('Starting MongoDB, Redis, API, worker and web…');
if (compose(['up', '-d', '--wait'], env) !== 0) {
  fail('Stack failed to start. Inspect with: docker compose --profile app logs api worker web');
}

log('\nVibe is running at http://localhost:8080');
log('Logs:  docker compose --profile app logs -f api worker web');
log('Stop:  npm run stack:down');
