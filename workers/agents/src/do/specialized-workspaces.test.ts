import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { ConcurrencyDO } from "./ConcurrencyDO.js";
import { ToolSandboxDO } from "./ToolSandboxDO.js";
import { sha256Bytes } from "../script-engine/r2-cas.js";

const image = "registry.example/media@sha256:" + "a".repeat(64);
const prefix = "spaces/space/projects/project/workspace/";

// R2 and the native process transport are doubles. Publication uses the real ConcurrencyDO
// and its actual SQLite schema/CAS implementation, not a mocked lock success response.
function workspace() {
  const data = new Map<string, Uint8Array>(), metadata = new Map<string, Record<string, string>>(), etags = new Map<string, string>();
  let revision = 0;
  const bucket = {
    head: async (key: string) => data.has(key) ? { etag: etags.get(key), customMetadata: metadata.get(key) } : null,
    get: vi.fn(async (key: string) => {
      const bytes = data.get(key);
      return bytes ? { customMetadata: metadata.get(key), arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
    put: async (key: string, value: Uint8Array, options?: { customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      if (options?.onlyIf?.etagMatches && etags.get(key) !== options.onlyIf.etagMatches || options?.onlyIf?.etagDoesNotMatch === "*" && data.has(key)) return null;
      data.set(key, new Uint8Array(value)); metadata.set(key, options?.customMetadata ?? {}); etags.set(key, String(++revision));
      return { etag: etags.get(key) };
    },
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...data.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, customMetadata: metadata.get(key) })), truncated: false }),
    delete: async (key: string) => { data.delete(key); },
  };
  const locks = new Map<string, ConcurrencyDO>();
  const namespace = {
    idFromName: (key: string) => key,
    get: (key: string) => {
      if (!locks.has(key)) locks.set(key, new ConcurrencyDO({ storage: { ...createDOStorage(), getAlarm: async () => null, setAlarm: async () => undefined } } as never, { SCRIPTS_R2: bucket as unknown as R2Bucket }));
      return locks.get(key)!;
    },
  };
  const seed = async (key: string, bytes: Uint8Array) => bucket.put(key, bytes, { customMetadata: { sha256: await sha256Bytes(bytes) } });
  return { data, bucket, namespace, seed };
}

function runtime(store: ReturnType<typeof workspace>, deployedImage = image) {
  const files = new Map<string, string>(), records = new Map<string, unknown>(), calls: string[] = [];
  let running = false;
  let afterExec: (() => Promise<void>) | undefined;
  const transport = {
    get running() { return running; },
    start: vi.fn(() => { running = true; files.clear(); }),
    destroy: vi.fn(async () => { running = false; }),
    inspect: vi.fn(async () => ({ image: deployedImage })),
    getTcpPort: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname; calls.push(path);
      const body = await request.json().catch(() => ({})) as { files_base64?: Record<string, string>; paths?: string[]; args?: { write?: Record<string, string>; remove?: string[] } };
      if (path === "/workspace/write") for (const [key, value] of Object.entries(body.files_base64 ?? {})) files.set(key, value);
      if (path === "/workspace/delete") for (const key of body.paths ?? []) files.delete(key);
      if (path === "/workspace/list") return Response.json({ files: [...files.keys()] });
      if (path === "/workspace/read") return Response.json({ files_base64: Object.fromEntries((body.paths ?? [...files.keys()]).map(key => [key, files.get(key)])) });
      if (path === "/exec") {
        for (const [key, value] of Object.entries(body.args?.write ?? {})) files.set(key, value);
        for (const key of body.args?.remove ?? []) files.delete(key);
        await afterExec?.();
        return Response.json({ ok: true, result: { files: Object.fromEntries(files) } });
      }
      return Response.json({ ok: true });
    } }),
  };
  const ctx = { container: transport, storage: {
    get: async (key: string) => records.get(key), put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
    delete: async (key: string) => records.delete(key), setAlarm: async () => undefined,
  } };
  const env = { PLATFORM_SECRET: "test-secret", SCRIPTS_R2: store.bucket, CONCURRENCY_DO: store.namespace,
    BILLING_WORKER: { fetch: async () => Response.json({ ok: true }) } };
  const make = () => new ToolSandboxDO(ctx as never, env as never);
  let sandbox = make();
  const exec = async (args = {}, sidecar = false, bodyScope = { spaceId: "space", projectId: "project" }) => {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "user", agentId: "worker", runId: "run",
      executionId: crypto.randomUUID(), timeoutMs: 55000, deadline: Date.now() + 55000,
      ...(sidecar ? { image, installationId: "media-one" } : {}) };
    return sandbox.fetch(new Request("http://sandbox/exec", { method: "POST", headers: { "content-type": "application/json",
      "x-naelao-container-scope": JSON.stringify(scope), "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant") },
      body: JSON.stringify({ ...bodyScope, args }) }));
  };
  return { files, records, calls, transport, exec, restart: () => { sandbox = make(); }, afterExec: (fn: () => Promise<void>) => { afterExec = fn; } };
}

describe("specialized project workspaces", () => {
  it("refreshes warm readers across specialized executions, including binary updates and deletions", async () => {
    const store = workspace(), general = runtime(store), specialized = runtime(store);
    await store.seed("spaces/space/projects/other/workspace/private.txt", new TextEncoder().encode("private"));
    expect((await general.exec()).ok).toBe(true);
    const binary = Buffer.from([0, 255, 1, 128]).toString("base64");
    expect((await specialized.exec({ write: { "clip.bin": binary } }, true)).ok).toBe(true);
    expect(specialized.transport.destroy).toHaveBeenCalledOnce();
    const read = await general.exec();
    expect(await read.json()).toMatchObject({ result: { files: { "clip.bin": binary } } });
    expect(general.transport.start).toHaveBeenCalledOnce();
    expect((await specialized.exec({ remove: ["clip.bin"] }, true)).ok).toBe(true);
    general.restart();
    expect(await (await general.exec()).json()).toMatchObject({ result: { files: {} } });
    expect(general.files.size).toBe(0);
    expect(general.calls).toContain("/workspace/delete");
    expect(store.data.get("spaces/space/projects/other/workspace/private.txt")).toBeDefined();
    expect(store.bucket.get.mock.calls.some(([key]) => key.includes("/other/"))).toBe(false);
  });

  it("rejects a deployed digest mismatch before exposing project files", async () => {
    const store = workspace(); await store.seed(prefix + "private.txt", new TextEncoder().encode("private"));
    const wrong = runtime(store, "registry.example/wrong@sha256:" + "b".repeat(64));
    expect((await wrong.exec({}, true)).status).toBe(409);
    expect(wrong.calls).not.toContain("/workspace/write");
    expect(wrong.calls).not.toContain("/exec");
    expect(store.bucket.get).not.toHaveBeenCalled();
    expect(wrong.transport.destroy).toHaveBeenCalledOnce();
  });

  it("derives workspace identity from the authenticated invocation, never the body", async () => {
    const store = workspace(), worker = runtime(store);
    expect((await worker.exec({}, false, { spaceId: "other-space", projectId: "project" })).status).toBe(403);
    expect((await worker.exec({}, false, { spaceId: "space", projectId: "other-project" })).status).toBe(403);
    expect(worker.transport.start).not.toHaveBeenCalled();
    expect(store.bucket.get).not.toHaveBeenCalled();
  });

  it("preserves a concurrent writer and leaves failed publication for reconciliation after restart", async () => {
    const store = workspace(), worker = runtime(store);
    await store.seed(prefix + "report.txt", new TextEncoder().encode("initial"));
    worker.afterExec(async () => { await store.seed(prefix + "report.txt", new TextEncoder().encode("concurrent")); });
    const response = await worker.exec({ write: { "report.txt": Buffer.from("worker").toString("base64") } });
    expect(response.status).toBe(409);
    expect(Buffer.from(store.data.get(prefix + "report.txt")!).toString()).toBe("concurrent");
    expect(worker.records.has("workspace_pending_publication")).toBe(true);
    worker.restart();
    expect((await worker.exec()).status).toBe(409);
    expect(Buffer.from(store.data.get(prefix + "report.txt")!).toString()).toBe("concurrent");
    expect(worker.calls.filter(path => path === "/exec")).toHaveLength(1);
  });
});
