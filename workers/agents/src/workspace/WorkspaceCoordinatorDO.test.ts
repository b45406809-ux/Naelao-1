import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinatorDO } from "./WorkspaceCoordinatorDO.js";
import { sha256Hex } from "./workspace-contract.js";

class Storage {
  values = new Map<string, unknown>();
  alarmAt: number | null = null;
  private transactionQueue = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async list<T>({ prefix = "", startAfter, limit = 1000 }: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit) as Array<[string, T]>);
  }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) { let deleted = false; for (const item of key) deleted = this.values.delete(item) || deleted; return deleted; }
    return this.values.delete(key);
  }
  async deleteAll(): Promise<void> { this.values.clear(); }
  async getAlarm(): Promise<number | null> { return this.alarmAt; }
  async setAlarm(scheduledTime: number | Date): Promise<void> { this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime; }
  async deleteAlarm(): Promise<void> { this.alarmAt = null; }
  async transaction<T>(callback: (txn: this) => Promise<T>): Promise<T> {
    const next = this.transactionQueue.then(() => callback(this));
    this.transactionQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function setup(options: { liveEnabled?: boolean; liveVerifier?: boolean; unifiedEnabled?: boolean; runtimeControl?: "ok" | "flush_failure" | "activation_failure";
  candidateSelection?: { runtimeId: string; allocationGeneration: number } } = {}) {
  const storage = new Storage();
  const objects = new Map<string, Uint8Array>();
  const metadata = new Map<string, { contentType?: string }>();
  const customMetadata = new Map<string, Record<string, string>>();
  const verificationState = { authorized: true };
  const r2: Record<string, (...args: never[]) => unknown> = {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, httpMetadata: metadata.get(key) ?? {}, async arrayBuffer() { return bytes.slice().buffer; } } : null;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      objects.set(key, bytes.slice());
      if (options?.httpMetadata) metadata.set(key, options.httpMetadata);
      if (options?.customMetadata) customMetadata.set(key, options.customMetadata);
      return { key, size: bytes.byteLength };
    },
    async head(key: string) { const bytes = objects.get(key); return bytes ? { key, size: bytes.byteLength } : null; },
    async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
      const after = cursor ? atob(cursor.slice("opaque:".length)) : "";
      const matching = [...objects.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort();
      const selected = matching.slice(0, limit);
      const truncated = matching.length > selected.length;
      return { objects: selected.map(key => ({ key, uploaded: new Date(0), size: objects.get(key)!.byteLength, httpMetadata: metadata.get(key) ?? {}, customMetadata: customMetadata.get(key) ?? {} })), truncated, cursor: truncated && selected.length ? `opaque:${btoa(selected.at(-1)!)}` : undefined };
    },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  };
  const verifier = options.liveVerifier ?? options.liveEnabled ? { async fetch(request: Request) {
    const body = await request.json() as { capabilityEvidence?: unknown };
    if (!verificationState.authorized) return Response.json({ verified: false, missing: ["authorizationRevoked"] });
    const evidence = body.capabilityEvidence && typeof body.capabilityEvidence === "object" ? body.capabilityEvidence as Record<string, unknown> : {};
    const selection = options.candidateSelection;
    const complete = { authorized: true, residencyAllowed: true, liveMountReady: true, fuseReady: true, incrementalSyncReady: true,
      flushReady: true, reconnectGenerationCheck: true, authenticatedTransport: true, billingReserved: true, budgetReserved: true,
      runtimeAccountingReady: true, ...evidence, ...(selection ? { ...selection, allocationId: `allocation-${selection.allocationGeneration}`,
        billingReservationId: `billing-${selection.allocationGeneration}`, budgetReservationId: `budget-${selection.allocationGeneration}` } : {}) };
    return Response.json({ verified: true, evidence: complete,
      ...(selection ? { candidateSearchPerformed: true } : {}) });
  } } : undefined;
  const runtimeControl = options.runtimeControl ? { async fetch(request: Request) {
    const body = await request.json() as Record<string, unknown>;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/checkpoint/sync")) return Response.json({ synced: true, nonce: body.nonce, requestId: body.requestId,
      sessionId: body.sessionId, runtimeId: body.runtimeId, allocationGeneration: body.allocationGeneration, fence: body.fence,
      changes: [{ path: "live.txt", expectedHash: null, contentBase64: btoa("live checkpoint") }], cursor: "runtime-cursor-1" });
    if (path.endsWith("/checkpoint/ack")) return Response.json({ acknowledged: true });
    if (path.endsWith("/prepare")) {
      if (options.runtimeControl === "flush_failure") return Response.json({ prepared: false, error_code: "flush_failed" }, { status: 503 });
      return Response.json({ prepared: true, receipt: {
        id: "flush-verified", nonce: body.nonce, sessionId: body.sessionId, runtimeId: body.runtimeId,
        allocationGeneration: body.allocationGeneration, fence: body.fence, revision: 1,
        writeAdmissionStopped: true, inFlightDrained: true, filesystemFlushed: true,
        flushMethod: "fsync", flushCompletedAt: Date.now(),
      } });
    }
    if (path.endsWith("/activate")) {
      if (options.runtimeControl === "activation_failure") return Response.json({ activated: false }, { status: 503 });
      return Response.json({ activated: true, nonce: body.nonce, sessionId: body.sessionId, runtimeId: body.runtimeId,
        allocationGeneration: body.allocationGeneration, fence: body.fence, revision: body.revision });
    }
    return Response.json({ aborted: true });
  } } : undefined;
  const env = { PLATFORM_SECRET: "secret", SCRIPTS_R2: r2 as unknown as R2Bucket, LIVE_WORKSPACE_ENABLED: options.liveEnabled ? "true" : "false",
    ...(verifier ? { LIVE_CAPABILITY_VERIFIER: verifier as unknown as Fetcher } : {}),
    ...(runtimeControl ? { LIVE_RUNTIME_CONTROL: runtimeControl as unknown as Fetcher } : {}),
    UNIFIED_WORKSPACE_ENABLED: options.unifiedEnabled ? "true" : "false" };
  const instance = new WorkspaceCoordinatorDO({ storage } as never, env as never);
  return { instance, restart: () => new WorkspaceCoordinatorDO({ storage } as never, env as never), storage, objects, metadata, customMetadata, r2, verificationState };
}

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
function liveEvidence(generation: number, overrides: Record<string, unknown> = {}) {
  return {
    authorized: true, authorizationId: "grant-live", authorizationEpoch: 1, residencyAllowed: true, residencyPolicyId: "residency-global",
    runtimeId: "runtime", runtimeType: "agent37-vm", templateId: "naelao-live", templateDigest: `sha256:${"a".repeat(64)}`, region: "us-east-1",
    liveMountReady: true, fuseReady: true, incrementalSyncReady: true, flushReady: true, reconnectGenerationCheck: true,
    authenticatedTransport: true, allocationId: `allocation-${generation}`, allocationGeneration: generation,
    billingReserved: true, billingReservationId: `billing-${generation}`, budgetReserved: true, budgetReservationId: `budget-${generation}`,
    runtimeAccountingReady: true, verifiedAt: Date.now(), ...overrides,
  };
}
interface InventorySummaryRecord {
  inventoryHash: string; pathHash: string; contentHash: string; sizeHash: string; mimeHash: string; executableHash: string;
  tombstoneHash: string; fileCount: number; tombstoneCount: number; totalBytes: number;
}
async function call(instance: WorkspaceCoordinatorDO, path: string, body?: unknown, method = body ? "POST" : "GET") {
  const headers = new Headers({ "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") });
  if (body) headers.set("content-type", "application/json");
  return instance.fetch(new Request(`https://workspace${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
}

describe("WorkspaceCoordinatorDO checked publication", () => {
  it("imports an existing project behind a durable barrier and retains a verified rollback alias", async () => {
    const { instance, objects, storage, metadata } = setup();
    const legacyKey = "spaces/space/projects/project/workspace/docs/legacy.md";
    objects.set(legacyKey, new TextEncoder().encode("existing project content"));
    metadata.set(legacyKey, { contentType: "text/markdown; charset=utf-8" });
    const migration = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-existing-project" });
    expect(migration.status).toBe(201);
    expect(await migration.json()).toMatchObject({
      migration: { migrationId: "migration-existing-project", status: "verified", revision: 1 },
      rollbackAlias: { sourcePrefix: "spaces/space/projects/project/workspace/", verificationStatus: "verified", revision: 1 },
      fileCount: 1,
    });
    expect(storage.values.get("legacy_rollback_alias")).toMatchObject({ verificationStatus: "verified" });
    expect(await (await call(instance, "/v1/read?branch=main")).json()).toMatchObject({
      head: { revision: 1 }, entries: [{ path: "docs/legacy.md", size: 24, contentType: "text/markdown; charset=utf-8" }],
    });
    const entries = await (await call(instance, "/v1/read?branch=main")).json() as { entries: Array<{ objectKey: string }> };
    expect(metadata.get(entries.entries[0]!.objectKey)).toEqual({ contentType: "text/markdown; charset=utf-8" });
    expect(objects.has(legacyKey)).toBe(true);
    expect((await call(instance, "/v1/migration/import", { scope, migrationId: "migration-existing-project" })).status).toBe(200);
  });

  it("persists a complete shadow receipt and atomically switches the project to coordinator reads", async () => {
    const { instance, objects, metadata, customMetadata, storage } = setup({ unifiedEnabled: true });
    const legacyKey = "spaces/space/projects/project/workspace/bin/run.sh";
    objects.set(legacyKey, new TextEncoder().encode("#!/bin/sh\nexit 0\n"));
    metadata.set(legacyKey, { contentType: "text/x-shellscript" });
    customMetadata.set(legacyKey, { executable: "true" });
    const migrated = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-cutover-clean" });
    expect(migrated.status).toBe(201);
    expect(await (await call(instance, "/v1/read-policy")).json()).toMatchObject({ mode: "shadow", generation: 0, migrationId: "migration-cutover-clean" });
    expect((await call(instance, "/v1/open", { scope, branch: "main", actorId: "worker", runtimeId: "run", allocationGeneration: 1 })).status).toBe(423);

    const response = await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-cutover-clean", rollbackWindowMs: 60 * 60_000 });
    expect(response.status).toBe(200);
    const result = await response.json() as { readPolicy: { mode: string; generation: number; receipt: { mismatchCount: number; readErrorCount: number; omittedPathCount: number; truncatedPages: number; branches: Record<string, { legacy: { pathHash: string; contentHash: string; sizeHash: string; mimeHash: string; executableHash: string; tombstoneCount: number }; manifest: { inventoryHash: string } }> } } };
    expect(result.readPolicy).toMatchObject({ mode: "coordinator", generation: 1, receipt: { mismatchCount: 0, readErrorCount: 0, omittedPathCount: 0, truncatedPages: 0 } });
    expect(result.readPolicy.receipt.branches.main.legacy).toMatchObject({ pathHash: expect.stringMatching(/^[a-f0-9]{64}$/), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), sizeHash: expect.stringMatching(/^[a-f0-9]{64}$/), mimeHash: expect.stringMatching(/^[a-f0-9]{64}$/), executableHash: expect.stringMatching(/^[a-f0-9]{64}$/), tombstoneCount: 0 });
    expect(result.readPolicy.receipt.branches.main.manifest.inventoryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.readPolicy.receipt.branches.main.manifest.inventoryHash).toBe(result.readPolicy.receipt.branches.main.legacy.inventoryHash);
    expect(await storage.get("legacy_rollback_alias")).toMatchObject({ verificationStatus: "verified", rollbackExpiresAt: expect.any(String), cleanupStatus: "pending" });
    expect((await call(instance, "/v1/open", { scope, branch: "main", actorId: "worker", runtimeId: "run", allocationGeneration: 1 })).status).toBe(200);
  });

  it("keeps the reader in shadow mode when the bounded legacy comparison finds drift", async () => {
    const { instance, objects, storage } = setup({ unifiedEnabled: true });
    const legacyKey = "spaces/space/projects/project/workspace/docs/drift.md";
    objects.set(legacyKey, new TextEncoder().encode("before"));
    expect((await call(instance, "/v1/migration/import", { scope, migrationId: "migration-cutover-drift" })).status).toBe(201);
    objects.set(legacyKey, new TextEncoder().encode("after"));
    const response = await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-cutover-drift", rollbackWindowMs: 60 * 60_000 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "workspace_migration_dual_read_mismatch", attempt: { mismatchClass: "inventory_mismatch", mismatchCount: 1, readErrorCount: 0, omittedPathCount: 0, truncatedPages: 0 } });
    expect(await storage.get("workspace_read_policy")).toMatchObject({ mode: "shadow" });
    expect((await call(instance, "/v1/open", { scope, branch: "main", actorId: "worker", runtimeId: "run", allocationGeneration: 1 })).status).toBe(423);
  });

  it("keeps cutover behind the existing global workspace gate", async () => {
    const { instance, objects, storage } = setup();
    objects.set("spaces/space/projects/project/workspace/docs/readme.md", new TextEncoder().encode("source"));
    expect((await call(instance, "/v1/migration/import", { scope, migrationId: "migration-global-gate" })).status).toBe(201);
    const cutover = await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-global-gate", rollbackWindowMs: 60 * 60_000 });
    expect(cutover.status).toBe(423);
    expect(await cutover.json()).toMatchObject({ error_code: "workspace_global_kill_switch_active" });
    expect(await storage.get("workspace_read_policy")).toMatchObject({ mode: "shadow" });
  });

  it("repairs shadow drift from the mutation-barrier legacy snapshot and requires a clean pass before cutover", async () => {
    const { instance, objects, storage } = setup({ unifiedEnabled: true });
    const legacyKey = "spaces/space/projects/project/workspace/docs/drift.md";
    objects.set(legacyKey, new TextEncoder().encode("before"));
    expect((await call(instance, "/v1/migration/import", { scope, migrationId: "migration-repair-drift" })).status).toBe(201);
    objects.set(legacyKey, new TextEncoder().encode("after"));
    expect((await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-repair-drift", rollbackWindowMs: 60 * 60_000 })).status).toBe(409);
    const repaired = await call(instance, "/v1/migration/repair", { scope, migrationId: "migration-repair-drift" });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ repair: { migrationId: "migration-repair-drift", repairedBranchCount: 1, status: "verified" } });
    expect(await storage.get("workspace_migration_repair_receipt")).toMatchObject({ repairedBranchCount: 1, status: "verified" });
    expect((await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-repair-drift", rollbackWindowMs: 60 * 60_000 })).status).toBe(200);
    const read = await call(instance, "/v1/read?branch=main&path=docs%2Fdrift.md");
    expect(await read.json()).toMatchObject({ entries: [{ sha256: await sha256Hex(new TextEncoder().encode("after")) }] });
  });

  it("includes branch overlay tombstones and retries alias cleanup after a lost delete response", async () => {
    const { instance, objects, metadata, customMetadata, storage, r2 } = setup({ unifiedEnabled: true });
    const prefix = "spaces/space/projects/project/workspace/";
    objects.set("tenants/tenant/provider-connections/shared", new TextEncoder().encode("shared connection"));
    const mainFile = `${prefix}docs/main.md`;
    objects.set(mainFile, new TextEncoder().encode("main"));
    metadata.set(mainFile, { contentType: "text/markdown; charset=utf-8" });
    const deleted = `${prefix}branches/workers/worker-a/docs/main.md`;
    objects.set(deleted, new Uint8Array());
    customMetadata.set(deleted, { deleted: "true" });
    const branchFile = `${prefix}branches/workers/worker-a/bin/agent.sh`;
    objects.set(branchFile, new TextEncoder().encode("agent"));
    metadata.set(branchFile, { contentType: "text/x-shellscript" });
    customMetadata.set(branchFile, { executable: "true" });
    expect((await call(instance, "/v1/migration/import", { scope, migrationId: "migration-cutover-branch", branchNames: ["workers/worker-a"] })).status).toBe(201);
    const cutover = await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-cutover-branch", rollbackWindowMs: 60 * 60_000 });
    expect(cutover.status).toBe(200);
    const body = await cutover.json() as { receipt: {
      mismatchCount: number; readErrorCount: number; omittedPathCount: number; truncatedPages: number;
      branches: Record<string, { legacy: InventorySummaryRecord; manifest: InventorySummaryRecord }>;
    } };
    expect(body.receipt).toMatchObject({ mismatchCount: 0, readErrorCount: 0, omittedPathCount: 0, truncatedPages: 0 });
    const verifyDimensions = (summary: InventorySummaryRecord) => {
      expect(summary).toMatchObject({
        inventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        pathHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        mimeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        executableHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        tombstoneHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    };
    const mainReceipt = body.receipt.branches.main!;
    const branchReceipt = body.receipt.branches["workers/worker-a"]!;
    for (const summary of [mainReceipt.legacy, mainReceipt.manifest, branchReceipt.legacy, branchReceipt.manifest]) verifyDimensions(summary);
    for (const key of ["inventoryHash", "pathHash", "contentHash", "sizeHash", "mimeHash", "executableHash", "fileCount", "totalBytes"] as const) {
      expect(mainReceipt.legacy[key]).toBe(mainReceipt.manifest[key]);
      expect(branchReceipt.legacy[key]).toBe(branchReceipt.manifest[key]);
    }
    expect(mainReceipt.legacy).toMatchObject({ fileCount: 1, totalBytes: 4, tombstoneCount: 0 });
    expect(branchReceipt.legacy).toMatchObject({ fileCount: 1, totalBytes: 5, tombstoneCount: 1 });
    expect(branchReceipt.legacy.tombstoneHash).toMatch(/^[a-f0-9]{64}$/);
    expect(branchReceipt.manifest.tombstoneCount).toBe(0);
    expect((await call(instance, "/v1/migration/retire-alias", { scope, migrationId: "migration-cutover-branch" })).status).toBe(423);
    const expired = new Date(Date.now() - 1000).toISOString();
    await storage.put("workspace_read_policy", { ...await storage.get("workspace_read_policy") as object, rollbackExpiresAt: expired });
    await storage.put("legacy_rollback_alias", { ...await storage.get("legacy_rollback_alias") as object, rollbackExpiresAt: expired });
    const originalDelete = r2.delete;
    let loseFirstResponse = true;
    r2.delete = async (...args: never[]) => {
      await originalDelete(...args);
      if (loseFirstResponse) { loseFirstResponse = false; throw new Error("simulated lost R2 delete response"); }
      return undefined;
    };
    const failed = await call(instance, "/v1/migration/retire-alias", { scope, migrationId: "migration-cutover-branch" });
    expect(failed.status).toBe(503);
    const retired = await call(instance, "/v1/migration/retire-alias", { scope, migrationId: "migration-cutover-branch" });
    expect(retired.status).toBe(200);
    expect(await storage.get("legacy_rollback_alias")).toBeUndefined();
    expect(objects.has(`${prefix}docs/main.md`)).toBe(false);
    expect(objects.has("tenants/tenant/provider-connections/shared")).toBe(true);
    expect(await storage.get("workspace_read_policy")).toMatchObject({ mode: "coordinator", rollbackExpiresAt: expired });
    expect(await (await call(instance, "/v1/migration/retire-alias", { scope, migrationId: "migration-cutover-branch" })).json()).toMatchObject({ replay: true, cleanup: { migrationId: "migration-cutover-branch" } });
  });

  it("serves bounded file history and retained manifest revisions for checked restore", async () => {
    const { instance, objects } = setup();
    const original = new TextEncoder().encode("first version");
    const originalHash = await sha256Hex(original);
    const originalKey = `workspace-v1/tenant/space/project/global/content/${originalHash}`;
    objects.set(originalKey, original);
    const initialized = await call(instance, "/v1/initialize", { scope, branch: "main", entries: [
      { path: "docs/history.txt", sha256: originalHash, size: original.byteLength, executable: false, objectKey: originalKey, contentType: "text/plain; charset=utf-8" },
    ] });
    expect(initialized.status).toBe(200);
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string; fence: number } };
    const latest = new TextEncoder().encode("second version");
    const updated = await call(instance, "/v1/checkpoint", {
      sessionId: opened.session.id, runtimeId: "runtime", allocationGeneration: 1, fence: opened.session.fence,
      baseRevision: 1, idempotencyKey: "history-update", changes: [{ path: "docs/history.txt", expectedHash: originalHash,
        contentBase64: btoa(String.fromCharCode(...latest)), contentType: "text/plain; charset=utf-8" }],
    });
    expect(updated.status).toBe(200);
    const history = await call(instance, "/v1/history?branch=main&path=docs%2Fhistory.txt&limit=100");
    expect(await history.json()).toMatchObject({ headRevision: 2, cursor: 2, hasMore: false, versions: [
      { revision: 1, sha256: originalHash, size: original.byteLength, deleted: false },
      { revision: 2, sha256: await sha256Hex(latest), size: latest.byteLength, deleted: false },
    ] });
    const historical = await call(instance, "/v1/read?branch=main&revision=1&path=docs%2Fhistory.txt");
    expect(await historical.json()).toMatchObject({ head: { revision: 1 }, entries: [{ path: "docs/history.txt", sha256: originalHash, contentType: "text/plain; charset=utf-8" }] });
  });

  it("refuses to migrate a scope that conflicts with the coordinator identity", async () => {
    const { instance, storage } = setup();
    const initialized = await call(instance, "/v1/initialize", { scope: { ...scope, projectId: "another-project" }, branch: "main", entries: [] });
    expect(initialized.status).toBe(200);
    const migrated = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-scope-conflict" });
    expect(migrated.status).toBe(403);
    expect(await storage.get("project_migration")).toBeUndefined();
  });

  it("holds the migration barrier after a source verification failure", async () => {
    const { instance, objects, storage } = setup();
    objects.set("spaces/space/projects/project/workspace/../escape", new TextEncoder().encode("bad"));
    const migrated = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-bad-source" });
    expect(migrated.status).toBe(503);
    expect(await migrated.json()).toMatchObject({ migration: { status: "failed" } });
    expect((await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).status).toBe(423);
    expect(await (await call(instance, "/v1/migration/status")).json()).toMatchObject({ migration: { status: "failed" }, rollbackAlias: { verificationStatus: "pending" } });
    objects.delete("spaces/space/projects/project/workspace/../escape");
    objects.set("spaces/space/projects/project/workspace/docs/repaired.md", new TextEncoder().encode("repaired source"));
    const retry = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-bad-source" });
    expect(retry.status).toBe(201);
    expect(await storage.get("project_migration")).toMatchObject({ status: "verified", revision: 1 });
    expect(await storage.get("legacy_rollback_alias")).toMatchObject({ verificationStatus: "verified", revision: 1 });
  });

  it("requires an explicit legacy branch inventory and imports checked branch overlays with tombstones", async () => {
    const { instance, objects, storage, customMetadata } = setup();
    objects.set("spaces/space/projects/project/workspace/docs/main.md", new TextEncoder().encode("main"));
    objects.set("spaces/space/projects/project/workspace/shared/inherited.md", new TextEncoder().encode("inherited"));
    objects.set("spaces/space/projects/project/workspace/branches/workers/worker-a/output.md", new TextEncoder().encode("worker"));
    const tombstone = "spaces/space/projects/project/workspace/branches/workers/worker-a/docs/main.md";
    objects.set(tombstone, new Uint8Array());
    customMetadata.set(tombstone, { deleted: "true", sha256: "deleted" });
    const response = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-with-branches" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "workspace_migration_branch_inventory_required", migration: { status: "failed", errorCode: "workspace_migration_branch_inventory_required" } });
    expect(await storage.get("head:main")).toBeUndefined();
    expect((await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).status).toBe(423);
    const retry = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-with-branches", branchNames: ["workers/worker-a"] });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ migration: { status: "verified", branchNames: ["workers/worker-a"] }, branchCount: 1 });
    const branch = await call(instance, "/v1/read?branch=workers%2Fworker-a");
    const branchBody = await branch.json() as { entries: Array<{ path: string }> };
    expect(branchBody.entries.map(entry => entry.path)).toEqual(["output.md", "shared/inherited.md"]);
    expect(await (await call(instance, "/v1/head?branch=workers%2Fworker-a")).json()).toMatchObject({ branchBase: { parentBranch: "main", revision: 1 } });
  });

  it("restores retained main and branch snapshots through checked publication and resumes after partial restore", async () => {
    const { instance, objects, customMetadata, r2 } = setup({ unifiedEnabled: true });
    const mainPath = "spaces/space/projects/project/workspace/docs/main.md";
    const overlayPath = "spaces/space/projects/project/workspace/branches/workers/worker-a/output.md";
    const tombstonePath = "spaces/space/projects/project/workspace/branches/workers/worker-a/docs/main.md";
    const mainBytes = new TextEncoder().encode("original main");
    const branchBytes = new TextEncoder().encode("original branch overlay");
    objects.set(mainPath, mainBytes);
    objects.set(overlayPath, branchBytes);
    objects.set(tombstonePath, new Uint8Array());
    customMetadata.set(tombstonePath, { deleted: "true", sha256: "deleted" });
    const migrated = await call(instance, "/v1/migration/import", { scope, migrationId: "migration-rollback-test", branchNames: ["workers/worker-a"] });
    expect(migrated.status).toBe(201);
    expect((await call(instance, "/v1/migration/cutover", { scope, migrationId: "migration-rollback-test", rollbackWindowMs: 60 * 60_000 })).status).toBe(200);
    const migratedBranch = await (await call(instance, "/v1/read?branch=workers%2Fworker-a")).json() as { entries: Array<{ path: string; objectKey: string }> };
    const branchContentKey = migratedBranch.entries.find(entry => entry.path === "output.md")!.objectKey;

    const updateBranch = async (branch: string, path: string, oldBytes: Uint8Array, nextBytes: Uint8Array, key: string) => {
      const oldHash = await sha256Hex(oldBytes);
      const { session } = await (await call(instance, "/v1/open", { scope, branch, actorId: "test-user", runtimeId: `runtime-${key}`, allocationGeneration: 1 })).json() as { session: { id: string; fence: number } };
      const publication = await call(instance, "/v1/checkpoint", { sessionId: session.id, runtimeId: `runtime-${key}`, allocationGeneration: 1,
        fence: session.fence, baseRevision: (await (await call(instance, `/v1/head?branch=${encodeURIComponent(branch)}`)).json() as { head: { revision: number } }).head.revision,
        idempotencyKey: key, changes: [{ path, expectedHash: oldHash, contentBase64: btoa(String.fromCharCode(...nextBytes)) }] });
      expect(publication.status).toBe(200);
    };
    await updateBranch("main", "docs/main.md", mainBytes, new TextEncoder().encode("changed main"), "edit-main-before-rollback");
    await updateBranch("workers/worker-a", "output.md", branchBytes, new TextEncoder().encode("changed branch"), "edit-branch-before-rollback");

    const before = await (await call(instance, "/v1/migration/status")).json() as { currentHeads: Record<string, { revision: number; manifestHash: string }> };
    const originalGet = r2.get;
    r2.get = async (...args: never[]) => String(args[0]) === branchContentKey ? null : await originalGet(...args) as never;
    const interrupted = await call(instance, "/v1/migration/restore", { scope, confirm: true, restoreId: "rollback-test-1", expectedHeads: before.currentHeads });
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ error_code: "workspace_migration_restore_retry_required", restore: { status: "restoring", completedBranches: ["main"] } });
    expect((await call(instance, "/v1/read?branch=main")).status).toBe(423);

    r2.get = originalGet;
    const resumed = await call(instance, "/v1/migration/restore", { scope, confirm: true, restoreId: "rollback-test-1" });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ restore: { status: "verified", completedBranches: ["main", "workers/worker-a"] } });
    expect(await (await call(instance, "/v1/migration/status")).json()).toMatchObject({ migration: { status: "verified" }, restore: { status: "verified" } });
    const mainAfter = await (await call(instance, "/v1/read?branch=main")).json() as { entries: Array<{ path: string; sha256: string }> };
    expect(mainAfter.entries).toMatchObject([{ path: "docs/main.md", sha256: await sha256Hex(mainBytes) }]);
    expect(mainAfter.entries).toHaveLength(1);
    const branchAfter = await (await call(instance, "/v1/read?branch=workers%2Fworker-a")).json() as { entries: Array<{ path: string; sha256: string }> };
    expect(branchAfter.entries.map(entry => entry.path)).toEqual(["output.md"]);
    expect(branchAfter.entries[0]!.sha256).toBe(await sha256Hex(branchBytes));
  });

  it("schedules bounded maintenance and records retryable failures", async () => {
    const { instance, storage, r2 } = setup();
    const initialized = await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    expect(initialized.status).toBe(200);
    expect(storage.alarmAt).not.toBeNull();

    const originalList = r2.list;
    r2.list = async (..._args: never[]) => { throw new Error("simulated R2 list failure"); };
    await instance.alarm();
    expect(await storage.get("workspace_gc_status")).toMatchObject({ status: "failed", failures: 1, error: expect.stringContaining("content:") });
    expect(await (await call(instance, "/v1/gc/status")).json()).toMatchObject({ status: "failed", failures: 1 });
    expect(storage.alarmAt).toBeGreaterThan(Date.now());

    r2.list = originalList;
    for (let attempts = 0; attempts < 15 && (await storage.get<{ status: string }>("workspace_gc_status"))?.status !== "complete"; attempts++) await instance.alarm();
    expect(await storage.get("workspace_gc_status")).toMatchObject({ status: "complete", failures: 0 });
    expect(storage.values.has("content_gc_backfill_complete")).toBe(true);
  });

  it("fails closed and retries when an R2 continuation cursor stops advancing", async () => {
    const { instance, storage, r2: bucket } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const r2 = bucket as unknown as R2Bucket;
    const originalList = r2.list.bind(r2);
    const stuckCursor = `opaque:${btoa("stalled-manifest-key")}`;
    vi.spyOn(r2, "list").mockImplementation(async (options) => {
      const page = await originalList(options);
      if (options.prefix?.includes("/manifests/")) return { ...page, truncated: true, cursor: stuckCursor };
      return page;
    });
    expect((await call(instance, "/v1/gc/content", {})).status).toBe(200);
    await instance.alarm();
    expect(await storage.get("workspace_gc_status")).toMatchObject({ status: "failed", error: expect.stringContaining("cursor_stalled") });
    expect(storage.alarmAt).toBeGreaterThan(Date.now());
    expect(storage.values.has("content_gc")).toBe(false);
  });

  it("defaults sessions to checked handoff and publishes a complete revision with an idempotent receipt", async () => {
    const { instance, objects } = setup();
    const first = new TextEncoder().encode("one");
    const firstHash = "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed";
    const contentKey = `workspace-v1/tenant/space/project/global/content/${firstHash}`;
    objects.set(contentKey, first);
    const initialized = await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "src/a.txt", sha256: firstHash, size: 3, executable: false, objectKey: contentKey }] });
    expect(initialized.status).toBe(200);
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 });
    const { session } = await opened.json() as { session: { id: string; mode: string; fence: number } };
    expect(session.mode).toBe("checked_handoff");
    const changes = [{ path: "src/a.txt", expectedHash: firstHash, contentBase64: btoa("two") }];
    const checkpoint = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "checkpoint-1", changes });
    expect(checkpoint.status).toBe(200);
    const checkpointBody = await checkpoint.json() as { publication: { revision: number; status: string } };
    const receipt = checkpointBody;
    expect(receipt.publication).toMatchObject({ revision: 2, status: "published" });
    const replay = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "checkpoint-1", changes });
    expect(await replay.json()).toEqual(checkpointBody);
    const changedReplay = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "checkpoint-1", changes: [{ path: "src/a.txt", expectedHash: firstHash, contentBase64: btoa("different") }] });
    expect(await changedReplay.json()).toMatchObject({ error_code: "idempotency_conflict" });
    const read = await call(instance, "/v1/read?branch=main");
    expect(await read.json()).toMatchObject({ head: { revision: 2 }, entries: [{ path: "src/a.txt", size: 3 }] });
    const revisionChanges = await call(instance, "/v1/changes?branch=main&afterRevision=1");
    expect(await revisionChanges.json()).toMatchObject({ cursor: 2, resetRequired: false, revisions: [{ revision: 2, changedPaths: ["src/a.txt"] }] });
    expect(await (await call(instance, "/v1/subscriptions/ack", { branch: "main", subscriberId: "project-ui", revision: 2 })).json()).toMatchObject({ revision: 2 });
    expect(await (await call(instance, "/v1/subscriptions/ack", { branch: "main", subscriberId: "project-ui", revision: 1 })).json()).toMatchObject({ revision: 2 });
    expect((await call(instance, "/v1/changes?branch=main&afterRevision=3")).status).toBe(409);
  });

  it("preserves canonical MIME when a VFS write updates a file and defaults unknown new files safely", async () => {
    const { instance, objects } = setup();
    const initialBytes = new TextEncoder().encode("id,name\n1,Naelao");
    const initialHash = await sha256Hex(initialBytes);
    const initialKey = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/${initialHash}`;
    objects.set(initialKey, initialBytes);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "data.csv", sha256: initialHash, size: initialBytes.length,
      executable: false, objectKey: initialKey, contentType: "text/csv; charset=utf-8" }] });
    const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string } };
    const updated = btoa("id,name\n2,Naelao");
    const publication = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1,
      idempotencyKey: "mime-vfs-write", changes: [
        { path: "data.csv", expectedHash: initialHash, contentBase64: updated },
        { path: "opaque.bin", expectedHash: null, contentBase64: btoa("bytes") },
      ] });
    expect(publication.status).toBe(200);
    expect(await (await call(instance, "/v1/read?branch=main")).json()).toMatchObject({ entries: [
      { path: "data.csv", contentType: "text/csv; charset=utf-8" },
      { path: "opaque.bin", contentType: "application/octet-stream" },
    ] });
  });

  it("supports validated prefix-filtered manifest reads for bounded scoped clients", async () => {
    const { instance, objects } = setup();
    const files = ["uploads/session-a/brief.txt", "uploads/session-b/other.txt", "docs/readme.md"];
    const entries = await Promise.all(files.map(async (path) => {
      const bytes = new TextEncoder().encode(path);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const objectKey = `workspace-v1/tenant/space/project/global/content/${sha256}`;
      objects.set(objectKey, bytes);
      return { path, sha256, size: bytes.byteLength, executable: false, objectKey };
    }));
    await call(instance, "/v1/initialize", { scope, branch: "main", entries });
    const selected = await call(instance, "/v1/read?branch=main&prefix=uploads%2Fsession-a");
    expect(await selected.json()).toMatchObject({ entries: [{ path: "uploads/session-a/brief.txt" }] });
    expect((await call(instance, "/v1/read?branch=main&prefix=../outside")).status).toBe(400);
  });

  it("serves a generation-fenced immutable session snapshot and verified file bytes", async () => {
    const { instance, objects } = setup();
    const bytes = new TextEncoder().encode("snapshot bytes");
    const hash = "" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const objectKey = `workspace-v1/tenant/space/project/global/content/${hash}`;
    objects.set(objectKey, bytes);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "src/file.txt", sha256: hash, size: bytes.byteLength, executable: false, objectKey }] });
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 9 });
    const { session } = await opened.json() as { session: { id: string; fence: number } };
    const query = `sessionId=${session.id}&runtimeId=runtime&allocationGeneration=9&fence=${session.fence}`;
    expect(await (await call(instance, `/v1/session-snapshot?${query}`)).json()).toMatchObject({ session: { baseRevision: 1, allocationGeneration: 9 }, entries: [{ path: "src/file.txt", sha256: hash }] });
    const content = await call(instance, `/v1/session-content?${query}&path=src%2Ffile.txt`);
    expect(content.status).toBe(200);
    expect(content.headers.get("x-content-sha256")).toBe(hash);
    expect(new TextDecoder().decode(await content.arrayBuffer())).toBe("snapshot bytes");
    expect((await call(instance, `/v1/session-snapshot?sessionId=${session.id}&runtimeId=some-other-computer&allocationGeneration=9&fence=${session.fence}`)).status).toBe(403);
    expect((await call(instance, `/v1/session-content?sessionId=${session.id}&runtimeId=runtime&allocationGeneration=8&fence=${session.fence}&path=src%2Ffile.txt`)).status).toBe(409);
    expect((await call(instance, `/v1/session-content?${query}&path=../outside`)).status).toBe(400);
  });

  it("preserves all files and the current head when one expected hash conflicts", async () => {
    const { instance, objects } = setup();
    const bytes = new TextEncoder().encode("base");
    const hash = "cae662172fd450bb0cd710a769079c05bfc5d8e35efa6576edc7d0377afdd4a2";
    const key = `workspace-v1/tenant/space/project/global/content/${hash}`;
    objects.set(key, bytes);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "a.txt", sha256: hash, size: 4, executable: false, objectKey: key }] });
    const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string } };
    const response = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "conflicted-checkpoint", changes: [
      { path: "a.txt", expectedHash: null, contentBase64: btoa("new") },
      { path: "b.txt", expectedHash: null, contentBase64: btoa("new") },
    ] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ publication: { status: "conflicted", appliedPaths: [], conflicts: [{ path: "a.txt", actualHash: hash }] } });
    expect(await (await call(instance, "/v1/head?branch=main")).json()).toMatchObject({ head: { revision: 1 } });
  });

  it("persists staged bytes outside DO metadata and publishes them by stage receipt", async () => {
    const { instance, restart, objects } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 3 })).json() as { session: { id: string; fence: number } };
    const changes = [{ path: "src/staged.bin", expectedHash: null, contentBase64: btoa("recoverable bytes") }];
    const stage = await call(instance, "/v1/stage", { sessionId: session.id, stageId: "stage-1", allocationGeneration: 3, fence: 0, changes });
    expect(stage.status).toBe(200);
    const stageResult = await stage.json() as { status: string; changeSetHash: string };
    expect(stageResult.status).toBe("staged");
    expect(await (await call(instance, "/v1/stage", { sessionId: session.id, stageId: "stage-1", allocationGeneration: 3, fence: 0, changes })).json()).toMatchObject({ stageId: "stage-1", status: "staged", changeSetHash: stageResult.changeSetHash });
    expect([...objects.keys()].some(key => key.includes("/staging/") && key.includes(session.id))).toBe(true);
    expect((await call(instance, "/v1/stage", { sessionId: session.id, stageId: "stage-1", allocationGeneration: 3, fence: 0, changes: [{ ...changes[0], contentBase64: btoa("changed bytes") }] })).status).toBe(409);
    const recoveredCoordinator = restart();
    const published = await call(recoveredCoordinator, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 3, fence: 0, baseRevision: 1, idempotencyKey: "stage-checkpoint", stageId: "stage-1" });
    expect(await published.json()).toMatchObject({ publication: { status: "published", revision: 2, appliedPaths: ["src/staged.bin"] } });
    const read = await call(recoveredCoordinator, "/v1/read?branch=main");
    expect(await read.json()).toMatchObject({ head: { revision: 2 }, entries: [{ path: "src/staged.bin" }] });
  });

  it("preserves canonical MIME metadata and accepts files above the old session upload cap", async () => {
    const { instance, metadata } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string; fence: number } };
    const bytes = new Uint8Array(1024 * 1024).fill(0x61);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const staged = await call(instance, "/v1/stage", { sessionId: session.id, stageId: "mime-large-stage", allocationGeneration: 1, fence: session.fence,
      changes: [{ path: "uploads/large.bin", expectedHash: null, contentBase64: btoa(binary), contentType: "application/octet-stream" }] });
    expect(staged.status).toBe(200);
    const checkpoint = await call(instance, "/v1/checkpoint", { sessionId: session.id, runtimeId: "runtime", allocationGeneration: 1, fence: session.fence,
      baseRevision: 1, idempotencyKey: "mime-large-checkpoint", stageId: "mime-large-stage" });
    expect(checkpoint.status).toBe(200);
    const manifest = await call(instance, "/v1/read?branch=main");
    const manifestResult = await manifest.json() as { head: { revision: number }; entries: Array<{ path: string; objectKey: string; size: number; contentType?: string }> };
    expect(manifestResult).toMatchObject({ entries: [{ path: "uploads/large.bin", size: 1024 * 1024, contentType: "application/octet-stream" }] });
    expect((await call(instance, `/v1/head?branch=main`)).status).toBe(200);
    expect(metadata.get(manifestResult.entries[0]!.objectKey)).toEqual({ contentType: "application/octet-stream" });
  });

  it("collects only aged consumed staging objects and retains canonical content", async () => {
    const { instance, objects } = setup();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
      const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string } };
      await call(instance, "/v1/stage", { sessionId: session.id, stageId: "gc-stage", allocationGeneration: 1, fence: 0, changes: [{ path: "gc.txt", expectedHash: null, contentBase64: btoa("kept canonical") }] });
      await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "gc-checkpoint", stageId: "gc-stage" });
      await call(instance, "/v1/stage", { sessionId: session.id, stageId: "gc-empty-stage", allocationGeneration: 1, fence: 0, changes: [] });
      await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 2, idempotencyKey: "gc-empty-checkpoint", stageId: "gc-empty-stage" });
      vi.spyOn(Date, "now").mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
      const collected = await call(instance, "/v1/gc/staging", {});
      expect(await collected.json()).toMatchObject({ deleted: 1, recordsDeleted: 1, hasMore: false });
      expect([...objects.keys()].some(key => key.includes("/staging/"))).toBe(false);
      expect([...objects.keys()].some(key => key.includes("/content/"))).toBe(true);
    } finally { vi.restoreAllMocks(); }
  });

  it("expires publication receipts and inactive subscriber cursors by bounded metadata indexes", async () => {
    const { instance, storage } = setup();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
      const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string } };
      await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "expires-receipt", changes: [{ path: "expires.txt", expectedHash: null, contentBase64: btoa("x") }] });
      await call(instance, "/v1/subscriptions/ack", { branch: "main", subscriberId: "offline-reader", revision: 2 });
      expect(await storage.get("receipt:main:expires-receipt")).toBeDefined();
      expect(await storage.get("subscription:main:offline-reader")).toBeDefined();
      vi.spyOn(Date, "now").mockReturnValue(now + 31 * 24 * 60 * 60 * 1000);
      const collected = await call(instance, "/v1/gc/metadata", {});
      expect(await collected.json()).toMatchObject({ deleted: 2, hasMore: false });
      expect(await storage.get("receipt:main:expires-receipt")).toBeUndefined();
      expect(await storage.get("subscription:main:offline-reader")).toBeUndefined();
    } finally { vi.restoreAllMocks(); }
  });

  it("bounds revision polling events and asks readers with expired cursors to reset", async () => {
    const { instance, storage } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 })).json() as { session: { id: string } };
    let expectedHash: string | null = null;
    for (let index = 1; index <= 500; index++) {
      const bytes = new TextEncoder().encode(`revision-${index}`);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const nextHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      const response = await call(instance, "/v1/checkpoint", {
        sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: index,
        idempotencyKey: `event-retention-${index}`,
        changes: [{ path: "revision.txt", expectedHash, contentBase64: btoa(`revision-${index}`) }],
      });
      expect(response.status, `revision ${index}`).toBe(200);
      expectedHash = nextHash;
    }
    expect((await storage.list({ prefix: "revision:main:" })).size).toBe(500);
    expect(await (await call(instance, "/v1/changes?branch=main&afterRevision=0")).json()).toMatchObject({ head: { revision: 501 }, resetRequired: true, cursor: 0 });
  });

  it("marks all retained manifests before sweeping orphan content and blocks writes during collection", async () => {
    const { instance, objects, storage } = setup();
    const liveBytes = new TextEncoder().encode("live");
    const liveHash = "247610f4dedd4ab7247d07dbda19c81ca9817f85820742cad49d407ffae9e4ed";
    const liveKey = `workspace-v1/tenant/space/project/global/content/${liveHash}`;
    objects.set(liveKey, liveBytes);
    const orphanBytes = new TextEncoder().encode("orphan");
    const orphanHash = "88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7";
    const orphanKey = `workspace-v1/tenant/space/project/global/content/${orphanHash}`;
    objects.set(orphanKey, orphanBytes);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "live.txt", sha256: liveHash, size: liveBytes.length, executable: false, objectKey: liveKey }] });
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 });
    const { session } = await opened.json() as { session: { id: string } };
    await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "gc-history-checkpoint", changes: [{ path: "live.txt", expectedHash: liveHash, contentBase64: btoa("current") }] });
    const currentKey = "workspace-v1/tenant/space/project/global/content/97b0560280ed60a5a1eaa1bc45492543c8a986ad5a25b468c427eb83c3e88191";

    const started = await call(instance, "/v1/gc/content", {});
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ phase: "backfill", hasMore: true });
    expect(storage.alarmAt).not.toBeNull();
    const blocked = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 2, idempotencyKey: "blocked-during-gc", changes: [{ path: "write.txt", expectedHash: null, contentBase64: btoa("x") }] });
    expect(blocked.status).toBe(423);
    expect(await blocked.json()).toMatchObject({ error_code: "workspace_gc_in_progress" });
    for (let attempts = 0; attempts < 15 && storage.values.has("content_gc"); attempts++) await instance.alarm();
    expect(storage.values.has("content_gc")).toBe(false);
    expect(objects.has(liveKey)).toBe(true);
    expect(objects.has(currentKey)).toBe(true);
    expect(objects.has(orphanKey)).toBe(false);
    expect([...objects.keys()].some(key => key.includes("/gc/marks/"))).toBe(false);
  });

  it("deletes manifests and content not reachable from revision roots after the legacy backfill", async () => {
    const { instance, objects, storage } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    await storage.put("content_gc_backfill_complete", true);
    const orphanBytes = new TextEncoder().encode("unreachable");
    const orphanHash = "5e6017027437e595ec72adee0718d78f092cddaa8d31048c9d5ba2ed647ded5e";
    const orphanContentKey = `workspace-v1/tenant/space/project/global/content/${orphanHash}`;
    const orphanEntry = { path: "unreachable.txt", sha256: orphanHash, size: orphanBytes.length, executable: false, objectKey: orphanContentKey };
    const orphanManifest = JSON.stringify([orphanEntry]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(orphanManifest));
    const manifestHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    const orphanManifestKey = `workspace-v1/tenant/space/project/global/manifests/${manifestHash}.json`;
    objects.set(orphanContentKey, orphanBytes);
    objects.set(orphanManifestKey, new TextEncoder().encode(orphanManifest));

    const started = await call(instance, "/v1/gc/content", {});
    expect(started.status).toBe(200);
    for (let attempts = 0; attempts < 15 && storage.values.has("content_gc"); attempts++) await instance.alarm();
    expect(storage.values.has("content_gc")).toBe(false);
    expect(objects.has(orphanManifestKey)).toBe(false);
    expect(objects.has(orphanContentKey)).toBe(false);
    expect([...objects.keys()].some(key => key.includes("/manifests/"))).toBe(true);
  });

  it("keeps an uploaded object marked until the head transaction commits after GC", async () => {
    const { instance, objects, storage, r2: bucket } = setup();
    const r2 = bucket as unknown as R2Bucket;
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    await storage.put("content_gc_backfill_complete", true);
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 });
    const { session } = await opened.json() as { session: { id: string } };
    const content = new TextEncoder().encode("content uploaded during GC");
    const digest = await crypto.subtle.digest("SHA-256", content);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const contentKey = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/${hash}`;
    let signalUploadStored!: () => void;
    let releaseUpload!: () => void;
    const uploadStored = new Promise<void>((resolve) => { signalUploadStored = resolve; });
    const uploadRelease = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const originalPut = r2.put.bind(r2);
    vi.spyOn(r2, "put").mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      if (args[0] === contentKey) {
        signalUploadStored();
        await uploadRelease;
      }
      return result;
    });
    const checkpoint = call(instance, "/v1/checkpoint", {
      sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "gc-upload-race",
      changes: [{ path: "during-gc.txt", expectedHash: null, contentBase64: btoa("content uploaded during GC") }],
    });
    await uploadStored;
    expect(await (await call(instance, "/v1/gc/content", {})).status).toBe(200);
    for (let attempts = 0; attempts < 20 && storage.values.has("content_gc"); attempts++) await instance.alarm();
    expect(storage.values.has("content_gc")).toBe(false);
    expect(objects.has(contentKey)).toBe(true);
    releaseUpload();
    expect((await checkpoint).status).toBe(200);
    const read = await (await call(instance, "/v1/read?branch=main")).json() as { entries: WorkspaceEntry[] };
    expect(read.entries).toMatchObject([{ path: "during-gc.txt", sha256: hash, objectKey: contentKey }]);
    expect((await storage.list({ prefix: "upload-intent:" })).size).toBe(0);
  });

  it("retains a PUT that committed remotely after the client received a timeout", async () => {
    const { instance, objects, storage, r2: bucket } = setup();
    const r2 = bucket as unknown as R2Bucket;
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    await storage.put("content_gc_backfill_complete", true);
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 });
    const { session } = await opened.json() as { session: { id: string } };
    const content = new TextEncoder().encode("remote commit after timeout");
    const digest = await crypto.subtle.digest("SHA-256", content);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const contentKey = `workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}/content/${hash}`;
    let responseWasLost = false;
    const originalPut = r2.put.bind(r2);
    vi.spyOn(r2, "put").mockImplementation(async (...args) => {
      const result = await originalPut(...args);
      if (args[0] === contentKey && !responseWasLost) {
        responseWasLost = true;
        throw new Error("simulated timeout after remote commit");
      }
      return result;
    });
    const request = {
      sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "lost-put-response",
      changes: [{ path: "late-commit.txt", expectedHash: null, contentBase64: btoa("remote commit after timeout") }],
    };
    await expect(call(instance, "/v1/checkpoint", request)).rejects.toThrow("simulated timeout after remote commit");
    expect(objects.has(contentKey)).toBe(true);
    expect((await storage.list({ prefix: "upload-intent:" })).size).toBe(1);

    expect((await call(instance, "/v1/gc/content", {})).status).toBe(200);
    for (let attempts = 0; attempts < 20 && storage.values.has("content_gc"); attempts++) await instance.alarm();
    expect(storage.values.has("content_gc")).toBe(false);
    expect(objects.has(contentKey)).toBe(true);

    expect((await call(instance, "/v1/checkpoint", request)).status).toBe(200);
    const read = await (await call(instance, "/v1/read?branch=main")).json() as { entries: WorkspaceEntry[] };
    expect(read.entries).toMatchObject([{ path: "late-commit.txt", sha256: hash, objectKey: contentKey }]);
  });

  it("erases one workspace scope and leaves a tombstone that rejects later reads and writes", async () => {
    const { instance, objects, storage } = setup();
    const content = new TextEncoder().encode("private");
    const hash = "715dc8493c36579a5b116995100f635e3572fdf8703e708ef1a08d943b36774e";
    const key = `workspace-v1/tenant/space/project/global/content/${hash}`;
    objects.set(key, content);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "private.txt", sha256: hash, size: content.length, executable: false, objectKey: key }] });
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "reader", runtimeId: "reader-runtime", allocationGeneration: 1 });
    const { session } = await opened.json() as { session: { id: string } };
    expect(storage.values.has(`session:${session.id}`)).toBe(true);
    await call(instance, "/v1/subscriptions/ack", { branch: "main", subscriberId: "reader-subscription", revision: 1 });
    expect(storage.values.has("subscription:main:reader-subscription")).toBe(true);
    const erased = await call(instance, "/v1/erase", { scope, confirm: true });
    expect(await erased.json()).toMatchObject({ erased: true, scope, objectsDeleted: 2 });
    expect(objects.size).toBe(0);
    expect([...storage.values.keys()]).toEqual(["erased"]); // sessions, subscriptions, aliases, and staging metadata are revoked
    await instance.alarm();
    expect(storage.alarmAt).toBeNull();
    expect((await call(instance, "/v1/head?branch=main")).status).toBe(410);
    expect(await (await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] })).json()).toMatchObject({ error_code: "workspace_erased" });
  });

  it("removes a content PUT that finishes after the erasure sweep", async () => {
    const { instance, objects, r2: bucket } = setup();
    const r2 = bucket as unknown as R2Bucket;
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 });
    const { session } = await opened.json() as { session: { id: string } };
    let signalUploadEntered!: () => void;
    let releaseUpload!: () => void;
    const uploadEntered = new Promise<void>((resolve) => { signalUploadEntered = resolve; });
    const uploadRelease = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const originalPut = r2.put.bind(r2);
    vi.spyOn(r2, "put").mockImplementation(async (...args) => {
      if (args[0].includes("/content/")) {
        signalUploadEntered();
        await uploadRelease;
      }
      return originalPut(...args);
    });
    const checkpoint = call(instance, "/v1/checkpoint", {
      sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "erase-upload-race",
      changes: [{ path: "late.txt", expectedHash: null, contentBase64: btoa("late upload") }],
    });
    await uploadEntered;
    expect((await call(instance, "/v1/erase", { scope, confirm: true })).status).toBe(200);
    releaseUpload();
    expect((await checkpoint).status).toBe(410);
    expect([...objects.keys()].some((key) => key.startsWith(`workspace-v1/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/`))).toBe(false);
  });

  it("rejects stale allocation generations, unsafe paths, and a second live writer", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const open = () => call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 7, mode: "live_single_writer", capabilityEvidence: {
      ...liveEvidence(7),
    } });
    const { session } = await (await open()).json() as { session: { id: string; fence: number } };
    expect((await open()).status).toBe(409);
    const stale = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 6, fence: session.fence, baseRevision: 1, idempotencyKey: "stale", changes: [] });
    expect(await stale.json()).toMatchObject({ error_code: "allocation_generation_mismatch" });
    const unsafe = await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 7, fence: session.fence, baseRevision: 1, idempotencyKey: "unsafe", changes: [{ path: "../secret", expectedHash: null, contentBase64: btoa("x") }] });
    expect(await unsafe.json()).toMatchObject({ error_code: "invalid_checkpoint" });
  });

  it("returns a capability error instead of admitting live mode without verified runtime evidence", async () => {
    const { instance } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const response = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 1, mode: "live_single_writer" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "capability_unavailable" });
  });

  it("rejects live mode without the exact runtime, authorization, residency, transport, and accounting evidence and never downgrades", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const response = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 2,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(2, { fuseReady: false, billingReserved: false, authorizationEpoch: undefined }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "capability_unavailable", mode: "live_single_writer", missing: expect.arrayContaining(["fuseReady", "billingReserved", "authorizationEpoch"]) });
    expect(await (await call(instance, "/v1/head?branch=main")).json()).toMatchObject({ head: { revision: 1 } });
  });

  it("requires authority-backed runtime capability verification even when the caller supplies a complete claim", async () => {
    const { instance } = setup({ liveEnabled: true, liveVerifier: false });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const response = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 2,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(2) });
    expect(await response.json()).toMatchObject({ error_code: "capability_unavailable", missing: ["authorityBackedVerification"] });
  });

  it("admits exactly one writer when two live runtimes race", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const open = (runtimeId: string, generation: number) => call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId,
      allocationGeneration: generation, mode: "live_single_writer", capabilityEvidence: liveEvidence(generation, { runtimeId }) });
    const results = await Promise.all([open("runtime-race-a", 1), open("runtime-race-b", 2)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  it("uses the authority verifier's selected qualifying runtime instead of silently downgrading the requested runtime", async () => {
    const { instance } = setup({ liveEnabled: true, candidateSelection: { runtimeId: "runtime-qualified", allocationGeneration: 3 } });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-preferred", allocationGeneration: 1,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(1, { runtimeId: "runtime-preferred" }) });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ session: { mode: "live_single_writer", runtimeId: "runtime-qualified", allocationGeneration: 3 } });
  });

  it("creates an isolated branch head without changing the source branch", async () => {
    const { instance } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const created = await call(instance, "/v1/branch", { scope, sourceBranch: "main", branch: "runs/agent-a" });
    expect(await created.json()).toMatchObject({ branch: { branch: "runs/agent-a", revision: 1 }, created: true });
    expect(await (await call(instance, "/v1/head?branch=runs%2Fagent-a")).json()).toMatchObject({ branchBase: { parentBranch: "main", revision: 1 } });
    const session = await call(instance, "/v1/open", { scope, branch: "runs/agent-a", actorId: "user", runtimeId: "runtime", allocationGeneration: 1 });
    const opened = await session.json() as { session: { id: string } };
    const published = await call(instance, "/v1/checkpoint", { sessionId: opened.session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "branch-checkpoint", changes: [{ path: "agent.txt", expectedHash: null, contentBase64: btoa("branch only") }] });
    expect(published.status).toBe(200);
    expect(await (await call(instance, "/v1/head?branch=main")).json()).toMatchObject({ head: { revision: 1 } });
    expect(await (await call(instance, "/v1/head?branch=runs%2Fagent-a")).json()).toMatchObject({ head: { revision: 2 } });
    const parent = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-parent", allocationGeneration: 1 })).json() as { session: { id: string } };
    const parentWrite = await call(instance, "/v1/checkpoint", { sessionId: parent.session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "parent-checkpoint", changes: [{ path: "user.txt", expectedHash: null, contentBase64: btoa("parent only") }] });
    expect(parentWrite.status).toBe(200);
    const merge = await call(instance, "/v1/merge", { sessionId: opened.session.id, targetBranch: "main", allocationGeneration: 1, fence: 0, idempotencyKey: "merge-agent-a" });
    expect(await merge.json()).toMatchObject({ publication: { status: "published", revision: 3, appliedPaths: ["agent.txt"] } });
    const merged = await call(instance, "/v1/read?branch=main");
    expect(await merged.json()).toMatchObject({ head: { revision: 3 }, entries: [{ path: "agent.txt" }, { path: "user.txt" }] });
    const replay = await call(instance, "/v1/merge", { sessionId: opened.session.id, targetBranch: "main", allocationGeneration: 1, fence: 0, idempotencyKey: "merge-agent-a" });
    expect(await replay.json()).toMatchObject({ publication: { status: "published", revision: 3 } });
  });

  it("keeps a conflicting branch staged without partially merging it", async () => {
    const { instance, objects } = setup();
    const baseBytes = new TextEncoder().encode("base");
    const baseHash = "cae662172fd450bb0cd710a769079c05bfc5d8e35efa6576edc7d0377afdd4a2";
    const baseKey = `workspace-v1/tenant/space/project/global/content/${baseHash}`;
    objects.set(baseKey, baseBytes);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "same.txt", sha256: baseHash, size: baseBytes.length, executable: false, objectKey: baseKey }] });
    await call(instance, "/v1/branch", { scope, sourceBranch: "main", branch: "runs/conflict" });
    const child = await (await call(instance, "/v1/open", { scope, branch: "runs/conflict", actorId: "user", runtimeId: "runtime-child", allocationGeneration: 1 })).json() as { session: { id: string } };
    expect((await call(instance, "/v1/checkpoint", { sessionId: child.session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "child-conflict", changes: [{ path: "same.txt", expectedHash: baseHash, contentBase64: btoa("child") }] })).status).toBe(200);
    const parent = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-parent", allocationGeneration: 1 })).json() as { session: { id: string } };
    expect((await call(instance, "/v1/checkpoint", { sessionId: parent.session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "parent-conflict", changes: [{ path: "same.txt", expectedHash: baseHash, contentBase64: btoa("parent") }] })).status).toBe(200);
    const merge = await call(instance, "/v1/merge", { sessionId: child.session.id, targetBranch: "main", allocationGeneration: 1, fence: 0, idempotencyKey: "merge-conflict" });
    expect(merge.status).toBe(409);
    expect(await merge.json()).toMatchObject({ publication: { status: "conflicted", appliedPaths: [], conflicts: [{ path: "same.txt" }] } });
    expect(await (await call(instance, "/v1/head?branch=main")).json()).toMatchObject({ head: { revision: 2 } });
    expect(await (await call(instance, "/v1/head?branch=runs%2Fconflict")).json()).toMatchObject({ head: { revision: 2 } });
  });

  it("requires a committed revision for writer handoff and rejects stale writes after fencing", async () => {
    const noControl = setup({ liveEnabled: true });
    await call(noControl.instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const noControlSession = await (await call(noControl.instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(7, { runtimeId: "runtime-a" }) })).json() as { session: { id: string; fence: number } };
    const forgedReceipt = await call(noControl.instance, "/v1/handoff", { sessionId: noControlSession.session.id, targetRuntimeId: "runtime-b", allocationGeneration: 7,
      targetAllocationGeneration: 8, checkpointRevision: 1, drained: true,
      flushReceipt: { id: "caller-invented", status: "flushed", sessionId: noControlSession.session.id, runtimeId: "runtime-a", allocationGeneration: 7, fence: noControlSession.session.fence, revision: 1 },
      targetCapabilityEvidence: liveEvidence(8, { runtimeId: "runtime-b" }) });
    expect(await forgedReceipt.json()).toMatchObject({ error_code: "runtime_control_unavailable" });

    const { instance } = setup({ liveEnabled: true, runtimeControl: "ok" });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const evidence = liveEvidence(7, { runtimeId: "runtime-a" });
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7, mode: "live_single_writer", capabilityEvidence: evidence })).json() as { session: { id: string; fence: number } };
    const handoff = await call(instance, "/v1/handoff", { sessionId: opened.session.id, targetRuntimeId: "runtime-b", allocationGeneration: 7, targetAllocationGeneration: 8, checkpointRevision: 1,
      targetCapabilityEvidence: liveEvidence(8, { runtimeId: "runtime-b" }) });
    const next = await handoff.json() as { session: { id: string; fence: number; allocationGeneration: number } };
    expect(handoff.status, JSON.stringify(next)).toBe(200);
    expect(next.session).toMatchObject({ fence: opened.session.fence + 1, allocationGeneration: 8 });
    const stale = await call(instance, "/v1/checkpoint", { sessionId: opened.session.id, allocationGeneration: 7, fence: opened.session.fence, baseRevision: 1, idempotencyKey: "stale-after-handoff", changes: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error_code: "stale_fence" });
  });

  it("refuses handoff while recoverable staging has not been published", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(7, { runtimeId: "runtime-a" }) })).json() as { session: { id: string; fence: number } };
    await call(instance, "/v1/stage", { sessionId: opened.session.id, stageId: "handoff-pending", allocationGeneration: 7, fence: opened.session.fence,
      changes: [{ path: "recover-me.txt", expectedHash: null, contentBase64: btoa("staging remains recoverable") }] });
    const response = await call(instance, "/v1/handoff", { sessionId: opened.session.id, targetRuntimeId: "runtime-b", allocationGeneration: 7, targetAllocationGeneration: 8, checkpointRevision: 1,
      drained: true, flushReceipt: { id: "flush-pending", status: "flushed", sessionId: opened.session.id, runtimeId: "runtime-a", allocationGeneration: 7, fence: opened.session.fence, revision: 1 }, targetCapabilityEvidence: liveEvidence(8, { runtimeId: "runtime-b" }) });
    expect(await response.json()).toMatchObject({ error_code: "handoff_staging_unpublished" });
    expect((await call(instance, "/v1/checkpoint", { sessionId: opened.session.id, allocationGeneration: 7, fence: opened.session.fence, baseRevision: 1, idempotencyKey: "handoff-recovery", stageId: "handoff-pending" })).status).toBe(200);
  });

  it("keeps the old writer lease when runtime drain or real flush cannot be verified", async () => {
    const { instance } = setup({ liveEnabled: true, runtimeControl: "flush_failure" });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(7, { runtimeId: "runtime-a" }) })).json() as { session: { id: string; fence: number } };
    const handoff = await call(instance, "/v1/handoff", { sessionId: opened.session.id, targetRuntimeId: "runtime-b", allocationGeneration: 7,
      targetAllocationGeneration: 8, checkpointRevision: 1, targetCapabilityEvidence: liveEvidence(8, { runtimeId: "runtime-b" }) });
    expect(handoff.status).toBe(409);
    expect(await handoff.json()).toMatchObject({ error_code: "handoff_flush_unverified", recoverable: true });
    expect(await (await call(instance, "/v1/renew", { sessionId: opened.session.id, allocationGeneration: 7, fence: opened.session.fence })).json()).toMatchObject({ sessionId: opened.session.id, fence: opened.session.fence });
  });

  it("coalesces live checkpoint requests on a durable two-second deadline and publishes runtime sync through the checked service", async () => {
    const { instance, storage } = setup({ liveEnabled: true, runtimeControl: "ok" });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-live", allocationGeneration: 2,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(2, { runtimeId: "runtime-live" }) })).json() as { session: { id: string; fence: number } };
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const request = { sessionId: opened.session.id, allocationGeneration: 2, fence: opened.session.fence };
      const first = await call(instance, "/v1/live-checkpoint/request", request);
      const firstBody = await first.json() as { dueAt: number; coalescedRequests: number };
      const second = await call(instance, "/v1/live-checkpoint/request", request);
      const secondBody = await second.json() as { dueAt: number; coalescedRequests: number };
      expect(firstBody.dueAt).toBe(now + 2_000);
      expect(secondBody).toMatchObject({ dueAt: firstBody.dueAt, coalescedRequests: 2 });
      expect(storage.alarmAt).toBeLessThanOrEqual(firstBody.dueAt);

      now += 2_001;
      await instance.alarm();
      expect(await (await call(instance, "/v1/head?branch=main")).json()).toMatchObject({ head: { revision: 2 } });
      expect(await (await call(instance, "/v1/read?branch=main")).json()).toMatchObject({ entries: [{ path: "live.txt" }] });
      expect(storage.values.has("live-checkpoint:main")).toBe(false);
    } finally { vi.restoreAllMocks(); }
  });

  it("revokes the handoff target if runtime activation fails after the old writer is fenced", async () => {
    const { instance, storage } = setup({ liveEnabled: true, runtimeControl: "activation_failure" });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(7, { runtimeId: "runtime-a" }) })).json() as { session: { id: string; fence: number } };
    const response = await call(instance, "/v1/handoff", { sessionId: opened.session.id, targetRuntimeId: "runtime-b", allocationGeneration: 7,
      targetAllocationGeneration: 8, checkpointRevision: 1, targetCapabilityEvidence: liveEvidence(8, { runtimeId: "runtime-b" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "handoff_target_activation_failed", recoverable: true });
    expect(storage.values.get(`writer:main`)).toBeUndefined();
    const prior = [...storage.values.values()].find((value) => value && typeof value === "object" && (value as { id?: string }).id === opened.session.id) as { status: string };
    expect(prior.status).toBe("closed");
  });

  it("expires live leases, advances the fence, and rejects mutations from the prior writer", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const evidence = liveEvidence(7, { runtimeId: "runtime-a", allocationId: "allocation-live", templateDigest: `sha256:${"b".repeat(64)}` });
    const first = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7, mode: "live_single_writer", capabilityEvidence: evidence })).json() as { session: { id: string; fence: number } };
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    try {
      expect((await call(instance, "/v1/renew", { sessionId: first.session.id, allocationGeneration: 7, fence: first.session.fence })).status).toBe(409);
      const second = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-b", allocationGeneration: 8, mode: "live_single_writer", capabilityEvidence: liveEvidence(8, { runtimeId: "runtime-b", verifiedAt: now + 60_001 }) });
      expect(await second.json()).toMatchObject({ session: { fence: first.session.fence + 1, allocationGeneration: 8 } });
      const stale = await call(instance, "/v1/checkpoint", { sessionId: first.session.id, allocationGeneration: 7, fence: first.session.fence, baseRevision: 1, idempotencyKey: "expired-live-write", changes: [{ path: "late.txt", expectedHash: null, contentBase64: btoa("stale") }] });
      expect(await stale.json()).toMatchObject({ error_code: "writer_lease_expired" });
      const staleStage = await call(instance, "/v1/stage", { sessionId: first.session.id, stageId: "expired-stage", allocationGeneration: 7, fence: first.session.fence,
        changes: [{ path: "late-stage.txt", expectedHash: null, contentBase64: btoa("stale") }] });
      expect(await staleStage.json()).toMatchObject({ error_code: "writer_lease_expired" });
      expect((await call(instance, "/v1/session-snapshot?sessionId=" + encodeURIComponent(first.session.id) + "&runtimeId=runtime-a&allocationGeneration=7&fence=" + first.session.fence)).status).toBe(409);
    } finally { vi.restoreAllMocks(); }
  });

  it("revokes a live session and fences subsequent virtual/provider mutation callbacks", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const session = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 3,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(3, { runtimeId: "runtime" }) })).json() as { session: { id: string; fence: number } };
    expect(await (await call(instance, "/v1/revoke", { sessionId: session.session.id, allocationGeneration: 3, fence: session.session.fence })).json()).toMatchObject({ status: "revoked" });
    expect((await call(instance, "/v1/stage", { sessionId: session.session.id, stageId: "revoked-stage", allocationGeneration: 3, fence: session.session.fence, changes: [] })).status).toBe(404);
    expect(await (await call(instance, "/v1/checkpoint", { sessionId: session.session.id, allocationGeneration: 3, fence: session.session.fence, baseRevision: 1, idempotencyKey: "revoked-callback", changes: [] })).json()).toMatchObject({ error_code: "stale_fence" });
    const replacement = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-next", allocationGeneration: 4,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(4, { runtimeId: "runtime-next" }) });
    expect(await replacement.json()).toMatchObject({ session: { fence: session.session.fence + 2 } });
  });

  it("fails closed on authority revocation while the writer process and lease are still live", async () => {
    const { instance, verificationState } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 11,
      mode: "live_single_writer", capabilityEvidence: liveEvidence(11, { runtimeId: "runtime" }) })).json() as { session: { id: string; fence: number } };
    verificationState.authorized = false;
    const checkpoint = await call(instance, "/v1/checkpoint", { sessionId: opened.session.id, runtimeId: "runtime", allocationGeneration: 11,
      fence: opened.session.fence, baseRevision: 1, idempotencyKey: "revoked-authority-checkpoint",
      changes: [{ path: "late.txt", expectedHash: null, contentBase64: btoa("must not publish") }] });
    expect(await checkpoint.json()).toMatchObject({ error_code: "writer_lease_expired" });
    expect(await (await call(instance, "/v1/stage", { sessionId: opened.session.id, runtimeId: "runtime", stageId: "revoked-authority-stage",
      allocationGeneration: 11, fence: opened.session.fence, changes: [] })).json()).toMatchObject({ error_code: "writer_lease_expired" });
    expect((await call(instance, `/v1/session-snapshot?sessionId=${opened.session.id}&runtimeId=runtime&allocationGeneration=11&fence=${opened.session.fence}`)).status).toBe(409);
    expect(await (await call(instance, "/v1/renew", { sessionId: opened.session.id, allocationGeneration: 11, fence: opened.session.fence })).json()).toMatchObject({ error_code: "writer_lease_expired" });
    expect(await (await call(instance, "/v1/head?branch=main")).json()).toMatchObject({ head: { revision: 1 } });
  });

  it("reports cursor freshness from the authoritative head when a revision notification was missed", async () => {
    const { instance, storage } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const { session } = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "reader", runtimeId: "writer", allocationGeneration: 1 })).json() as { session: { id: string } };
    await call(instance, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: "missed-event", changes: [{ path: "fresh.txt", expectedHash: null, contentBase64: btoa("revision two") }] });
    storage.values.delete("revision:main:2");
    const response = await call(instance, "/v1/changes?branch=main&afterRevision=1");
    expect(await response.json()).toMatchObject({ head: { revision: 2 }, resetRequired: true, cursor: 1,
      freshness: { observedRevision: 2, cursorRevision: 1, stale: true, source: "authoritative_workspace_head" } });
  });

  it("serializes concurrent checkpoints so a reader sees one complete manifest", async () => {
    const { instance } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const open = async (runtimeId: string) => (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId, allocationGeneration: 1 })).json() as Promise<{ session: { id: string } }>;
    const [{ session: first }, { session: second }] = await Promise.all([open("runtime-a"), open("runtime-b")]);
    const checkpoint = (sessionId: string, path: string) => call(instance, "/v1/checkpoint", {
      sessionId, allocationGeneration: 1, fence: 0, baseRevision: 1, idempotencyKey: `parallel-${path}`,
      changes: [{ path, expectedHash: null, contentBase64: btoa(path) }],
    });
    const outcomes = await Promise.all([checkpoint(first.id, "a.txt"), checkpoint(second.id, "b.txt")]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
    const reader = await call(instance, "/v1/read?branch=main");
    const observed = await reader.json() as { head: { revision: number }; entries: WorkspaceEntry[] };
    expect(observed.head.revision).toBe(2);
    expect(observed.entries).toHaveLength(1);
    expect(["a.txt", "b.txt"]).toContain(observed.entries[0]?.path);
  });
});
