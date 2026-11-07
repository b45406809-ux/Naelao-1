import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCoordinatorDO } from "./WorkspaceCoordinatorDO.js";

class Storage {
  values = new Map<string, unknown>();
  private transactionQueue = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async list<T>({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit) as Array<[string, T]>);
  }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async deleteAll(): Promise<void> { this.values.clear(); }
  async transaction<T>(callback: (txn: this) => Promise<T>): Promise<T> {
    const next = this.transactionQueue.then(() => callback(this));
    this.transactionQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function setup(options: { liveEnabled?: boolean } = {}) {
  const storage = new Storage();
  const objects = new Map<string, Uint8Array>();
  const r2 = {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } } : null;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      objects.set(key, bytes.slice());
      return { key, size: bytes.byteLength };
    },
    async list({ prefix }: { prefix: string }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, uploaded: new Date(0), size: objects.get(key)!.byteLength })), truncated: false }; },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  } as unknown as R2Bucket;
  const env = { PLATFORM_SECRET: "secret", SCRIPTS_R2: r2, LIVE_WORKSPACE_ENABLED: options.liveEnabled ? "true" : "false" };
  const instance = new WorkspaceCoordinatorDO({ storage } as never, env as never);
  return { instance, restart: () => new WorkspaceCoordinatorDO({ storage } as never, env as never), storage, objects };
}

const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
async function call(instance: WorkspaceCoordinatorDO, path: string, body?: unknown, method = body ? "POST" : "GET") {
  const headers = new Headers({ "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") });
  if (body) headers.set("content-type", "application/json");
  return instance.fetch(new Request(`https://workspace${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
}

describe("WorkspaceCoordinatorDO checked publication", () => {
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
    expect([...objects.keys()].some(key => key.includes("/staging/") && key.includes(session.id))).toBe(true);
    expect((await call(instance, "/v1/stage", { sessionId: session.id, stageId: "stage-1", allocationGeneration: 3, fence: 0, changes: [{ ...changes[0], contentBase64: btoa("changed bytes") }] })).status).toBe(409);
    const recoveredCoordinator = restart();
    const published = await call(recoveredCoordinator, "/v1/checkpoint", { sessionId: session.id, allocationGeneration: 3, fence: 0, baseRevision: 1, idempotencyKey: "stage-checkpoint", stageId: "stage-1" });
    expect(await published.json()).toMatchObject({ publication: { status: "published", revision: 2, appliedPaths: ["src/staged.bin"] } });
    const read = await call(recoveredCoordinator, "/v1/read?branch=main");
    expect(await read.json()).toMatchObject({ head: { revision: 2 }, entries: [{ path: "src/staged.bin" }] });
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

  it("erases one workspace scope and leaves a tombstone that rejects later reads and writes", async () => {
    const { instance, objects } = setup();
    const content = new TextEncoder().encode("private");
    const hash = "715dc8493c36579a5b116995100f635e3572fdf8703e708ef1a08d943b36774e";
    const key = `workspace-v1/tenant/space/project/global/content/${hash}`;
    objects.set(key, content);
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [{ path: "private.txt", sha256: hash, size: content.length, executable: false, objectKey: key }] });
    const erased = await call(instance, "/v1/erase", { scope, confirm: true });
    expect(await erased.json()).toMatchObject({ erased: true, scope, objectsDeleted: 2 });
    expect(objects.size).toBe(0);
    expect((await call(instance, "/v1/head?branch=main")).status).toBe(410);
    expect(await (await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] })).json()).toMatchObject({ error_code: "workspace_erased" });
  });

  it("rejects stale allocation generations, unsafe paths, and a second live writer", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const open = () => call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime", allocationGeneration: 7, mode: "live_single_writer", capabilityEvidence: {
      liveMountReady: true, authenticatedTransport: true, allocationId: "allocation-7", allocationGeneration: 7,
      templateDigest: `sha256:${"a".repeat(64)}`, verifiedAt: Date.now(),
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

  it("creates an isolated branch head without changing the source branch", async () => {
    const { instance } = setup();
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const created = await call(instance, "/v1/branch", { scope, sourceBranch: "main", branch: "runs/agent-a" });
    expect(await created.json()).toMatchObject({ branch: { branch: "runs/agent-a", revision: 1 }, created: true });
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
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const evidence = { liveMountReady: true, authenticatedTransport: true, allocationId: "allocation-7", allocationGeneration: 7, templateDigest: `sha256:${"a".repeat(64)}`, verifiedAt: Date.now() };
    const opened = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7, mode: "live_single_writer", capabilityEvidence: evidence })).json() as { session: { id: string; fence: number } };
    const handoff = await call(instance, "/v1/handoff", { sessionId: opened.session.id, targetRuntimeId: "runtime-b", allocationGeneration: 7, targetAllocationGeneration: 8, checkpointRevision: 1 });
    const next = await handoff.json() as { session: { id: string; fence: number; allocationGeneration: number } };
    expect(handoff.status, JSON.stringify(next)).toBe(200);
    expect(next.session).toMatchObject({ fence: opened.session.fence + 1, allocationGeneration: 8 });
    const stale = await call(instance, "/v1/checkpoint", { sessionId: opened.session.id, allocationGeneration: 7, fence: opened.session.fence, baseRevision: 1, idempotencyKey: "stale-after-handoff", changes: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error_code: "stale_fence" });
  });

  it("expires live leases, advances the fence, and rejects mutations from the prior writer", async () => {
    const { instance } = setup({ liveEnabled: true });
    await call(instance, "/v1/initialize", { scope, branch: "main", entries: [] });
    const evidence = { liveMountReady: true, authenticatedTransport: true, allocationId: "allocation-live", allocationGeneration: 7, templateDigest: `sha256:${"b".repeat(64)}`, verifiedAt: Date.now() };
    const first = await (await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-a", allocationGeneration: 7, mode: "live_single_writer", capabilityEvidence: evidence })).json() as { session: { id: string; fence: number } };
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    try {
      expect((await call(instance, "/v1/renew", { sessionId: first.session.id, allocationGeneration: 7, fence: first.session.fence })).status).toBe(409);
      const second = await call(instance, "/v1/open", { scope, branch: "main", actorId: "user", runtimeId: "runtime-b", allocationGeneration: 8, mode: "live_single_writer", capabilityEvidence: { ...evidence, allocationId: "allocation-next", allocationGeneration: 8, verifiedAt: now + 60_001 } });
      expect(await second.json()).toMatchObject({ session: { fence: first.session.fence + 1, allocationGeneration: 8 } });
      const stale = await call(instance, "/v1/checkpoint", { sessionId: first.session.id, allocationGeneration: 7, fence: first.session.fence, baseRevision: 1, idempotencyKey: "expired-live-write", changes: [{ path: "late.txt", expectedHash: null, contentBase64: btoa("stale") }] });
      expect(await stale.json()).toMatchObject({ error_code: "writer_lease_expired" });
    } finally { vi.restoreAllMocks(); }
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
