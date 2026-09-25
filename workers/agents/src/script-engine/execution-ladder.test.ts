import { describe, expect, it, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";
import { runStoredScript, tierLabel } from "./execution-ladder.js";
import type { ScriptEngineEnv, StoredScript } from "./types.js";

describe("Execution Ladder & Code Runner", () => {
  it("maps tier labels accurately across all 6 tiers", () => {
    expect(tierLabel(1)).toBe("T1 direct-vfs");
    expect(tierLabel(2)).toBe("T2 v8-isolate");
    expect(tierLabel(3)).toBe("T3 workflow");
    expect(tierLabel(4)).toBe("T4 kitesurf-browser");
    expect(tierLabel(5)).toBe("T5 chromium-browser");
    expect(tierLabel(6)).toBe("T6 container-sandbox");
  });

  it("routes browser scripts to Kitesurf with fallback to Chromium", async () => {
    const calls = [];
    const mockBrowserWorker = {
      fetch: vi.fn(async (req) => {
        const body = await req.json();
        calls.push(body.engine ?? "unknown");
        if (body.engine === "kitesurf") {
          return Response.json(
            { message: "Unsupported DOM feature" },
            { status: 400 }
          );
        }
        return Response.json({ ok: true, result: { title: "Rendered page" } });
      }),
    };

    const runner = buildCodeRunner({
      browserWorker: mockBrowserWorker,
      platformSecret: "secret",
    });

    const res = await runner.run({
      name: "scrape",
      code: "",
      tier: 4,
      args: { url: "https://example.com" },
      spaceId: "s1",
      agentId: "a1",
      tenantId: "t1",
    });

    expect(calls).toEqual(["kitesurf", "chromium"]);
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({
      engine: "chromium",
      fallback_reason: expect.stringContaining("elevated to Chromium"),
    });
  });

  it("auto-elevates directly to Chromium when screenshots or WebGL are required", async () => {
    const calls = [];
    const mockBrowserWorker = {
      fetch: vi.fn(async (req) => {
        const body = await req.json();
        calls.push(body.engine ?? "unknown");
        return Response.json({ ok: true, result: { screenshot: "png-data" } });
      }),
    };

    const runner = buildCodeRunner({
      browserWorker: mockBrowserWorker,
      platformSecret: "secret",
    });

    const res = await runner.run({
      name: "screenshot-test",
      code: "",
      tier: 4,
      args: { url: "https://example.com", needsScreenshot: true },
      spaceId: "s1",
      agentId: "a1",
      tenantId: "t1",
    });

    expect(calls).toEqual(["chromium"]);
    expect(res.ok).toBe(true);
  });

  it("dispatches durable workflow scripts via workflowRunner", async () => {
    const startMock = vi.fn(async () => ({ id: "wf-123" }));
    const env = {
      scriptsBucket: {},
      spaceId: "s1",
      agentId: "a1",
      tenantId: "t1",
      workflowRunner: {
        start: startMock,
        status: vi.fn(),
      },
    };

    const script = {
      metadata: {
        name: "sync-job",
        version: 1,
        domain: "orchestration",
        description: "cron job",
        tags: [],
        fingerprint_schema: {},
        preconditions: [],
        parameters: [],
        calls: [],
        requires_tier: 3,
        runtime: "workflow",
        success_count: 0,
        failure_count: 0,
        patch_history: [],
        stability_score: 1,
        origin: "prebuilt",
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      code: "export async function run() {}",
    };

    const res = await runStoredScript(env, script, { foo: "bar" });
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sync-job" })
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({
      workflow_id: "wf-123",
      status: "started",
    });
  });
});
