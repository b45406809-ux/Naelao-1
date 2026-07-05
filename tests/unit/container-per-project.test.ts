import { describe, it, expect } from "vitest";
import { ToolSandboxDO } from "../../workers/agents/src/do/ToolSandboxDO.js";

// §A1.17 Phase R: ToolSandboxDO no longer does any R2 sync of its own — Phase K's blind
// full-materialize/collect around every /exec call (bounded 300 files/2MB/25MB, paid on EVERY
// call whether or not a script touches files) is gone. The container's own /workspace disk now
// persists across calls to the SAME warm instance with zero R2 traffic, and starts genuinely
// empty on a cold start; an agent moves files between R2 and the container explicitly via the
// `workspace` prebuilt (see workspace-prebuilt.test.ts), which talks to the new
// /workspace/{read,write,list,delete} routes this DO now just proxies straight through to the
// harness — this file only exercises that proxying + cold-start + honest-degradation behavior.

function makeHarness(handler: (req: Request) => Promise<Response>) {
  return {
    running: true,
    started: false,
    start(this: { started: boolean }) { this.started = true; },
    getTcpPort() {
      return { fetch: handler };
    },
  };
}

function makeDO(container: ReturnType<typeof makeHarness> | undefined) {
  const ctx = { container };
  return new ToolSandboxDO(ctx as never, {} as never);
}

describe("ToolSandboxDO — pure proxy to the harness (§A1.17 Phase R)", () => {
  it("forwards /exec to the harness verbatim, with no workspace_files sync of any kind", async () => {
    let receivedBody: unknown;
    const harness = makeHarness(async (req) => {
      receivedBody = await req.json();
      return Response.json({ ok: true, result: {} });
    });
    const doInstance = makeDO(harness);

    await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST",
      body: JSON.stringify({ name: "s", code: "c", args: { x: 1 } }),
    }));

    expect(receivedBody).toEqual({ name: "s", code: "c", args: { x: 1 } });
    expect((receivedBody as Record<string, unknown>)).not.toHaveProperty("workspace_files");
  });

  it("forwards each /workspace/* route straight through to the harness", async () => {
    const seenPaths: string[] = [];
    const harness = makeHarness(async (req) => {
      seenPaths.push(new URL(req.url).pathname);
      return Response.json({ ok: true });
    });
    const doInstance = makeDO(harness);

    for (const path of ["/workspace/read", "/workspace/write", "/workspace/list", "/workspace/delete"]) {
      await doInstance.fetch(new Request(`http://sandbox${path}`, { method: "POST", body: "{}" }));
    }

    expect(seenPaths).toEqual(["/workspace/read", "/workspace/write", "/workspace/list", "/workspace/delete"]);
  });

  it("cold-starts the container on demand when it isn't already running", async () => {
    const harness = makeHarness(async () => Response.json({ ok: true }));
    harness.running = false;
    const doInstance = makeDO(harness);

    await doInstance.fetch(new Request("http://sandbox/exec", { method: "POST", body: "{}" }));

    expect(harness.started).toBe(true);
  });

  it("does not restart an already-running container", async () => {
    const harness = makeHarness(async () => Response.json({ ok: true }));
    harness.running = true;
    const doInstance = makeDO(harness);

    await doInstance.fetch(new Request("http://sandbox/exec", { method: "POST", body: "{}" }));

    expect(harness.started).toBe(false);
  });

  it("degrades honestly (503) for /exec when no container runtime is bound", async () => {
    const doInstance = makeDO(undefined);
    const resp = await doInstance.fetch(new Request("http://sandbox/exec", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(503);
    const body = await resp.json<{ built: boolean; tests_passed: boolean }>();
    expect(body.built).toBe(false);
  });

  it("degrades honestly (503) for a /workspace/* route when no container runtime is bound", async () => {
    const doInstance = makeDO(undefined);
    const resp = await doInstance.fetch(new Request("http://sandbox/workspace/list", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(503);
    const body = await resp.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
  });
});
