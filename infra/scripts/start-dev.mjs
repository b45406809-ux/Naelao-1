import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { cpSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { localTopology } from './dev-topology.mjs';
import { parseProtectedPreviewArgs, startProtectedPreviewTunnel } from './protected-preview.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const agentsRequire = createRequire(join(root, 'workers/agents/package.json'));
const topology = localTopology(root);
const forwardedArgs = process.argv.slice(2).filter(value => value !== '--');
const args = new Set(forwardedArgs);
const preview = parseProtectedPreviewArgs(forwardedArgs);
const CORE = ['router', 'auth', 'spaces', 'agents', 'knowledge'];
const EXTENDED = [...CORE, 'provisioner', 'notifications', 'credentials', 'billing', 'eval', 'ws-gateway'];
// Keep existing local accounts/products. Every worker must use this exact absolute directory.
const persist = resolve(root, process.env.PERSIST_DIR ?? 'workers/spaces/.wrangler/state');
const logDir = join(root, '.dev', 'logs');
if (args.has('--list')) {
  console.log(JSON.stringify({ workers: (args.has('--extended') ? EXTENDED : CORE).map(dir => topology.workers.find(worker => worker.dir === dir)), persist }, null, 2));
  process.exit(0);
}
mkdirSync(logDir, { recursive: true });
mkdirSync(persist, { recursive: true });
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('exit', () => { for (const child of children) child.kill(); });

async function assertFree(port) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the previous Naelao dev stack first.`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
function launch(name, entry, argv, cwd = root) {
  const log = openSync(join(logDir, `${name}.log`), 'w');
  const child = spawn(process.execPath, [entry, ...argv], { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, windowsHide: true, stdio: ['ignore', log, log] });
  closeSync(log);
  children.push(child);
  child.on('error', error => { console.error(`${name}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${name} stopped (${code}). See .dev/logs/${name}.log`); stop(1); } });
}

function stageAgentContainerDependencies() {
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const esbuildPackage = dirname(agentsRequire.resolve('esbuild/package.json'));
  // pnpm keeps esbuild's optional native package in its virtual-store hoist. It is
  // present when esbuild itself can run, but is not necessarily resolvable from the
  // worker package's dependency graph because it is an optional peer of esbuild.
  const platformPackageDir = resolve(root, 'node_modules/.pnpm/node_modules', platformPackage);
  const stagedModules = join(root, 'workers/agents/container/.vendor/node_modules');
  rmSync(stagedModules, { recursive: true, force: true });
  mkdirSync(join(stagedModules, '@esbuild'), { recursive: true });
  cpSync(esbuildPackage, join(stagedModules, 'esbuild'), { recursive: true, dereference: true });
  cpSync(platformPackageDir, join(stagedModules, platformPackage), { recursive: true, dereference: true });
}

try {
  const workerDirs = args.has('--extended') ? EXTENDED : CORE;
  const selectedWorkers = workerDirs.map(dir => topology.workers.find(worker => worker.dir === dir)).filter(Boolean);
  if (selectedWorkers.some(worker => worker.dir === 'agents')) stageAgentContainerDependencies();
  await Promise.all(selectedWorkers.map(worker => assertFree(worker.port)));
  if (!args.has('--workers-only')) { await assertFree(3000); await assertFree(3100); }
  if (topology.unavailable.length) console.warn(`No local implementation for: ${topology.unavailable.join(', ')}. Features depending on these services require a configured provider.`);
  const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'wrangler-dist', 'cli.js');
  // These are optional local secrets. Forward them only when the caller supplied them; keeping
  // them out of wrangler.toml means they never become repository configuration or source control
  // content. NAELAO_AIG_TOKEN authenticates the named AI Gateway, while CF_API_TOKEN is needed
  // by Cloudflare's newer AI REST endpoint for @cf/* models.
  const optionalAiVars = ['NAELAO_AIG_TOKEN', 'CF_API_TOKEN']
    .flatMap(name => process.env[name] ? ['--var', `${name}:${process.env[name]}`] : []);
  for (const worker of selectedWorkers) {
    // Each Wrangler process starts its own workerd and Inspector. Give Inspector a stable,
    // worker-specific port; Wrangler's default is shared and parallel workers race to bind it.
    launch(worker.dir, wrangler, ['dev', '--local', '--config', `workers/${worker.dir}/wrangler.toml`, '--port', String(worker.port), '--inspector-port', String(worker.port + 10000), '--persist-to', persist,
      '--var', `JWT_SECRET:${process.env.JWT_SECRET ?? 'local-dev-jwt-secret-change-me'}`,
      '--var', `PLATFORM_SECRET:${process.env.PLATFORM_SECRET ?? 'local-dev-platform-secret-change-me'}`,
      // The credentials worker encrypts every stored secret at rest. Keep local dev bootable
      // without a .dev.vars file, while allowing a caller-provided key to take precedence.
      '--var', `CREDENTIAL_ENCRYPTION_KEY:${process.env.CREDENTIAL_ENCRYPTION_KEY ?? `v1:${'00'.repeat(32)}`}`,
      ...optionalAiVars]);
    console.log(`${worker.name}: http://localhost:${worker.port}`);
  }
  if (!args.has('--workers-only')) {
    for (const [app, port] of [['dashboard', 3000], ['shell', 3100]]) {
      const appRequire = createRequire(join(root, 'apps', app, 'package.json'));
      launch(app, appRequire.resolve('next/dist/bin/next'), ['dev', '-p', String(port)], join(root, 'apps', app));
      console.log(`${app}: http://localhost:${port}`);
    }
  }
  if (preview.share) {
    const tunnel = startProtectedPreviewTunnel({
      allowedEmails: preview.allowedEmails,
      port: 3100,
      onUrl: url => {
        console.log(`Protected preview: ${url}`);
        console.log('Cloudflare will ask each allowed visitor for an email one-time PIN in a browser.');
        console.log('Quick Tunnels do not support SSE; live chat uses its polling fallback, and the hostname changes when the tunnel restarts.');
      },
      onError: error => { console.error(`Could not start protected preview (${error.message}). Install cloudflared and confirm it is on PATH.`); stop(1); },
      onExit: (code, signal) => { if (!stopping) { console.error(`Protected preview tunnel stopped (${signal ?? code}).`); stop(code || 1); } },
    });
    children.push(tunnel);
  }
  console.log(`Shared data: ${persist}\nLogs: ${logDir}\nWaiting for workers to compile; inspect their logs for readiness.`);
} catch (error) { console.error(error.message); stop(1); }
