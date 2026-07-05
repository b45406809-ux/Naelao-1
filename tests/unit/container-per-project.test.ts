import { describe, it, expect, beforeEach } from "vitest";
import { ToolSandboxDO } from "../../workers/agents/src/do/ToolSandboxDO.js";

// §A1.17 Phase K: a Cloudflare Container has no native R2 mount, so ToolSandboxDO approximates
// one by syncing the project's R2 workspace (workspacePrefix()) around every /exec call — files
// a script writes under /workspace persist in R2 and are visible to the NEXT call, whether that
// call comes from the same thread after a simulated restart or a different thread in the same
// project (the container is now addressed per-project, see code-runner.test.ts's addressing
// tests, so both land on the same ToolSandboxDO instance/R2 prefix anyway).

/** Minimal in-memory R2Bucket sufficient for ToolSandboxDO's list/get/put/delete usage. */
function makeFakeR2() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return { text: async () => v, size: v.length } as unknown as R2ObjectBody;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.length, uploaded: new Date() }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  } as unknown as R2Bucket & { store: Map<string, string> };
}

function makeHarness(handler: (req: Request) => Promise<Response>) {
  return {
    running: true,
    start() {},
    getTcpPort() {
      return { fetch: handler };
    },
  };
}

function makeDO(env: { SCRIPTS_R2?: ReturnType<typeof makeFakeR2> }, container: ReturnType<typeof makeHarness>) {
  const ctx = { container };
  return new ToolSandboxDO(ctx as never, env as never);
}

describe("ToolSandboxDO — R2 workspace sync around /exec", () => {
  let r2: ReturnType<typeof makeFakeR2>;

  beforeEach(() => {
    r2 = makeFakeR2();
  });

  it("syncs existing R2 files into the harness request as workspace_files", async () => {
    r2.store.set("spaces/space1/projects/proj-1/workspace/data.csv", "a,b\n1,2");
    let receivedBody: unknown;
    const harness = makeHarness(async (req) => {
      receivedBody = await req.json();
      return Response.json({ ok: true, result: {} });
    });
    const doInstance = makeDO({ SCRIPTS_R2: r2 }, harness);

    await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-1" }),
    }));

    expect((receivedBody as { workspace_files: Record<string, string> }).workspace_files).toEqual({ "data.csv": "a,b\n1,2" });
  });

  it("writes the harness's workspace_files_out back to R2 under the same project prefix", async () => {
    const harness = makeHarness(async () =>
      Response.json({ ok: true, result: { done: true }, workspace_files_out: { "out.txt": "hello" } })
    );
    const doInstance = makeDO({ SCRIPTS_R2: r2 }, harness);

    const resp = await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-1" }),
    }));
    const body = await resp.json();

    expect(r2.store.get("spaces/space1/projects/proj-1/workspace/out.txt")).toBe("hello");
    // The internal workspace_files_out field is a DO<->harness wire detail, not part of the
    // client-facing script.run result.
    expect(body).not.toHaveProperty("workspace_files_out");
  });

  it("deletes a file from R2 when the script removes it from /workspace", async () => {
    r2.store.set("spaces/space1/projects/proj-1/workspace/keep.txt", "keep");
    r2.store.set("spaces/space1/projects/proj-1/workspace/remove.txt", "gone-after-run");
    const harness = makeHarness(async () =>
      Response.json({ ok: true, result: {}, workspace_files_out: { "keep.txt": "keep" } })
    );
    const doInstance = makeDO({ SCRIPTS_R2: r2 }, harness);

    await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-1" }),
    }));

    expect(r2.store.has("spaces/space1/projects/proj-1/workspace/remove.txt")).toBe(false);
    expect(r2.store.get("spaces/space1/projects/proj-1/workspace/keep.txt")).toBe("keep");
  });

  it("a file written for one thread's run is visible to a subsequent run in the SAME project (shared workspace)", async () => {
    const writer = makeHarness(async () => Response.json({ ok: true, result: {}, workspace_files_out: { "shared.txt": "from-thread-A" } }));
    const doA = makeDO({ SCRIPTS_R2: r2 }, writer);
    await doA.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-1" }),
    }));

    // Simulate a second thread's run (a fresh ToolSandboxDO.fetch call — could even be a
    // different container instance post-restart) reading the same project's workspace.
    let receivedBody: unknown;
    const reader = makeHarness(async (req) => {
      receivedBody = await req.json();
      return Response.json({ ok: true, result: {} });
    });
    const doB = makeDO({ SCRIPTS_R2: r2 }, reader);
    await doB.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-1" }),
    }));

    expect((receivedBody as { workspace_files: Record<string, string> }).workspace_files).toEqual({ "shared.txt": "from-thread-A" });
  });

  it("keeps different projects' workspaces isolated (a project's own prefix only)", async () => {
    r2.store.set("spaces/space1/projects/proj-A/workspace/secret.txt", "A's data");
    let receivedBody: unknown;
    const harness = makeHarness(async (req) => {
      receivedBody = await req.json();
      return Response.json({ ok: true, result: {} });
    });
    const doInstance = makeDO({ SCRIPTS_R2: r2 }, harness);

    await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-B" }),
    }));

    expect((receivedBody as { workspace_files: Record<string, string> }).workspace_files).toEqual({});
  });

  it("falls back to the space-scoped workspace when no projectId is given (the Space Assistant)", async () => {
    r2.store.set("spaces/space1/workspace/notes.txt", "assistant notes");
    let receivedBody: unknown;
    const harness = makeHarness(async (req) => {
      receivedBody = await req.json();
      return Response.json({ ok: true, result: {} });
    });
    const doInstance = makeDO({ SCRIPTS_R2: r2 }, harness);

    await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1" }),
    }));

    expect((receivedBody as { workspace_files: Record<string, string> }).workspace_files).toEqual({ "notes.txt": "assistant notes" });
  });

  it("skips sync entirely when no SCRIPTS_R2 is bound, forwarding the raw request", async () => {
    let receivedBody: unknown;
    const harness = makeHarness(async (req) => {
      receivedBody = await req.json();
      return Response.json({ ok: true, result: {} });
    });
    const doInstance = makeDO({}, harness);

    await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: {}, spaceId: "space1", projectId: "proj-1" }),
    }));

    expect((receivedBody as { workspace_files?: unknown }).workspace_files).toBeUndefined();
  });
});
