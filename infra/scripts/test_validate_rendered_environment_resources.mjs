import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindingsFromResolvedConfig,
  compareInventories,
  expectedInventoryFromMap,
  validateResolvedInventory,
} from "./validate_rendered_environment_resources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceMap = JSON.parse(readFileSync(path.join(ROOT, "infra/environment/resource-map.json"), "utf8"));
const configs = sourceMap.source_files.map((row) => path.join(ROOT, row.path));

test("resolved Wrangler resource bindings normalize to the inventory contract", () => {
  const rows = bindingsFromResolvedConfig({
    d1_databases: [{ binding: "DB", database_id: "d1-stage" }],
    kv_namespaces: [{ binding: "CACHE", id: "kv-stage" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "files-stage" }],
    vectorize: [{ binding: "SEARCH", index_name: "search-stage" }],
    services: [{ binding: "API", service: "api-stage" }],
    queues: {
      producers: [{ binding: "EVENTS", queue: "events-stage" }],
      consumers: [{ queue: "events-stage", dead_letter_queue: "events-dlq-stage" }],
    },
    workflows: [{ binding: "SYNC", name: "sync-stage" }],
    durable_objects: { bindings: [{ name: "CACHE_DO", class_name: "CacheDO", script_name: "cache-stage" }] },
  });
  assert.deepEqual(rows, [
    { kind: "d1", binding: "DB", id_or_name: "d1-stage" },
    { kind: "kv", binding: "CACHE", id_or_name: "kv-stage" },
    { kind: "r2", binding: "FILES", id_or_name: "files-stage" },
    { kind: "vectorize", binding: "SEARCH", id_or_name: "search-stage" },
    { kind: "service", binding: "API", id_or_name: "api-stage" },
    { kind: "queue", binding: "EVENTS", id_or_name: "events-stage" },
    { kind: "queue", binding: "queue", id_or_name: "events-stage" },
    { kind: "queue", binding: "dead_letter_queue", id_or_name: "events-dlq-stage" },
    { kind: "workflow", binding: "SYNC", id_or_name: "sync-stage" },
    { kind: "durable_object", binding: "CACHE_DO", id_or_name: "CacheDO" },
    { kind: "durable_object_script", binding: "CACHE_DO", id_or_name: "cache-stage" },
  ]);
});

test("the current source map compares exactly with rendered config tuples", () => {
  const expected = expectedInventoryFromMap(sourceMap);
  const { missing, unexpected } = compareInventories(expected, expected);
  assert.deepEqual(missing, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(validateResolvedInventory(sourceMap, configs, () => ({ rows: expected, errors: [] })), []);
});

test("unmapped and missing rendered bindings fail the comparison", () => {
  const expected = expectedInventoryFromMap(sourceMap);
  const changed = [...expected.slice(1), { ...expected[0], id_or_name: "unlisted-target" }];
  const { missing, unexpected } = compareInventories(expected, changed);
  assert.equal(missing.length, 1);
  assert.equal(unexpected.length, 1);
  assert.notEqual(missing[0], unexpected[0]);
  assert.match(unexpected[0], /unlisted-target/);
});

test("stale source hashes stop rendered inventory validation", () => {
  const changed = structuredClone(sourceMap);
  changed.source_files[0].sha256 = "0".repeat(64);
  const errors = validateResolvedInventory(changed, configs, () => {
    throw new Error("render must not run for stale input");
  });
  assert.deepEqual(errors, ["resource map source hashes do not match the current Wrangler TOMLs"]);
});

test("Wrangler resolution failures are reported without exposing config values", () => {
  const errors = validateResolvedInventory(sourceMap, configs, () => ({
    rows: [],
    errors: ["Wrangler could not resolve workers/eval/wrangler.toml for staging"],
  }));
  assert.deepEqual(errors, ["Wrangler could not resolve workers/eval/wrangler.toml for staging"]);
});
