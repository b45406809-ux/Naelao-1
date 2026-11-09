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
const request = async (path, body, instance = "runtime", extraHeaders = {}) => {
  const headers = { ...smokeHeaders(instance), ...extraHeaders };
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
if (process.env.WORKSPACE_SMOKE_GIT === "true") await runGitSmoke();
if (process.env.WORKSPACE_SMOKE_LARGE_FILE === "true") await runLargeFileSmoke();
if (process.env.WORKSPACE_SMOKE_TOOLSANDBOX === "true") await runToolSandboxSmoke();

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

async function gitRequest(instance, path, method = "GET", body, journal = false) {
  const headers = smokeHeaders(instance);
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}/__smoke/${journal ? "git-journal" : "git"}/${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => ({}));
  return { response, parsed };
}

async function runMigrationSmoke() {
  const instance = "migration";
  const scope = scopeFor(instance);
  const branch = "workers/worker-a";
  const migrationId = `smoke-migration-${runId}`;
  const bulkCount = process.env.WORKSPACE_SMOKE_PAGINATED_MIGRATION === "true" ? 1002 : 0;
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
  for (let offset = 0; offset < bulkCount; offset += 100) {
    const entries = Array.from({ length: Math.min(100, bulkCount - offset) }, (_, index) => {
      const fixtureIndex = offset + index;
      return legacyFile(`bulk/file-${String(fixtureIndex).padStart(4, "0")}.txt`, `bulk fixture ${fixtureIndex}`, "text/plain; charset=utf-8");
    });
    const seeded = await request("/__smoke/seed-legacy", { entries }, instance);
    assert.equal(seeded.response.status, 200, JSON.stringify(seeded.parsed));
  }

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
    assert.equal(receipt.manifest.fileCount, (receiptBranch === "main" ? 2 : 3) + bulkCount);
    assert.equal(receipt.legacy.tombstoneCount, receiptBranch === "main" ? 1 : 2);
  }

  const mainRead = await request("/v1/read?branch=main", undefined, instance);
  assert.equal(mainRead.response.status, 200, JSON.stringify(mainRead.parsed));
  assert.equal(mainRead.parsed.entries.length, 2 + bulkCount);
  if (bulkCount) assert.ok(mainRead.parsed.entries.some((entry) => entry.path === "bulk/file-1001.txt"));
  assert.ok(!mainRead.parsed.entries.some((entry) => entry.path === "docs/deleted.md"));
  assert.equal(mainRead.parsed.entries.find((entry) => entry.path === "README.md").contentType, "text/markdown");
  const branchRead = await request(`/v1/read?branch=${encodeURIComponent(branch)}`, undefined, instance);
  assert.equal(branchRead.response.status, 200, JSON.stringify(branchRead.parsed));
  assert.equal(branchRead.parsed.entries.length, 3 + bulkCount);
  assert.ok(!branchRead.parsed.entries.some((entry) => entry.path === "docs/base.md"));
  if (bulkCount) assert.ok(branchRead.parsed.entries.some((entry) => entry.path === "bulk/file-1001.txt"));
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

  if (process.env.WORKSPACE_SMOKE_WAIT_FOR_ROLLBACK_EXPIRY === "true") {
    const expiry = Date.parse(cutover.parsed.readPolicy.rollbackExpiresAt);
    assert.ok(Number.isFinite(expiry), "cutover must record the rollback expiry");
    while (Date.now() < expiry) await wait(Math.min(1000, expiry - Date.now()));
    const responseLost = await request("/v1/migration/retire-alias", { scope, migrationId }, instance, { "x-workspace-smoke-drop-first-alias-response": "true" });
    assert.equal(responseLost.response.status, 503, JSON.stringify(responseLost.parsed));
    const cleanupRetry = await request("/v1/migration/retire-alias", { scope, migrationId }, instance);
    assert.equal(cleanupRetry.response.status, 200, JSON.stringify(cleanupRetry.parsed));
    const statusAfterCleanup = await request("/v1/migration/status", undefined, instance);
    assert.equal(statusAfterCleanup.parsed.rollbackAlias, null);
    assert.equal(statusAfterCleanup.parsed.aliasCleanup.migrationId, migrationId);
    assert.equal((await listAllR2(`spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`, instance)).length, 0);
  } else {
    const erased = await request("/v1/erase", { scope, confirm: true }, instance);
    assert.equal(erased.response.status, 200, JSON.stringify(erased.parsed));
    const cleanup = await request("/__smoke/cleanup-legacy", {}, instance);
    assert.equal(cleanup.response.status, 200, JSON.stringify(cleanup.parsed));
    const legacyKeys = await r2Page(`spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`, 100, undefined, instance);
    assert.equal(legacyKeys.keys.length, 0, "the uniquely scoped disposable legacy fixture is cleaned after migration checks");
  }
  const erased = await request("/v1/erase", { scope, confirm: true }, instance);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.parsed));
  console.log(`Workspace migration smoke passed: main/branch receipts with ${bulkCount} additional paginated files, zero cutover drift, atomic policy switch, branch overlays, checked rollback restore${process.env.WORKSPACE_SMOKE_WAIT_FOR_ROLLBACK_EXPIRY === "true" ? ", alias cleanup after expiry, and retry after a lost response" : ", and scoped fixture cleanup"}.`);
}

async function runGitSmoke() {
  const instance = "git";
  const scope = scopeFor(instance);
  const branch = "agents/worker-a";
  const metadata = { agent_role: "agent", user_goal: "disposable Git workspace smoke", task_id: "workspace-git-smoke", rationale: "verify checked Git projection lifecycle", thread_id: "workspace-smoke", tool_turn_id: `git-${runId}` };
  const initialized = await request("/v1/initialize", { scope, branch: "main", entries: [] }, instance);
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.parsed));
  const repoInit = await gitRequest(instance, "init", "POST", {});
  assert.equal(repoInit.response.status, 200, JSON.stringify(repoInit.parsed));

  const baseBytes = Buffer.from("main baseline");
  const baseHash = createHash("sha256").update(baseBytes).digest("hex");
  const mainCommit = await gitRequest(instance, "commit", "POST", {
    branch: "main", expected_head: null, metadata,
    changes: [{ path: "README.md", expected_hash: null, content_base64: baseBytes.toString("base64") }],
  });
  assert.equal(mainCommit.response.status, 201, JSON.stringify(mainCommit.parsed));

  const seededBranch = await gitRequest(instance, "branch", "POST", { name: branch, from: mainCommit.parsed.commit_id });
  assert.equal(seededBranch.response.status, 201, JSON.stringify(seededBranch.parsed));
  const childBytes = Buffer.from("worker contribution");
  const childCommit = await gitRequest(instance, "commit", "POST", {
    branch, expected_head: mainCommit.parsed.commit_id, metadata,
    changes: [{ path: "worker.txt", expected_hash: null, content_base64: childBytes.toString("base64") }],
  });
  assert.equal(childCommit.response.status, 201, JSON.stringify(childCommit.parsed));
  const merged = await gitRequest(instance, "merge", "POST", { target: "main", source: branch, expected_head: mainCommit.parsed.commit_id, metadata });
  assert.equal(merged.response.status, 200, JSON.stringify(merged.parsed));
  assert.equal(merged.parsed.fast_forward, true);

  const initialVerify = await gitRequest(instance, "verify-workspace?branch=main");
  assert.equal(initialVerify.response.status, 200, JSON.stringify(initialVerify.parsed));
  assert.equal(initialVerify.parsed.verified, true, JSON.stringify(initialVerify.parsed));

  const driftWrite = await gitRequest(instance, "write?branch=main", "PUT", {
    path: "README.md", expected_hash: baseHash, content_base64: Buffer.from("next baseline").toString("base64"),
  });
  assert.equal(driftWrite.response.status, 200, JSON.stringify(driftWrite.parsed));
  const drift = await gitRequest(instance, "verify-workspace?branch=main");
  assert.equal(drift.response.status, 200, JSON.stringify(drift.parsed));
  assert.equal(drift.parsed.verified, false);
  assert.deepEqual(drift.parsed.workspace_dual_read.mismatchClasses, ["hash_mismatch"]);
  assert.equal(drift.parsed.workspace_dual_read.mismatchCount, 1);
  assert.ok(!JSON.stringify(drift.parsed).includes("README.md"), "dual-read receipt must not expose the path");
  console.log(JSON.stringify({
    type: "workspace_git_dual_read_receipt", scope: { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId },
    branch: "main", revision: drift.parsed.workspace_dual_read.revision,
    compared: drift.parsed.workspace_dual_read.compared, mismatchCount: drift.parsed.workspace_dual_read.mismatchCount,
    mismatchClasses: drift.parsed.workspace_dual_read.mismatchClasses, mismatches: drift.parsed.workspace_dual_read.mismatches,
    truncated: drift.parsed.workspace_dual_read.truncated,
  }));

  const repaired = await gitRequest(instance, "reconcile", "POST", { branch: "main", metadata });
  assert.equal(repaired.response.status, 200, JSON.stringify(repaired.parsed));
  assert.equal(repaired.parsed.changed, 1);
  const clean = await gitRequest(instance, "verify-workspace?branch=main");
  assert.equal(clean.response.status, 200, JSON.stringify(clean.parsed));
  assert.equal(clean.parsed.verified, true, JSON.stringify(clean.parsed));
  assert.equal(clean.parsed.workspace_dual_read.mismatchCount, 0);
  console.log(JSON.stringify({
    type: "workspace_git_repair_receipt", scope: { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId },
    branch: "main", revision: clean.parsed.workspace_dual_read.revision, changed: repaired.parsed.changed,
    mismatchCount: clean.parsed.workspace_dual_read.mismatchCount, truncated: clean.parsed.workspace_dual_read.truncated,
  }));

  const currentHead = await gitRequest(instance, "head?branch=main");
  const rolledBack = await gitRequest(instance, "rollback", "POST", { branch: "main", commit_id: mainCommit.parsed.commit_id, expected_head: currentHead.parsed.commit_id, metadata });
  assert.equal(rolledBack.response.status, 201, JSON.stringify(rolledBack.parsed));
  const mainAfterRollback = await request("/v1/read?branch=main", undefined, instance);
  assert.equal(mainAfterRollback.response.status, 200, JSON.stringify(mainAfterRollback.parsed));
  assert.deepEqual(mainAfterRollback.parsed.entries.map((entry) => entry.path), ["README.md"]);
  assert.equal(mainAfterRollback.parsed.entries[0].sha256, baseHash);
  console.log(JSON.stringify({
    type: "workspace_git_push_lifecycle_receipt", scope: { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId },
    branchCount: 2, branchSeeded: true, childCommitPublished: true, checkedMerge: merged.parsed.fast_forward,
    rollbackPublished: true, finalWorkspaceRevision: rolledBack.parsed.workspace_revision,
  }));
  await request("/v1/erase", { scope, confirm: true }, instance);
  const repositoryCleanup = await request("/__smoke/cleanup-repository", {}, instance);
  assert.equal(repositoryCleanup.response.status, 200, JSON.stringify(repositoryCleanup.parsed));

  await runJournalReplaySmoke();
}

async function runJournalReplaySmoke() {
  const instance = "git-journal";
  const scope = scopeFor(instance);
  const metadata = { agent_role: "agent", user_goal: "disposable journal replay smoke", task_id: "workspace-git-journal", rationale: "recover one lost legacy R2 PUT response", thread_id: "workspace-smoke", tool_turn_id: `journal-${runId}` };
  const initialized = await gitRequest(instance, "init", "POST", {}, true);
  assert.equal(initialized.response.status, 200, JSON.stringify(initialized.parsed));
  const mainCommit = await gitRequest(instance, "commit", "POST", {
    branch: "main", expected_head: null, metadata,
    changes: [{ path: "journal.txt", expected_hash: null, content_base64: Buffer.from("journal content").toString("base64") }],
  }, true);
  assert.equal(mainCommit.response.status, 201, JSON.stringify(mainCommit.parsed));
  const armed = await gitRequest(instance, "__smoke/arm-lost-put", "POST", {}, true);
  assert.equal(armed.response.status, 200, JSON.stringify(armed.parsed));
  const failedBranchSeed = await gitRequest(instance, "branch", "POST", { name: "agents/worker-a", from: mainCommit.parsed.commit_id, temporary: true }, true);
  assert.equal(failedBranchSeed.response.status, 503, JSON.stringify(failedBranchSeed.parsed));
  const pending = await gitRequest(instance, "__smoke/journal-status", "GET", undefined, true);
  assert.equal(pending.parsed.pending, true);
  const replayedTree = await gitRequest(instance, "tree?branch=agents%2Fworker-a", "GET", undefined, true);
  assert.equal(replayedTree.response.status, 200, JSON.stringify(replayedTree.parsed));
  assert.deepEqual(replayedTree.parsed.data.map((entry) => entry.path), ["journal.txt"], "journal replay must restore the branch projection after the PUT response is lost");
  const cleared = await gitRequest(instance, "__smoke/journal-status", "GET", undefined, true);
  assert.equal(cleared.parsed.pending, false);
  const legacyPrefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/branches/agents/worker-a/`;
  assert.equal((await listAllR2(legacyPrefix, instance)).length, 1);
  console.log(JSON.stringify({
    type: "workspace_git_publication_journal_replay_receipt", scope: { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: scope.projectId },
    branch: "agents/worker-a", putCommittedBeforeSimulatedTimeout: true, pendingJournalRecovered: true,
    journalPendingAfterRetry: false, finalCommitId: mainCommit.parsed.commit_id,
  }));
  const cleanup = await request("/__smoke/cleanup-legacy", {}, instance);
  assert.equal(cleanup.response.status, 200, JSON.stringify(cleanup.parsed));
  const repositoryCleanup = await request("/__smoke/cleanup-repository", {}, instance);
  assert.equal(repositoryCleanup.response.status, 200, JSON.stringify(repositoryCleanup.parsed));
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
  if (content.status !== 200) throw new Error(`20 MiB read failed (${content.status}): ${await content.text()}`);
  assert.equal(Number(content.headers.get("content-length")), size);
  assert.equal(content.headers.get("x-content-sha256"), hash);
  assert.equal(createHash("sha256").update(Buffer.from(await content.arrayBuffer())).digest("hex"), hash);
  const erased = await request("/v1/erase", { scope, confirm: true }, instance);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.parsed));
  console.log(`Workspace transfer smoke passed: ${size} bytes traversed Worker → Durable Object → R2 and read back with matching SHA-256.`);
}

async function runToolSandboxSmoke() {
  const instance = "toolsandbox";
  const call = async (operation, executionId, body, method = "POST") => {
    const headers = smokeHeaders(instance);
    if (body !== undefined) headers["content-type"] = "application/json";
    const query = executionId ? `?executionId=${encodeURIComponent(executionId)}` : "";
    const response = await fetch(`${base}/__smoke/toolsandbox/${operation}${query}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json().catch(() => ({}));
    return { response, parsed };
  };
  const cold = await call("status", undefined, undefined, "GET");
  assert.equal(cold.response.status, 200, JSON.stringify(cold.parsed));
  assert.equal(cold.parsed.running, false);

  const prewarmed = await call("prewarm", `prewarm-${runId}`, {});
  assert.equal(prewarmed.response.status, 200, JSON.stringify(prewarmed.parsed));
  assert.equal(prewarmed.parsed.result.status, "warm");
  const warm = await call("status", undefined, undefined, "GET");
  assert.equal(warm.parsed.running, true, "prewarm must start an actual local container runtime");

  const executionId = `shell-${runId}`;
  const shellBody = { command: "printf '%s' 'tool-sandbox-runtime-ok'" };
  const executed = await call("shell", executionId, shellBody);
  assert.equal(executed.response.status, 200, JSON.stringify(executed.parsed));
  assert.equal(executed.parsed.ok, true, JSON.stringify(executed.parsed));
  assert.ok(executed.parsed.stdout.includes("tool-sandbox-runtime-ok"), "the real container must execute a command");
  const replay = await call("shell", executionId, shellBody);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.parsed));
  assert.deepEqual(replay.parsed, executed.parsed, "the completed execution must replay idempotently");
  const conflictingReplay = await call("shell", executionId, { command: "printf changed" });
  assert.equal(conflictingReplay.response.status, 409);

  for (const status of ["failed", "cancelled", "suspended", "indeterminate"]) {
    const lifecycle = await call("lifecycle", `lifecycle-${status}-${runId}`, {
      status, tenantId: scopeFor(instance).tenantId, spaceId: scopeFor(instance).spaceId,
      projectId: scopeFor(instance).projectId,
    });
    assert.equal(lifecycle.response.status, 200, `${status}: ${JSON.stringify(lifecycle.parsed)}`);
    assert.equal(lifecycle.parsed.status, status);
  }

  const stopped = await call("stop", undefined, undefined, "GET");
  assert.equal(stopped.response.status, 200, JSON.stringify(stopped.parsed));
  assert.equal(stopped.parsed.running, false, "explicit lifecycle stop must destroy the runtime");
  assert.equal(stopped.parsed.status, "hibernated");
  const restarted = await call("prewarm", `restart-${runId}`, {});
  assert.equal(restarted.response.status, 200, JSON.stringify(restarted.parsed));
  const warmAgain = await call("status", undefined, undefined, "GET");
  assert.equal(warmAgain.parsed.running, true, "the same Durable Object must be able to cold restart");
  const finalStop = await call("stop", undefined, undefined, "GET");
  assert.equal(finalStop.parsed.running, false);
  console.log("ToolSandbox real-container smoke passed locally: cold start, prewarm, shell execution, idempotent replay/conflict, terminal lifecycle transitions, stop, and restart.");
}
