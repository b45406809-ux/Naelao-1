import assert from "node:assert/strict";

const base = process.env.WORKSPACE_SMOKE_URL ?? "http://127.0.0.1:8791";
const scope = { tenantId: "runtime-tenant", spaceId: "runtime-space", projectId: "runtime-project", jurisdiction: "global" };
const request = async (path, body) => {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const parsed = await response.json();
  return { response, parsed };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const seeded = await fetch(`${base}/__smoke/seed-content`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 205 }) });
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
const remaining = await fetch(`${base}/__smoke/r2?prefix=workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/`);
const keys = await remaining.json();
assert.deepEqual(keys.keys, []);
console.log("Cloudflare local runtime smoke passed: SQLite DO transactions, alarm, concurrent CAS, R2 read, and erasure.");

async function envlessR2Object(key) {
  const keys = await listAllR2(`workspace-v1/${key}`);
  return keys.includes(`workspace-v1/${key}`);
}

async function r2Page(prefix, limit, cursor) {
  const params = new URLSearchParams({ prefix, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${base}/__smoke/r2?${params}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function listAllR2(prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await r2Page(prefix, 100, cursor);
    keys.push(...page.keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}
