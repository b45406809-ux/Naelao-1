import { createContainerWorkspaceGateway } from "../script-engine/container-workspace.js";
import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { ConcurrencyDO } from "./ConcurrencyDO.js";
import { sandboxWorkspacePrefix, ToolSandboxDO } from "./ToolSandboxDO.js";
import { readBytesWithHash, sha256Bytes } from "../script-engine/r2-cas.js";

const image = "registry.example/media@sha256:" + "a".repeat(64);
const prefix = "spaces/space/projects/project/workspace/";
const extensionPrefix = "spaces/space/space-workspace/extensions/media-one/workspace/";

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
    interceptOutboundHttps: vi.fn(async () => undefined),
    destroy: vi.fn(async () => { running = false; }),
    inspect: vi.fn(async () => ({ image: deployedImage })),
    getTcpPort: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname; calls.push(path);
      const body = await request.json().catch(() => ({})) as { files_base64?: Record<string, string>; paths?: string[]; files?: Record<string, string>; encoding?: string; args?: { write?: Record<string, string>; remove?: string[] } };
      if (path === "/workspace/write") {
        for (const [key, value] of Object.entries(body.files_base64 ?? {})) files.set(key, value);
        for (const [key, value] of Object.entries(body.files ?? {})) files.set(key, Buffer.from(value).toString("base64"));
      }
      if (path === "/workspace/delete") for (const key of body.paths ?? []) files.delete(key);
      if (path === "/workspace/list") return Response.json({ files: [...files.keys()] });
      if (path === "/workspace/read" && body.encoding !== "base64") return Response.json({ files: Object.fromEntries((body.paths ?? [...files.keys()]).filter(key => files.has(key)).map(key => [key, Buffer.from(files.get(key)!, "base64").toString()])) });
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
  const ctx = { container: transport, exports: { PackageEgress: () => ({ fetch: async (request: Request) => new Response(request.url) }) }, storage: {
    get: async (key: string) => records.get(key), put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
    delete: async (key: string) => records.delete(key), setAlarm: async () => undefined,
  } };
  const env = { PLATFORM_SECRET: "test-secret", SCRIPTS_R2: store.bucket, CONCURRENCY_DO: store.namespace,
    BILLING_WORKER: { fetch: async () => Response.json({ ok: true }) } };
  const make = () => new ToolSandboxDO(ctx as never, env as never);
  let sandbox = make();
  const exec = async (args = {}, sidecar = false, bodyScope = { spaceId: "space", projectId: "project" }, installationScope?: "SPACE_SHARED" | "PROJECT_SHARED") => {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "user", agentId: "worker", runId: "run",
      executionId: crypto.randomUUID(), timeoutMs: 55000, deadline: Date.now() + 55000,
      ...(sidecar ? { image, dynamicImage: false, installationId: "media-one", ...(installationScope ? { installationScope } : {}) } : {}) };
    return sandbox.fetch(new Request("http://sandbox/exec", { method: "POST", headers: { "content-type": "application/json",
      "x-naelao-container-scope": JSON.stringify(scope), "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant") },
      body: JSON.stringify({ ...bodyScope, args }) }));
  };
  const addresses: string[] = [];
  const gateway = (branch?: string, authorize = true) => createContainerWorkspaceGateway({
    namespace: { idFromName: (key: string) => { addresses.push(key); return key; }, get: () => ({ fetch: (request: Request) => sandbox.fetch(request) }) } as never,
    secret: "test-secret", actor: () => ({ tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "user", agentId: "worker", runId: "run", branch }),
    authorize: async () => authorize,
  });
  const lifecycle = async (branch?: string, status: "active" | "blocked" | "completed" = "active", bodyBranch = branch, signed = true) => {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "user", agentId: "worker", runId: "run",
      executionId: crypto.randomUUID(), ...(branch ? { workspaceBranch: branch } : {}), timeoutMs: 5000, deadline: Date.now() + 5000 };
    return sandbox.fetch(new Request("http://sandbox/lifecycle", { method: "POST", headers: { "content-type": "application/json",
      "x-naelao-container-scope": JSON.stringify(scope), ...(signed ? { "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant") } : {}) },
      body: JSON.stringify({ status, tenantId: "tenant", spaceId: "space", projectId: "project", ...(bodyBranch ? { workspaceBranch: bodyBranch } : {}) }) }));
  };
  return { gateway, addresses, files, records, calls, transport, exec, lifecycle, restart: () => { sandbox = make(); }, afterExec: (fn: () => Promise<void>) => { afterExec = fn; } };
}

describe("specialized project workspaces", () => {
  it("routes assistant, project, and Space-shared runtimes to distinct workspace roots", () => {
    expect(sandboxWorkspacePrefix({ spaceId: "space", installationId: "assistant-one", installationScope: "SPACE_ASSISTANT" }))
      .toBe("spaces/space/workspace/");
    expect(sandboxWorkspacePrefix({ spaceId: "space", projectId: "project", installationId: "project-one", installationScope: "PROJECT_SHARED" }))
      .toBe(prefix);
    expect(sandboxWorkspacePrefix({ spaceId: "space", projectId: "project", installationId: "media-one", installationScope: "SPACE_SHARED" }))
      .toBe(extensionPrefix);
    expect(() => sandboxWorkspacePrefix({ spaceId: "space", projectId: "project", installationId: "bad", installationScope: "SPACE_ASSISTANT" }))
      .toThrow("assistant_runtime_project_scope_mismatch");
  });

  it("refreshes warm readers across specialized executions, including binary updates and deletions", async () => {
    const store = workspace(), general = runtime(store), specialized = runtime(store);
    await store.seed("spaces/space/projects/other/workspace/private.txt", new TextEncoder().encode("private"));
    expect((await general.exec()).ok).toBe(true);
    const binary = Buffer.from([0, 255, 1, 128]).toString("base64");
    expect((await specialized.exec({ write: { "clip.bin": binary } }, true)).ok).toBe(true);
    expect(specialized.transport.start).toHaveBeenCalledWith({ enableInternet: false });
    expect(specialized.transport.destroy).not.toHaveBeenCalled();
    const read = await general.exec();
    expect(await read.json()).toMatchObject({ result: { files: { "clip.bin": binary } } });
    expect(general.transport.start).toHaveBeenCalledOnce();
    expect((await specialized.exec({ remove: ["clip.bin"] }, true)).ok).toBe(true);
    expect(specialized.transport.start).toHaveBeenCalledOnce();
    general.restart();
    expect(await (await general.exec()).json()).toMatchObject({ result: { files: {} } });
    expect(general.files.size).toBe(0);
    expect(general.calls).toContain("/workspace/delete");
    expect(store.data.get("spaces/space/projects/other/workspace/private.txt")).toBeDefined();
    expect(store.bucket.get.mock.calls.some(([key]) => key.includes("/other/"))).toBe(false);
  });

  it("puts a Space-shared extension in its own workspace, separate from both project and assistant files", async () => {
    const store = workspace(), worker = runtime(store);
    await store.seed(prefix + "project-private.txt", new TextEncoder().encode("project-only"));
    await store.seed("spaces/space/workspace/assistant-private.txt", new TextEncoder().encode("assistant-only"));
    await store.seed(extensionPrefix + "shared-state.json", new TextEncoder().encode("extension-state"));

    const response = await worker.exec({}, true, { spaceId: "space", projectId: "project" }, "SPACE_SHARED");
    expect(await response.json()).toMatchObject({ result: { files: { "shared-state.json": expect.any(String) } } });
    expect(worker.files.has("project-private.txt")).toBe(false);
    expect(worker.files.has("assistant-private.txt")).toBe(false);
    expect(store.bucket.get.mock.calls.some(([key]) => key === extensionPrefix + "shared-state.json")).toBe(true);
    expect(store.bucket.get.mock.calls.some(([key]) => key.includes("project-private.txt") || key.includes("assistant-private.txt"))).toBe(false);
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


describe("signed workspace gateway through real ToolSandboxDO and ConcurrencyDO", () => {
  it("reads canonical files cold, publishes edits immediately, and rejects stale writes and deletes", async () => {
    const store = workspace(); await store.seed(prefix + "report.txt", new TextEncoder().encode("old"));
    const r = runtime(store), gateway = r.gateway();
    expect(await gateway.read(["report.txt"])).toMatchObject({ files: { "report.txt": "old" } });
    const original = await sha256Bytes(new TextEncoder().encode("old"));
    await gateway.write({ "report.txt": "new" }, { "report.txt": original });
    expect(new TextDecoder().decode(store.data.get(prefix + "report.txt"))).toBe("new");
    await expect(gateway.write({ "report.txt": "lost-update" }, { "report.txt": original })).rejects.toThrow("workspace_state_conflict");
    await expect(gateway.remove(["report.txt"], { "report.txt": original })).rejects.toThrow("workspace_state_conflict");
    expect(new TextDecoder().decode(store.data.get(prefix + "report.txt"))).toBe("new");
    await gateway.remove(["report.txt"], { "report.txt": await sha256Bytes(new TextEncoder().encode("new")) });
    expect(await readBytesWithHash(store.bucket as never, prefix + "report.txt")).toBeNull();
    r.restart(); expect(await gateway.list()).toMatchObject({ files: [] });
  });
  it("uses the worker branch's actor and R2 prefix while leaving the project root untouched", async () => {
    const store = workspace(); await store.seed(prefix + "root.txt", new TextEncoder().encode("root"));
    const r = runtime(store), gateway = r.gateway("task/worker-one");
    expect(await gateway.list()).toMatchObject({ files: [] });
    await gateway.write({ "worker.txt": "branch" }, { "worker.txt": null });
    expect(r.addresses.every(key => key === "sandbox:space:project:branch:task/worker-one")).toBe(true);
    const branchPrefix = sandboxWorkspacePrefix({ spaceId: "space", projectId: "project", branch: "task/worker-one" });
    expect(new TextDecoder().decode(store.data.get(branchPrefix + "worker.txt"))).toBe("branch");
    expect(new TextDecoder().decode(store.data.get(prefix + "root.txt"))).toBe("root");
    expect(store.data.has(prefix + "worker.txt")).toBe(false);
  });
  it("denies missing grants and invalid branches without allocating or accessing an actor", async () => {
    const r = runtime(workspace());
    await expect(r.gateway(undefined, false).list()).rejects.toThrow("not_authorized");
    await expect(r.gateway("../escape").list()).rejects.toThrow("container_workspace_branch_invalid");
    expect(r.addresses).toHaveLength(0); expect(r.transport.start).not.toHaveBeenCalled();
  });

  it("authenticates lifecycle updates and binds them to the addressed workspace branch", async () => {
    const store = workspace(), app = runtime(store);
    expect((await app.lifecycle("task/worker-one", "active", "task/worker-one", false)).status).toBe(403);
    expect((await app.lifecycle("task/worker-one", "active", "task/worker-two")).status).toBe(403);
    expect((await app.lifecycle("task/worker-one", "active")).status).toBe(200);
    expect(app.records.get("task_active")).toBe(true);
    expect((await app.lifecycle("task/worker-one", "completed")).status).toBe(200);
    expect(app.records.has("task_active")).toBe(false);
  });
  it("refreshes warm readers after another runtime changes the canonical file", async () => {
    const store = workspace(); const r = runtime(store), gateway = r.gateway();
    await store.seed(prefix + "shared.txt", new TextEncoder().encode("first"));
    expect(await gateway.read(["shared.txt"])).toMatchObject({ files: { "shared.txt": "first" } });
    await store.seed(prefix + "shared.txt", new TextEncoder().encode("second"));
    expect(await gateway.read(["shared.txt"])).toMatchObject({ files: { "shared.txt": "second" } });
  });
  it("allows exactly one winner in a 32-way stale-revision write burst", async () => {
    const store = workspace(); await store.seed(prefix + "race.txt", new TextEncoder().encode("baseline"));
    const gateway = runtime(store).gateway();
    const baseline = await sha256Bytes(new TextEncoder().encode("baseline"));
    const results = await Promise.allSettled(Array.from({ length: 32 }, (_, index) =>
      gateway.write({ "race.txt": "writer-" + index }, { "race.txt": baseline })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(31);
    expect(new TextDecoder().decode(store.data.get(prefix + "race.txt"))).toMatch(/^writer-/);
  });

});
