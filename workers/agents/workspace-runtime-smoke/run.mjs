import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const base = process.env.WORKSPACE_SMOKE_URL ?? "http://127.0.0.1:8791";
const runId = process.env.WORKSPACE_SMOKE_RUN_ID ?? "local";
const token = process.env.WORKSPACE_SMOKE_TOKEN ?? "local-workspace-runtime-smoke-token-0123456789";
if (process.env.WORKSPACE_SMOKE_URL && !process.env.WORKSPACE_SMOKE_TOKEN) throw new Error("WORKSPACE_SMOKE_TOKEN is required for a remote smoke target");
const scopeFor = (instance) => {
  const id = `workspace-smoke-${runId}-${instance}`;
  return { tenantId: id, spaceId: id, projectId: id, jurisdiction: "global" };
};
const request = async (path, body, instance = "runtime") => {
  const headers = smokeHeaders(instance);
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), headers,
  });
  const parsed = await response.json();
  return { response, parsed };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scope = scopeFor("runtime");

const unauthenticated = await fetch(`${base}/__smoke/r2`);
assert.equal(unauthenticated.status, 401, "smoke endpoints must reject unauthenticated callers");

const initialized = await request("/v1/initialize", { scope, branch: "main", entries: [] });
assert.equal(initialized.response.status, 200, JSON.stringify(initialized.parsed));

let maintenance;
for (let attempt = 0; attempt < 30; attempt++) {
  const result = await request("/v1/gc/status");
  maintenance = result.parsed;
  if (maintenance.status === "complete" || maintenance.status === "failed") break;
  await wait(250);
}
assert.equal(maintenance.status, "complete", JSON.stringify(maintenance));

const first = await request("/v1/open", { scope, branch: "main", actorId: "runtime-smoke", runtimeId: "runtime-smoke", allocationGeneration: 1 });
assert.equal(first.response.status, 200, JSON.stringify(first.parsed));
const second = await request("/v1/open", { scope, branch: "main", actorId: "runtime-smoke-2", runtimeId: "runtime-smoke-2", allocationGeneration: 1 });
assert.equal(second.response.status, 200, JSON.stringify(second.parsed));
const checkpoint = (sessionId, idempotencyKey, path) => request("/v1/checkpoint", {
  sessionId, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey,
  changes: [{ path, expectedHash: null, contentBase64: btoa(path) }],
});
const race = await Promise.all([
  checkpoint(first.parsed.session.id, "runtime-race-a", "race-a.txt"),
  checkpoint(second.parsed.session.id, "runtime-race-b", "race-b.txt"),
]);
assert.deepEqual(race.map((result) => result.response.status).sort(), [200, 409]);

const read = await request("/v1/read?branch=main");
assert.equal(read.response.status, 200, JSON.stringify(read.parsed));
assert.equal(read.parsed.head.revision, 2);
assert.equal(read.parsed.entries.length, 1);
const entry = read.parsed.entries[0];
const stored = await envlessR2Object(`${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/${entry.sha256}`);
assert.equal(stored, true, "published manifest content must exist in the local R2 binding");

const contentPrefix = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/`;
const seeded = await fetch(`${base}/__smoke/seed-content`, { method: "POST", headers: { ...smokeHeaders(), "content-type": "application/json" }, body: JSON.stringify({ count: 205 }) });
assert.deepEqual(await seeded.json(), { seeded: 205 });
const firstPage = await r2Page(contentPrefix, 100);
assert.equal(firstPage.truncated, true);
assert.equal(typeof firstPage.cursor, "string", "local R2 must return a continuation cursor");
const continuationPage = await r2Page(contentPrefix, 100, firstPage.cursor);
assert.equal(continuationPage.keys.length, 100, "the opaque cursor must continue at the next R2 page");
const gc = await request("/v1/gc/content", {});
assert.equal(gc.response.status, 200, JSON.stringify(gc.parsed));
let contentKeys = [];
for (let attempt = 0; attempt < 60; attempt++) {
  contentKeys = await listAllR2(contentPrefix);
  if (contentKeys.length === 1) break;
  await wait(250);
}
assert.equal(contentKeys.length, 1, `GC should retain only the committed file, retained ${contentKeys.length}`);

const erased = await request("/v1/erase", { scope, confirm: true });
assert.equal(erased.response.status, 200, JSON.stringify(erased.parsed));
const remaining = await fetch(`${base}/__smoke/r2?prefix=workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/`, { headers: smokeHeaders() });
const keys = await remaining.json();
assert.deepEqual(keys.keys, []);
console.log("Workspace runtime smoke passed: SQLite DO transactions, alarm, concurrent CAS, R2 read, paging, GC, and erasure.");

if (process.env.WORKSPACE_SMOKE_PHASE4 === "true") await runMigrationSmoke();
if (process.env.WORKSPACE_SMOKE_LARGE_FILE === "true") await runLargeFileSmoke();

async function envlessR2Object(key) {
  const keys = await listAllR2(`workspace-v1/${key}`);
  return keys.includes(`workspace-v1/${key}`);
}

async function r2Page(prefix, limit, cursor, instance = "runtime") {
  const params = new URLSearchParams({ prefix, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${base}/__smoke/r2?${params}`, { headers: smokeHeaders(instance) });
  assert.equal(response.status, 200);
  return response.json();
}

async function listAllR2(prefix, instance = "runtime") {
  const keys = [];
  let cursor;
  do {
    const page = await r2Page(prefix, 100, cursor, instance);
    keys.push(...page.keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

function smokeHeaders(instance = "runtime") {
  return { authorization: `Bearer ${token}`, "x-workspace-smoke-instance": instance };
}

async function runMigrationSmoke() {
  const instance = "migration";
  const scope = scopeFor(instance);
  const branch = "workers/worker-a";
  const migrationId = `smoke-migration-${runId}`;
  const legacyFile = (path, content, contentType, extra = {}) => ({
    path, contentBase64: Buffer.from(content).toString("base64"), contentType, ...extra,
  });
  const seed = await request("/__smoke/seed-legacy", { entries: [
    legacyFile("README.md", "legacy main", "text/markdown"),
    legacyFile("docs/base.md", "base document", "text/markdown"),
    { path: "docs/deleted.md", deleted: true },
    legacyFile("overlay.txt", "branch overlay", "text/plain; charset=utf-8", { branch }),
    { branch, path: "docs/base.md", deleted: true },
    legacyFile("run.sh", "#!/bin/sh\necho smoke\n", "text/x-shellscript", { branch, executable: true }),
  ] }, instance);
  assert.equal(seed.response.status, 200, JSON.stringify(seed.parsed));

  const imported = await request("/v1/migration/import", { scope, migrationId, branchNames: [branch] }, instance);
  assert.ok([200, 201].includes(imported.response.status), JSON.stringify(imported.parsed));
  assert.equal(imported.parsed.migration.status, "verified", JSON.stringify(imported.parsed));
  assert.ok(imported.parsed.rollbackAlias, "migration must retain its rollback alias");

  const cutover = await request("/v1/migration/cutover", { scope, migrationId, rollbackWindowMs: 60 * 60_000 }, instance);
  assert.equal(cutover.response.status, 200, JSON.stringify(cutover.parsed));
  assert.equal(cutover.parsed.readPolicy.mode, "coordinator");
  assert.equal(cutover.parsed.readPolicy.generation, 1);
  assert.deepEqual(
    [cutover.parsed.receipt.mismatchCount, cutover.parsed.receipt.readErrorCount, cutover.parsed.receipt.omittedPathCount, cutover.parsed.receipt.truncatedPages],
    [0, 0, 0, 0],
  );
  assert.deepEqual(Object.keys(cutover.parsed.receipt.branches).sort(), ["main", branch].sort());
  for (const [receiptBranch, receipt] of Object.entries(cutover.parsed.receipt.branches)) {
    for (const key of ["inventoryHash", "pathHash", "contentHash", "sizeHash", "mimeHash", "executableHash", "tombstoneHash"]) {
      assert.equal(typeof receipt.legacy[key], "string", `legacy ${key} must be receipted`);
      assert.equal(typeof receipt.manifest[key], "string", `manifest ${key} must be receipted`);
    }
    for (const inventory of [receipt.legacy, receipt.manifest]) {
      for (const key of ["fileCount", "tombstoneCount", "totalBytes"]) assert.ok(Number.isSafeInteger(inventory[key]), `${receiptBranch} ${key} must be receipted`);
    }
    assert.equal(receipt.manifest.fileCount, receiptBranch === "main" ? 2 : 3);
    assert.equal(receipt.legacy.tombstoneCount, receiptBranch === "main" ? 1 : 2);
  }

  const mainRead = await request("/v1/read?branch=main", undefined, instance);
  assert.equal(mainRead.response.status, 200, JSON.stringify(mainRead.parsed));
  assert.deepEqual(mainRead.parsed.entries.map((entry) => entry.path).sort(), ["README.md", "docs/base.md"]);
  assert.equal(mainRead.parsed.entries.find((entry) => entry.path === "README.md").contentType, "text/markdown");
  const branchRead = await request(`/v1/read?branch=${encodeURIComponent(branch)}`, undefined, instance);
  assert.equal(branchRead.response.status, 200, JSON.stringify(branchRead.parsed));
  assert.deepEqual(branchRead.parsed.entries.map((entry) => entry.path).sort(), ["README.md", "overlay.txt", "run.sh"]);
  assert.equal(branchRead.parsed.entries.find((entry) => entry.path === "run.sh").executable, true);
  assert.equal(branchRead.parsed.entries.find((entry) => entry.path === "overlay.txt").contentType, "text/plain; charset=utf-8");

  const original = mainRead.parsed.entries.find((entry) => entry.path === "README.md");
  const opened = await request("/v1/open", { scope, branch: "main", actorId: "migration-smoke", runtimeId: "migration-smoke", allocationGeneration: 1 }, instance);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.parsed));
  const changed = await request("/v1/checkpoint", {
    sessionId: opened.parsed.session.id, runtimeId: "migration-smoke", allocationGeneration: 1,
    fence: opened.parsed.session.fence, baseRevision: mainRead.parsed.head.revision,
    idempotencyKey: "migration-smoke-edit", changes: [{ path: "README.md", expectedHash: original.sha256, contentBase64: Buffer.from("changed after cutover").toString("base64"), contentType: "text/markdown" }],
  }, instance);
  assert.equal(changed.response.status, 200, JSON.stringify(changed.parsed));

  const status = await request("/v1/migration/status", undefined, instance);
  const restored = await request("/v1/migration/restore", { scope, confirm: true, restoreId: `restore-${runId}`, expectedHeads: status.parsed.currentHeads }, instance);
  assert.equal(restored.response.status, 200, JSON.stringify(restored.parsed));
  assert.equal(restored.parsed.restore.status, "verified");
  const restoredMain = await request("/v1/read?branch=main", undefined, instance);
  assert.equal(restoredMain.parsed.entries.find((entry) => entry.path === "README.md").sha256, original.sha256);
  const protectedAlias = await request("/v1/migration/retire-alias", { scope, migrationId }, instance);
  assert.equal(protectedAlias.response.status, 423, "the rollback alias must remain protected through its window");

  const erased = await request("/v1/erase", { scope, confirm: true }, instance);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.parsed));
  const cleanup = await request("/__smoke/cleanup-legacy", {}, instance);
  assert.equal(cleanup.response.status, 200, JSON.stringify(cleanup.parsed));
  const legacyKeys = await r2Page(`spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`, 100, undefined, instance);
  assert.equal(legacyKeys.keys.length, 0, "the uniquely scoped disposable legacy fixture is cleaned after migration checks");
  console.log("Workspace migration smoke passed: main/branch receipts, zero cutover drift, atomic policy switch, branch overlay read, checked rollback restore, and scoped fixture cleanup.");
}

async function runLargeFileSmoke() {
  const instance = process.env.WORKSPACE_SMOKE_LARGE_INSTANCE ?? "large";
  const scope = scopeFor(instance);
  const initialized = await request("/v1/initialize", { scope, branch: "main", entries: [] }, instance);
  assert.ok([200, 201].includes(initialized.response.status), JSON.stringify(initialized.parsed));
  const read = await request("/v1/read?branch=main", undefined, instance);
  assert.equal(read.response.status, 200, JSON.stringify(read.parsed));
  const opened = await request("/v1/open", { scope, branch: "main", actorId: "large-file-smoke", runtimeId: "large-file-smoke", allocationGeneration: 1 }, instance);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.parsed));

  const size = 20 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 0x5a);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const published = await request("/v1/checkpoint", {
    sessionId: opened.parsed.session.id, runtimeId: "large-file-smoke", allocationGeneration: 1,
    fence: opened.parsed.session.fence, baseRevision: read.parsed.head.revision,
    idempotencyKey: `large-file-${runId}`, changes: [{ path: "uploads/20m.bin", expectedHash: null, contentBase64: bytes.toString("base64"), contentType: "application/octet-stream" }],
  }, instance);
  assert.equal(published.response.status, 200, JSON.stringify(published.parsed));
  const head = await request("/v1/read?branch=main", undefined, instance);
  const entry = head.parsed.entries.find((candidate) => candidate.path === "uploads/20m.bin");
  assert.ok(entry, "the 20 MiB object must be present in the published manifest");
  assert.equal(entry.size, size);
  assert.equal(entry.sha256, hash);

  const reader = await request("/v1/open", { scope, branch: "main", actorId: "large-file-read", runtimeId: "large-file-read", allocationGeneration: 1 }, instance);
  const query = new URLSearchParams({ sessionId: reader.parsed.session.id, runtimeId: "large-file-read", allocationGeneration: "1", fence: String(reader.parsed.session.fence), path: "uploads/20m.bin" });
  const content = await fetch(`${base}/v1/session-content?${query}`, { headers: smokeHeaders(instance) });
  assert.equal(content.status, 200, await content.text());
  assert.equal(Number(content.headers.get("content-length")), size);
  assert.equal(content.headers.get("x-content-sha256"), hash);
  assert.equal(createHash("sha256").update(Buffer.from(await content.arrayBuffer())).digest("hex"), hash);
  const erased = await request("/v1/erase", { scope, confirm: true }, instance);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.parsed));
  console.log(`Workspace transfer smoke passed: ${size} bytes traversed Worker → Durable Object → R2 and read back with matching SHA-256.`);
}
