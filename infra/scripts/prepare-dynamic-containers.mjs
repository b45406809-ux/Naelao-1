#!/usr/bin/env node
/** Prepare a reviewed image registry and Wrangler map together. Does not deploy or build images.
 * First build/review and push immutable images with Wrangler, then run this before a deployment.
 * Writes only the requested environment; production and staging never silently share rollout flags.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareDynamicConfig(source, registry, environment) {
  if (!['staging', 'production', 'default'].includes(environment)) throw new Error('invalid environment');
  if (!Array.isArray(registry) || registry.length > 99) throw new Error('registry must contain at most 99 entries (base uses one image slot)');
  const pins = new Set();
  for (const entry of registry) {
    if (!entry || !['TOOL_SANDBOX', 'DOCUMENT_SANDBOX', 'MEDIA_SANDBOX'].includes(entry.binding)
      || entry.networkPolicy !== 'none' || typeof entry.image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(entry.image) || pins.has(entry.image)
      || !Number.isFinite(entry.cpuCores) || entry.cpuCores <= 0 || entry.cpuCores > 4
      || !Number.isSafeInteger(entry.memoryMb) || entry.memoryMb <= 0 || entry.memoryMb > 12288) throw new Error('invalid or duplicate registry entry');
    pins.add(entry.image);
    if (entry.schedulingPolicy === 'durable_object') {
      if (entry.schedulingPolicy !== 'durable_object' || !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f0-9]{64}$/.test(entry.image))
        throw new Error('dynamic images must be digest-pinned in the Cloudflare registry with durable_object policy');
    } else if (entry.binding === 'TOOL_SANDBOX' || entry.schedulingPolicy !== 'default' || entry.cpuCores !== .5 || entry.memoryMb !== 4096) throw new Error('invalid fixed resource envelope');
  }
  const prefix = environment === 'default' ? '' : `env.${environment}.`;
  const marker = prefix || 'default';
  const begin = `# BEGIN GENERATED DYNAMIC IMAGES ${marker}`;
  const end = `# END GENERATED DYNAMIC IMAGES ${marker}`;
  const start = source.indexOf(begin), finish = source.indexOf(end);
  if (start < 0 || finish < start || source.indexOf(begin, start + 1) >= 0) throw new Error('missing or ambiguous dynamic application markers');
  const images = registry.filter(entry => entry.schedulingPolicy === 'durable_object').sort((a, b) => a.image.localeCompare(b.image));
  // Index plus digest prefix: deterministic names even if two repositories share image bytes.
  const lines = images.map((entry, index) => `[${prefix}containers.images.approved_${index}_${entry.image.slice(-12)}]\nimage = ${JSON.stringify(entry.image)}\n`).join('\n');
  let config = source.slice(0, start) + begin + '\n' + lines + end + source.slice(finish + end.length);
  const value = JSON.stringify(JSON.stringify(registry)); // TOML basic string containing JSON
  if (environment === 'default') {
    config = config.replace(/(\[vars\]\n)([\s\S]*?)(?=\n\[|$)/, (_, head, vars) => {
      vars = vars.replace(/^CONTAINER_IMAGE_REGISTRY = .*\n?/m, '');
      return head + `CONTAINER_IMAGE_REGISTRY = ${value}\n` + vars;
    });
  } else {
    const section = `[env.${environment}]`;
    const at = config.indexOf(section);
    if (at < 0) throw new Error('environment section missing');
    const tail = config.slice(at).replace(/vars = \{ ([^\n]*) \}/, (_, vars) => {
      vars = vars.replace(/CONTAINER_IMAGE_REGISTRY = "(?:\\.|[^"\\])*",?\s*/g, '');
      return `vars = { CONTAINER_IMAGE_REGISTRY = ${value}, ${vars} }`;
    });
    config = config.slice(0, at) + tail;
  }
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [registryPath, environment, configPath = 'workers/agents/wrangler.toml'] = process.argv.slice(2);
  if (!registryPath || !environment) throw new Error('Usage: node infra/scripts/prepare-dynamic-containers.mjs reviewed-registry.json staging|production|default [wrangler.toml]');
  const source = await readFile(configPath, 'utf8');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  await writeFile(configPath, prepareDynamicConfig(source, registry, environment));
  console.log(`Prepared ${environment} registry and image map. Review the diff, dry-run, then deploy. Rollout flags were preserved.`);
}
