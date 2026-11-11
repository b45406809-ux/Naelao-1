import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { LiveRuntimeControlDO } from "./LiveRuntimeControlDO.js";

const secret = "runtime-control-test-secret";
const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
const session = "ws_12345678-1234-1234-1234-123456789abc";

function syncBody(nonce = "nonce-1") {
  return {
    scope, nonce, requestId: "live-checkpoint-request-1", sessionId: session, runtimeId: "runtime-a",
    allocationGeneration: 2, fence: 7, branch: "main", afterCursor: null,
  };
}

function syncResult(input: ReturnType<typeof syncBody>) {
  return {
    synced: true, nonce: input.nonce, requestId: input.requestId, sessionId: input.sessionId,
    runtimeId: input.runtimeId, allocationGeneration: input.allocationGeneration, fence: input.fence,
    changes: [{ path: "live.txt", expectedHash: null, contentBase64: btoa("runtime bytes"), contentType: "text/plain" }],
    cursor: "cursor-1",
  };
}

function makeStorage() {
  const values = new Map<string, unknown>();
  let transactionTail: Promise<unknown> = Promise.resolve();
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, structuredClone(value)); },
    async transaction<T>(callback: (tx: typeof storage) => Promise<T>): Promise<T> {
      const result = transactionTail.then(() => callback(storage));
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
  return { values, storage };
}

function makeDO(storage: ReturnType<typeof makeStorage>["storage"], runtimeAgent?: Fetcher) {
  return new LiveRuntimeControlDO({ storage } as never, { PLATFORM_SECRET: secret, ...(runtimeAgent ? { LIVE_RUNTIME_AGENT: runtimeAgent } : {}) } as never);
}

async function request(path: string, body: Record<string, unknown>, token = true) {
  const headers = new Headers({ "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId });
  if (token) headers.set("x-naelao-internal-token", await mintInternalToken(secret, scope.tenantId));
  return new Request(`https://runtime-control${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("LiveRuntimeControlDO", () => {
  it("authenticates the coordinator and fails closed when no runtime adapter is bound", async () => {
    const { storage } = makeStorage();
    const control = makeDO(storage);
    const denied = await control.fetch(await request("/internal/v1/checkpoint/sync", syncBody(), false));
    expect(denied.status).toBe(403);
    const unavailable = await control.fetch(await request("/internal/v1/checkpoint/sync", syncBody()));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error_code: "runtime_adapter_unavailable", outcome: "not_dispatched" });
  });

  it("validates sync deltas and reconciles retries through the adapter journal without replay", async () => {
    const { storage } = makeStorage();
    const first = syncBody();
    let dispatched = 0;
    let statusReads = 0;
    const adapter = {
      async fetch(request: Request) {
        if (request.method === "POST") {
          dispatched++;
          return Response.json(syncResult(first));
        }
        statusReads++;
        return Response.json({ operationId: "sync:live-checkpoint-request-1", state: "complete", result: syncResult(first) });
      },
    } as unknown as Fetcher;
    const control = makeDO(storage, adapter);
    const initial = await control.fetch(await request("/internal/v1/checkpoint/sync", first));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ synced: true, cursor: "cursor-1" });
    const retriedInput = syncBody("nonce-2");
    const retry = await control.fetch(await request("/internal/v1/checkpoint/sync", retriedInput));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ synced: true, nonce: "nonce-2", cursor: "cursor-1" });
    expect(dispatched).toBe(1);
    expect(statusReads).toBe(1);
  });

  it("records a lost response as unknown and never dispatches the external operation again", async () => {
    const { storage } = makeStorage();
    const input = syncBody();
    let sideEffects = 0;
    let journalState: "pending" | "complete" = "pending";
    const adapter = {
      async fetch(request: Request) {
        if (request.method === "POST") {
          sideEffects++;
          throw new Error("connection dropped after runtime accepted request");
        }
        return Response.json({ operationId: "sync:live-checkpoint-request-1", state: journalState,
          ...(journalState === "complete" ? { result: syncResult(input) } : {}) });
      },
    } as unknown as Fetcher;
    const control = makeDO(storage, adapter);
    const lost = await control.fetch(await request("/internal/v1/checkpoint/sync", input));
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ error_code: "runtime_operation_outcome_unknown" });
    const pending = await control.fetch(await request("/internal/v1/checkpoint/sync", syncBody("nonce-2")));
    expect(pending.status).toBe(503);
    expect(sideEffects).toBe(1);
    journalState = "complete";
    const reconciled = await control.fetch(await request("/internal/v1/operations/reconcile", {
      scope, operationId: "sync:live-checkpoint-request-1",
    }));
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ synced: true, cursor: "cursor-1" });
    expect(sideEffects).toBe(1);
  });

  it("claims concurrent operation ids atomically before calling the runtime adapter", async () => {
    const { storage } = makeStorage();
    const input = { ...syncBody(), requestId: "concurrent-checkpoint" };
    let dispatches = 0;
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = {
      async fetch(request: Request) {
        if (request.method === "GET") return Response.json({ state: "pending" });
        dispatches++;
        markEntered();
        await gate;
        return Response.json(syncResult(input));
      },
    } as unknown as Fetcher;
    const control = makeDO(storage, adapter);
    const firstPending = control.fetch(await request("/internal/v1/checkpoint/sync", input));
    await entered;
    const concurrent = await control.fetch(await request("/internal/v1/checkpoint/sync", { ...input, nonce: "nonce-2" }));
    expect(concurrent.status).toBe(503);
    release();
    const first = await firstPending;
    expect(first.status).toBe(200);
    expect(dispatches).toBe(1);
  });

  it("does not turn an unverified flush response into a handoff receipt", async () => {
    const { storage } = makeStorage();
    const adapter = {
      async fetch() {
        return Response.json({ prepared: true, receipt: {
          id: "flush-1", nonce: "prepare-1", sessionId: session, runtimeId: "runtime-a", allocationGeneration: 2,
          fence: 7, revision: 4, writeAdmissionStopped: true, inFlightDrained: true, filesystemFlushed: false,
          flushMethod: "fsync", flushCompletedAt: Date.now(),
        } });
      },
    } as unknown as Fetcher;
    const control = makeDO(storage, adapter);
    const response = await control.fetch(await request("/internal/v1/handoff/prepare", {
      scope, nonce: "prepare-1", sessionId: session, runtimeId: "runtime-a", allocationGeneration: 2, fence: 7,
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "runtime_operation_outcome_unverified" });
  });

  it("records checkpoint acknowledgements durably without a provider call", async () => {
    const { storage, values } = makeStorage();
    const control = makeDO(storage);
    const ack = {
      scope, requestId: "live-checkpoint-request-1", sessionId: session, runtimeId: "runtime-a",
      allocationGeneration: 2, fence: 7, revision: 5, elapsedMs: 25,
    };
    const response = await control.fetch(await request("/internal/v1/checkpoint/ack", ack));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acknowledged: true });
    expect(values.get("operation:ack:live-checkpoint-request-1")).toMatchObject({ state: "complete", kind: "ack", result: { acknowledged: true } });
  });

  it("persists a project erasure tombstone and blocks later control operations while preserving receipts", async () => {
    const { storage, values } = makeStorage();
    const control = makeDO(storage);
    const ack = {
      scope, requestId: "live-checkpoint-request-1", sessionId: session, runtimeId: "runtime-a",
      allocationGeneration: 2, fence: 7, revision: 5, elapsedMs: 25,
    };
    await control.fetch(await request("/internal/v1/checkpoint/ack", ack));
    const erased = await control.fetch(await request("/internal/v1/project/erase", { scope, confirm: true }));
    expect(erased.status).toBe(200);
    expect(await erased.json()).toMatchObject({ erased: true, runtimeStop: "not_proven", providerDeletion: "tracked_separately" });
    const blocked = await control.fetch(await request("/internal/v1/checkpoint/ack", { ...ack, requestId: "later-ack" }));
    expect(blocked.status).toBe(410);
    expect(await blocked.json()).toMatchObject({ error_code: "runtime_scope_erased" });
    expect(values.has("operation:ack:live-checkpoint-request-1")).toBe(true);
  });
});
