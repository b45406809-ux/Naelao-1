#!/usr/bin/env node

/**
 * Compare Wrangler's resolved staging/production bindings with the receipt inventory.
 * This is local configuration validation only; it never contacts Cloudflare.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKERS = path.join(ROOT, "workers");
const MAP_PATH = path.join(ROOT, "infra/environment/resource-map.json");
const ENVIRONMENTS = ["staging", "production"];

function workerConfigs(directory = WORKERS) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, "wrangler.toml"))
    .filter((configPath) => {
      try {
        readFileSync(configPath);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function sourceMapFreshnessErrors(sourceMap, configs) {
  const listed = Array.isArray(sourceMap?.source_files) ? sourceMap.source_files : [];
  const current = configs.map((configPath) => ({
    path: path.relative(ROOT, configPath).split(path.sep).join("/"),
    sha256: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
  }));
  if (JSON.stringify(listed) !== JSON.stringify(current)) {
    return ["resource map source hashes do not match the current Wrangler TOMLs"];
  }
  return [];
}

function addResource(rows, kind, binding, idOrName) {
  if (typeof binding === "string" && binding.length > 0 && typeof idOrName === "string" && idOrName.length > 0) {
    rows.push({ kind, binding, id_or_name: idOrName });
  }
}

export function bindingsFromResolvedConfig(config) {
  const rows = [];
  for (const row of config.d1_databases ?? []) addResource(rows, "d1", row.binding, row.database_id);
  for (const row of config.kv_namespaces ?? []) addResource(rows, "kv", row.binding, row.id);
  for (const row of config.r2_buckets ?? []) addResource(rows, "r2", row.binding, row.bucket_name);
  for (const row of config.vectorize ?? []) addResource(rows, "vectorize", row.binding, row.index_name);
  for (const row of config.services ?? []) addResource(rows, "service", row.binding, row.service);
  for (const row of config.queues?.producers ?? []) addResource(rows, "queue", row.binding, row.queue);
  for (const row of config.queues?.consumers ?? []) {
    // Consumers have no binding name in Wrangler config; preserve the inventory's
    // stable identity for the queue target and its separately configured DLQ.
    addResource(rows, "queue", row.binding ?? "queue", row.queue);
    addResource(rows, "queue", row.dead_letter_binding ?? "dead_letter_queue", row.dead_letter_queue);
  }
  for (const row of config.workflows ?? []) addResource(rows, "workflow", row.binding ?? row.name, row.name);
  for (const row of config.durable_objects?.bindings ?? []) {
    const binding = row.name ?? row.binding ?? "durable_object";
    addResource(rows, "durable_object", binding, row.class_name);
    addResource(rows, "durable_object_script", binding, row.script_name);
  }
  return rows;
}

function inventoryKey(worker, environment, row) {
  return JSON.stringify([worker, environment, row.kind, row.binding, row.id_or_name]);
}

export function expectedInventoryFromMap(sourceMap) {
  const rows = [];
  for (const binding of sourceMap?.bindings ?? []) {
    for (const environment of ENVIRONMENTS) {
      for (const resource of binding.environments?.[environment] ?? []) {
        for (const worker of resource.workers ?? []) {
          rows.push({
            worker,
            environment,
            kind: binding.kind,
            binding: binding.binding,
            id_or_name: resource.id_or_name,
          });
        }
      }
    }
  }
  return rows;
}

export function compareInventories(expectedRows, renderedRows) {
  const expected = new Set(expectedRows.map((row) => inventoryKey(row.worker, row.environment, row)));
  const rendered = new Set(renderedRows.map((row) => inventoryKey(row.worker, row.environment, row)));
  const missing = [...expected].filter((key) => !rendered.has(key)).sort();
  const unexpected = [...rendered].filter((key) => !expected.has(key)).sort();
  return { missing, unexpected };
}

function renderCurrentInventory(sourceMap, configs) {
  const rows = [];
  const errors = [];
  for (const configPath of configs) {
    const worker = path.relative(ROOT, configPath).split(path.sep).join("/");
    for (const environment of ENVIRONMENTS) {
      try {
        const resolved = unstable_readConfig({ config: configPath, env: environment }, { hideWarnings: true });
        for (const row of bindingsFromResolvedConfig(resolved)) rows.push({ worker, environment, ...row });
      } catch {
        // Wrangler error text may include config values. Report only the source and
        // environment so variables or secret material cannot leak into CI logs.
        errors.push(`Wrangler could not resolve ${worker} for ${environment}`);
      }
    }
  }
  return { rows, errors };
}

export function validateResolvedInventory(sourceMap, configs, render = renderCurrentInventory) {
  if (sourceMap?.status !== "source_inventory_only") {
    return ["resource map is missing or has an unsupported status"];
  }
  const errors = sourceMapFreshnessErrors(sourceMap, configs);
  if (errors.length) return errors;
  const { rows, errors: renderErrors } = render(sourceMap, configs);
  errors.push(...renderErrors);
  if (renderErrors.length) return errors;
  const { missing, unexpected } = compareInventories(expectedInventoryFromMap(sourceMap), rows);
  for (const row of missing) errors.push(`rendered binding is absent from Wrangler config: ${row}`);
  for (const row of unexpected) errors.push(`rendered binding is missing from the receipt inventory: ${row}`);
  return errors;
}

function main() {
  let sourceMap;
  try {
    sourceMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  } catch {
    console.error("Rendered environment binding check failed: resource map is unreadable or invalid");
    return 1;
  }
  const errors = validateResolvedInventory(sourceMap, workerConfigs());
  if (errors.length) {
    console.error("Rendered environment binding check failed:");
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }
  console.log("Rendered environment binding check passed: Wrangler config matches the source receipt inventory.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
