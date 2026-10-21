import { describe, it, expect } from "vitest";
import { ToolSandboxDO } from "../../workers/agents/src/do/ToolSandboxDO.js";

// ToolSandboxDO requests require an authenticated, time-bounded invocation scope before the DO
// can start or proxy to the container. These tests assert the unauthenticated boundary; the
// workspace prebuilt and CodeRunner suites cover the authorized workspace/runtime contracts.

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
  const ctx = {
    container,
    storage: {
      put: async () => undefined,
      setAlarm: async () => undefined,
    },
  };
  return new ToolSandboxDO(ctx as never, {} as never);
}

describe("ToolSandboxDO — fail-closed invocation boundary", () => {
  it("rejects an unscoped /exec without forwarding its body to the harness", async () => {
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

    expect(receivedBody).toBeUndefined();
    expect((await doInstance.fetch(new Request("http://sandbox/exec", {
      method: "POST", body: JSON.stringify({ name: "s", code: "c", args: { x: 1 } }),
    }))).status).toBe(403);
  });

  it("rejects unscoped workspace routes without contacting the harness", async () => {
    const seenPaths: string[] = [];
    const harness = makeHarness(async (req) => {
      seenPaths.push(new URL(req.url).pathname);
      return Response.json({ ok: true });
    });
    const doInstance = makeDO(harness);

    for (const path of ["/workspace/read", "/workspace/write", "/workspace/list", "/workspace/delete"]) {
      const response = await doInstance.fetch(new Request(`http://sandbox${path}`, { method: "POST", body: "{}" }));
      expect(response.status).toBe(403);
    }

    expect(seenPaths).toEqual([]);
  });

  it("does not cold-start a container for an unscoped invocation", async () => {
    const harness = makeHarness(async () => Response.json({ ok: true }));
    harness.running = false;
    const doInstance = makeDO(harness);

    await doInstance.fetch(new Request("http://sandbox/exec", { method: "POST", body: "{}" }));

    expect(harness.started).toBe(false);
  });

  it("does not restart an already-running container", async () => {
    const harness = makeHarness(async () => Response.json({ ok: true }));
    harness.running = true;
    const doInstance = makeDO(harness);

    await doInstance.fetch(new Request("http://sandbox/exec", { method: "POST", body: "{}" }));

    expect(harness.started).toBe(false);
  });

  it("rejects an unscoped /exec before reporting container availability", async () => {
    const doInstance = makeDO(undefined);
    const resp = await doInstance.fetch(new Request("http://sandbox/exec", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(403);
  });

  it("rejects an unscoped workspace route before reporting container availability", async () => {
    const doInstance = makeDO(undefined);
    const resp = await doInstance.fetch(new Request("http://sandbox/workspace/list", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(403);
  });
});
