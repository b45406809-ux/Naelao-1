import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Follow actual local service bindings instead of maintaining an incomplete worker list.
export function localTopology(root) {
  const configs = new Map();
  for (const dir of readdirSync(join(root, 'workers'))) {
    let source;
    try { source = readFileSync(join(root, 'workers', dir, 'wrangler.toml'), 'utf8').split(/^\[env\./m)[0]; }
    catch { continue; }
    const name = source.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name) configs.set(name, { dir, name, dependencies: [...source.matchAll(/^(?:service|script_name)\s*=\s*"([^"]+)"/gm)].map(m => m[1]) });
  }
  const selected = new Map();
  const unavailable = new Set();
  function visit(name) {
    if (selected.has(name)) return;
    const config = configs.get(name);
    if (!config) { unavailable.add(name); return; }
    selected.set(name, config);
    config.dependencies.forEach(visit);
  }
  ['router', 'provisioner', 'workflows', 'triggers', 'channels'].forEach(dir => visit(`naelao-${dir}`));
  const ports = { router: 8080, auth: 8787, spaces: 8788, agents: 8789, provisioner: 8790, knowledge: 8791, 'ws-gateway': 8792, notifications: 8793, credentials: 8794, billing: 8795, eval: 8796 };
  let nextPort = 8797;
  return { workers: [...selected.values()].map(config => ({ ...config, port: ports[config.dir] ?? nextPort++ })), unavailable: [...unavailable] };
}
