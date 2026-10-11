import { describe, expect, it, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";
import {
  classifyExecutionRoute,
  classifyExecutionRouteWithSentry,
  requiresNativeCompilation,
  runStoredScript,
  tierLabel,
} from "./execution-ladder.js";
import { browserTextReceipt } from "./prebuilt/browser-use.js";
import { dynamicWorkflow } from "./prebuilt/dynamic-workflow.js";
import { decisionTools } from "./reasoner.js";
import { buildUniversalBody } from "../shared/ai-client.js";
import type { ScriptEngineEnv, StoredScript } from "./types.js";
import { interceptPlatformCli } from "./virtual-cli.js";

describe("Execution Ladder & Code Runner", () => {
  it("exposes only the all-CLI model action surface", () => {
    expect(decisionTools(undefined).map((tool) => tool.name)).toEqual([
      "Bash",
      "AskUser",
      "Read",
      "Edit",
    ]);
  });
  it("classifies all six engines and sends native work straight to Tier 6", () => {
    expect(classifyExecutionRoute("cat package.json")).toMatchObject({
      tier: 1,
      engine: "sqlite_fs",
    });
    expect(classifyExecutionRoute("node script.ts")).toMatchObject({
      tier: 2,
      engine: "isolate",
    });
    expect(classifyExecutionRoute("workflow run nightly")).toMatchObject({
      tier: 3,
      engine: "workflow",
    });
    expect(classifyExecutionRoute("browse https://example.com")).toMatchObject({
      tier: 4,
      engine: "kitesurf",
    });
    expect(
      classifyExecutionRoute("browse https://example.com --screenshot")
    ).toMatchObject({ tier: 5, engine: "chromium" });
    expect(classifyExecutionRoute("cargo build --release")).toMatchObject({
      tier: 6,
      engine: "container",
    });
    expect(requiresNativeCompilation("npm install @tensorflow/tfjs-node")).toBe(
      true
    );
  });

  it("routes pure Python to Pyodide and native imports to the container", () => {
    expect(
      classifyExecutionRoute('python3 -c "import math; print(math.pi)"')
    ).toMatchObject({ tier: 2 });
    expect(classifyExecutionRoute('python3 -c "import torch"')).toMatchObject({
      tier: 6,
    });
  });

  it("keeps browse screenshots out of context until see is requested", () => {
    expect(interceptPlatformCli("browse https://example.com")).toEqual({
      operation: "browser.navigate",
      params: {
        url: "https://example.com",
        save_screenshot: true,
        accessibility_text: true,
      },
    });
    expect(interceptPlatformCli('see --crop "10,20,30,40"')).toEqual({
      operation: "browser.see",
      params: { path: "latest", crop: "10,20,30,40" },
    });
    expect(
      browserTextReceipt({
        accessibility_text: "Page",
        screenshot: "base64-secret",
        screenshot_path: "/tmp/latest.png",
      })
    ).toEqual({
      accessibility_text: "Page",
      screenshot_path: "/tmp/latest.png",
      screenshot_saved: true,
    });
  });

  it("preserves scoped command namespaces", () => {
    expect(interceptPlatformCli("avos chore repomix-pack")?.operation).toBe(
      "avos.chore"
    );
    expect(interceptPlatformCli("ext:tree-sitter query User")?.operation).toBe(
      "ext:tree-sitter"
    );
    expect(interceptPlatformCli("auto:stripe-sync trigger")?.operation).toBe(
      "auto:stripe-sync"
    );
  });

  it("lets System One elevate an ambiguous command but never lower deterministic native work", async () => {
    const noul = vi.fn(async () => ({ kind: "noul" as const, value: true, probability: 0.91, confidence: 0.91, provider: "jev" as const, model: "jev-1.13.0", policyCode: "execution_native_preflight_v1" }));
    await expect(classifyExecutionRouteWithSentry("node opaque-addon.js", { noul })).resolves.toMatchObject({ tier: 6, engine: "container", reason: "jev_native_preflight", sentry: { provider: "jev" } });
    await expect(classifyExecutionRouteWithSentry("cargo build", { noul })).resolves.toMatchObject({ tier: 6, reason: "deterministic_native_preflight" });
    expect(noul).toHaveBeenCalledTimes(1);
  });

  it("falls back to the deterministic route when System One is unavailable", async () => {
    const noul = vi.fn(async () => { throw new Error("offline"); });
    await expect(classifyExecutionRouteWithSentry("node app.js", { noul })).resolves.toMatchObject({ tier: 2, engine: "isolate", reason: "isolate_runtime" });
  });
  it("keeps native planner actions on compatibility retries", () => {
    const body = JSON.parse(buildUniversalBody({
      apiKey: "",
      gatewayOpts: { accountId: "account", gatewayId: "gateway" },
      ctx: { spaceId: "space" },
      query: { model: "model", max_tokens: 100, system: "", messages: [] },
      tools: decisionTools(undefined),
      toolChoice: "auto",
      compatibilityMode: "minimal",
    })) as { tools?: Array<{ function?: { name?: string } }>; tool_choice?: string };
    expect(body.tools?.map((tool) => tool.function?.name)).toContain("AskUser");
    expect(body.tool_choice).toBe("auto");
  });

  it("keeps planner coordination behind explicit Bash commands", () => {
    expect(interceptPlatformCli("naelao project agents list")).toEqual({
      operation: "thread.list_project_agents", params: {},
    });
    expect(interceptPlatformCli('naelao project agents consult --agent-id worker-1 --message "Check the build"')).toEqual({
      operation: "thread.consult", params: { agent_id: "worker-1", message: "Check the build" },
    });
    expect(interceptPlatformCli('naelao project agents delegate --agent-id worker-1 --task "Fix the test"')).toEqual({
      operation: "thread.delegate", params: { agent_id: "worker-1", task: "Fix the test" },
    });
    expect(interceptPlatformCli("naelao worker project_manager_worker project.create --params '{\"name\":\"Demo\"}'")).toEqual({
      operation: "delegate_to_space_worker",
      params: { worker_id: "project_manager_worker", task: { operation: "project.create", params: { name: "Demo" } } },
    });
    expect(interceptPlatformCli('naelao worker project_manager_worker project.create --params {"name":"Demo"}')).toEqual({
      operation: "delegate_to_space_worker",
      params: { worker_id: "project_manager_worker", task: { operation: "project.create", params: { name: "Demo" } } },
    });
    expect(interceptPlatformCli('naelao worker project_manager_worker project.create --params "{\"name\":\"Demo\"}"')).toEqual({
      operation: "delegate_to_space_worker",
      params: { worker_id: "project_manager_worker", task: { operation: "project.create", params: { name: "Demo" } } },
    });
  });

  it("detaches workflows with pristine context and a two-line receipt", async () => {
    const workflowRun = vi.fn(async () => ({ id: "run-123" }));
    const result = (await dynamicWorkflow.operations["workflow.run"]?.(
      { name: "nightly.ts", detach: true },
      {
        env: {
          scriptsBucket: {} as R2Bucket,
          spaceId: "s",
          projectId: "p",
          tenantId: "t",
          agentId: "a",
          orchestration: { workflowRun },
        },
        run: async () => undefined,
      }
    )) as { result: { id: string }; receipt_card: { lines: string[] } };
    expect(result.result.id).toBe("run-123");
    expect(result.receipt_card.lines).toHaveLength(2);
    expect(workflowRun).toHaveBeenCalledWith(
      "nightly.ts",
      {},
      expect.objectContaining({
        detach: true,
        maxContextTokens: 2_000,
        contextSources: ["task_payload", "target_files", "SOUL.md"],
        inheritChatHistory: false,
      })
    );
  });
  it("validates extension IDs before routing vertical workflows", async () => {
    const context = {
      env: {
        scriptsBucket: {} as R2Bucket,
        spaceId: "s",
        projectId: "p",
        tenantId: "t",
        agentId: "a",
        orchestration: { workflowRun: vi.fn() },
      },
      run: async () => undefined,
    };

    await expect(
      dynamicWorkflow.operations["workflow.run"]?.(
        {
          name: "index.ts",
          workflow_class: "vertical_extension",
          extension_id: "legacy-plugin",
        },
        context
      )
    ).rejects.toThrow("invalid_extension_id:legacy-plugin");
  });
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

  it("blocks browser and cloud container egress for air-gapped spaces", async () => {
    const browserWorker = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const toolSandbox = {
      idFromName: vi.fn(() => ({ toString: () => "sandbox" })),
      get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ ok: true })) })),
    };
    const runner = buildCodeRunner({ airGappedOnly: true, browserWorker, toolSandbox: toolSandbox as never });

    const browser = await runner.run({ name: "scrape", code: "", tier: 4, args: { url: "https://example.com" }, spaceId: "s1", agentId: "a1", tenantId: "t1" });
    const container = await runner.run({ name: "Bash", code: "curl https://example.com", tier: 6, args: {}, spaceId: "s1", agentId: "a1", tenantId: "t1" });

    expect(browser).toMatchObject({ ok: false, error: expect.stringContaining("compliance_violation") });
    expect(container).toMatchObject({ ok: false, error: expect.stringContaining("local workstation") });
    expect(browserWorker.fetch).not.toHaveBeenCalled();
    expect(toolSandbox.get).not.toHaveBeenCalled();
  });

  it("addresses speculative Tier 6 runs by branch-isolated sandbox", async () => {
    const ids: string[] = [];
    const toolSandbox = {
      idFromName: vi.fn((name: string) => {
        ids.push(name);
        return { toString: () => name };
      }),
      get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ ok: true, result: "done" })) })),
    };
    const runner = buildCodeRunner({ toolSandbox: toolSandbox as never });

    const result = await runner.run({
      name: "Bash",
      code: "echo candidate",
      tier: 6,
      args: { commands: "echo candidate" },
      spaceId: "s1",
      agentId: "a1",
      tenantId: "t1",
      projectId: "p1",
      workspaceBranch: "race/task/model-a",
    });

    expect(result.ok).toBe(true);
    expect(ids).toEqual(["sandbox:s1:p1:branch:race/task/model-a"]);
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
