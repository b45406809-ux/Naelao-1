import { describe, expect, it, vi } from "vitest";
import {
  type WorkerLoaderBinding,
  type WorkerLoaderModuleConfig,
  buildCodeRunner,
} from "../../workers/agents/src/script-engine/code-runner.js";

// A fake Worker Loader that actually executes the assembled module's `fetch` handler by
// evaluating it with `new Function` — enough to verify the harness wiring (user code +
// fetch wrapper + injected env) without a real CF isolate.
function fakeLoader(
  onConfig?: (config: WorkerLoaderModuleConfig) => void
): WorkerLoaderBinding {
  return {
    get(
      _id: string,
      factory: () =>
        | WorkerLoaderModuleConfig
        | Promise<WorkerLoaderModuleConfig>
    ) {
      return {
        getEntrypoint() {
          return {
            async fetch(req: Request): Promise<Response> {
              const cfg = await factory();
              onConfig?.(cfg);
              const mainModule = cfg.modules["main.js"];
              const source =
                typeof mainModule === "string"
                  ? mainModule
                  : mainModule && "js" in mainModule
                    ? mainModule.js
                    : "";
              const policy = String(cfg.modules["policy.js"] ?? "");
              const guest = String(cfg.modules["guest.js"] ?? "");
              // The production loader evaluates separate ES modules. This lightweight test
              // loader joins the trusted policy, compiled guest, and entry module after removing
              // their known static imports, then strips exports for new Function evaluation.
              const main = source.replace(/^import .*;\s*$/gm, "");
              const body = `${policy}\n${guest}\n${main}`
                .replace(/^import .*;\s*$/gm, "")
                .replace(/export\s+default/, "return")
                .replace(/export\s+/g, "");
              // eslint-disable-next-line no-new-func
              const build = new Function(`${body}`);
              const mod = build() as {
                fetch: (
                  r: Request,
                  env: Record<string, unknown>
                ) => Promise<Response>;
              };
              return mod.fetch(req, cfg.env ?? {});
            },
          } as unknown as Fetcher;
        },
      };
    },
  };
}

function testRunner(options: Parameters<typeof buildCodeRunner>[0] = {}) {
  const runner = buildCodeRunner({
    authorizeContainer: async () => true,
    ...options,
  });
  return {
    ...runner,
    async run(params: Parameters<typeof runner.run>[0]) {
      return runner.run({
        ...params,
        userId: params.userId ?? "test-user",
        runId: params.runId ?? "test-run",
      });
    },
  };
}

describe("code-runner — Tier 2/3 isolate execution", () => {
  it("runs a stored script's exported run() and returns its output", async () => {
    const runner = testRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "double",
      code: "export async function run(args, ctx) { return { doubled: args.n * 2 }; }",
      tier: 2,
      args: { n: 21 },
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ doubled: 42 });
    expect(result.tier).toBe(2);
  });

  it("captures a thrown error from the script as a failed result, not a crash", async () => {
    const runner = testRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "broken",
      code: `export async function run(args, ctx) { throw new Error("boom"); }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("reports unavailable (not a crash) when no LOADER binding is configured", async () => {
    const runner = testRunner({});
    const result = await runner.run({
      name: "x",
      code: "export async function run(){}",
      tier: 2,
      args: {},
      spaceId: "s",
      agentId: "a",
      tenantId: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("Tier 6 (container) is routed separately and reports unavailable without a ToolSandboxDO binding", async () => {
    const runner = testRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "x",
      code: "export async function run(){}",
      tier: 6,
      args: {},
      spaceId: "s",
      agentId: "a",
      tenantId: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tier 6");
  });

  it("Tier 1 is rejected — execution-ladder.ts must handle it in-process, never via codeRunner", async () => {
    const runner = testRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "x",
      code: "export async function run(){}",
      tier: 1,
      args: {},
      spaceId: "s",
      agentId: "a",
      tenantId: "t",
    });
    expect(result.ok).toBe(false);
  });
});

describe("code-runner — isolate capability boundaries", () => {
  it("does not expose ambient network, browser, or MCP access to guest code", async () => {
    let config: WorkerLoaderModuleConfig | undefined;
    const runner = testRunner({
      loader: fakeLoader((value) => {
        config = value;
      }),
      platformSecret: "must-not-enter-guest",
    });
    const result = await runner.run({
      name: "capability-boundary",
      code: "export async function run(args, ctx) { return { fetch: typeof ctx.fetch, browser: typeof ctx.browser, mcp: typeof ctx.mcp, tools: typeof ctx.tools.call }; }",
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      fetch: "undefined",
      browser: "undefined",
      mcp: "undefined",
      tools: "function",
    });
    expect(config?.globalOutbound).toBeNull();
    expect(config?.env).not.toHaveProperty("platformSecret");
    expect(config?.env).not.toHaveProperty("mcpHubWorker");
  });

  it("requires an explicit authorized capability for tool RPC calls", async () => {
    const dispatch = vi.fn(async (name: string, input: unknown) => ({
      name,
      input,
    }));
    const authorize = vi.fn(
      async (name: string) => name === "tool:knowledge.search"
    );
    const runner = testRunner({
      loader: fakeLoader(),
      createRpcBinding: async (options) => ({
        binding: {
          call: async (name, input) => {
            if (!(await options.authorize(name, input)))
              throw new Error(`code_capability_denied:${name}`);
            return options.dispatch(name, input);
          },
        },
        close() {},
      }),
      authorizeCodeCapability: authorize,
      dispatchCodeCapability: dispatch,
    });
    const result = await runner.run({
      name: "scoped-tool-call",
      code: `export async function run(args, ctx) { return ctx.tools.call("knowledge.search", { query: "invoice" }); }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
      capabilities: ["tool:knowledge.search"],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      name: "tool:knowledge.search",
      input: { query: "invoice" },
    });
    expect(authorize).toHaveBeenCalledWith("tool:knowledge.search", {
      query: "invoice",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects ambient imports before isolate execution", async () => {
    const loader = vi.fn(fakeLoader().get);
    const runner = testRunner({ loader: { get: loader } });
    const result = await runner.run({
      name: "ambient-import",
      code: `import secrets from "secrets"; export async function run() { return secrets; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("code_dependency_not_declared");
    expect(loader).not.toHaveBeenCalled();
  });

  it("keeps browser operations behind the host browser grant path", async () => {
    const runner = testRunner({
      loader: fakeLoader(),
      browserWorker: { fetch: vi.fn() } as unknown as Fetcher,
      platformSecret: "shh",
    });
    const result = await runner.run({
      name: "browser-use.navigate",
      code: "",
      tier: 4,
      args: { url: "https://example.com" },
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("browser_runtime_unavailable");
  });
});

describe("code-runner — Tier 6 container execution", () => {
  it("forwards to the ToolSandboxDO's /exec route and returns its result", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { stdout: "hi" } }), {
        status: 200,
      })
    );
    const toolSandbox = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;

    const runner = testRunner({ toolSandbox });
    const result = await runner.run({
      name: "code-exec.execute_bash",
      code: "export async function run(args){ return {stdout:'hi'} }",
      tier: 6,
      args: { commands: "echo hi" },
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ stdout: "hi" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a container-side error without throwing", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "build failed" }), {
        status: 200,
      })
    );
    const toolSandbox = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const runner = testRunner({ toolSandbox });
    const result = await runner.run({
      name: "x",
      code: "bad code",
      tier: 6,
      args: {},
      spaceId: "s",
      agentId: "a",
      tenantId: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("build failed");
  });

  // §A1.17 Phase K: addressed per PROJECT (not per agent) so every thread's agent in the same
  // project shares one container + R2 workspace.
  it("addresses the sandbox DO per project, not per agent — two agents in the same project share one container", async () => {
    const idFromName = vi.fn().mockReturnValue("do-id");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      );
    const toolSandbox = {
      idFromName,
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const runner = testRunner({ toolSandbox });

    await runner.run({
      name: "x",
      code: "c",
      tier: 6,
      args: {},
      spaceId: "space1",
      agentId: "agent-A",
      tenantId: "t",
      projectId: "proj-1",
    });
    await runner.run({
      name: "x",
      code: "c",
      tier: 6,
      args: {},
      spaceId: "space1",
      agentId: "agent-B",
      tenantId: "t",
      projectId: "proj-1",
    });

    expect(idFromName).toHaveBeenNthCalledWith(1, "sandbox:space1:proj-1");
    expect(idFromName).toHaveBeenNthCalledWith(2, "sandbox:space1:proj-1");
  });

  it("falls back to a fixed per-space slot when projectId is absent (the Space Assistant)", async () => {
    const idFromName = vi.fn().mockReturnValue("do-id");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      );
    const toolSandbox = {
      idFromName,
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const runner = testRunner({ toolSandbox });

    await runner.run({
      name: "x",
      code: "c",
      tier: 6,
      args: {},
      spaceId: "space1",
      agentId: "naelao-agent",
      tenantId: "t",
    });

    expect(idFromName).toHaveBeenCalledWith("sandbox:space1:_assistant");
  });

  it("sends spaceId/projectId to the sandbox DO so it can sync the right R2 workspace prefix", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      );
    const toolSandbox = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const runner = testRunner({ toolSandbox });

    await runner.run({
      name: "x",
      code: "c",
      tier: 6,
      args: { a: 1 },
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "t",
      projectId: "proj-1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const req = fetchSpy.mock.calls[0]?.[0] as Request;
    const parsed = await req.json();
    expect(parsed).toMatchObject({ spaceId: "space1", projectId: "proj-1" });
  });
});

// §A1.17 Phase L: a script tagged with a Container Marketplace image routes to that image's OWN
// binding, never the base sandbox — and fails closed (not silently falling back to the base
// sandbox, which would run the script against the wrong image's compute) when unwired.
describe("code-runner — Tier 6 Container Marketplace routing (§A1.17 Phase L)", () => {
  it("fails closed until the host resolves an active installation and image binding", async () => {
    const baseGet = vi.fn();
    const toolSandbox = {
      idFromName: vi.fn(),
      get: baseGet,
    } as unknown as DurableObjectNamespace;
    const runner = testRunner({ toolSandbox });
    const result = await runner.run({
      name: "postgres.query",
      code: "",
      tier: 6,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "t",
      projectId: "proj-1",
      containerImage: "postgres-16",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("container_active_installation_required");
    expect(baseGet).not.toHaveBeenCalled();
  });
});

describe("code-runner — fail-closed escalation", () => {
  it("does not promote ambient imports into a container install", async () => {
    const fetchSpy = vi.fn();
    const toolSandbox = {
      idFromName: vi.fn(),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const approveEscalation = vi.fn(async () => true);
    const runner = testRunner({
      loader: fakeLoader(),
      toolSandbox,
      approveEscalation,
    });
    const result = await runner.run({
      name: "run-package",
      code: `import packageX from "package-x"; export async function run(){ return packageX; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("code_dependency_not_declared");
    expect(approveEscalation).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires actor/run identity even when a container binding and policy callback exist", async () => {
    const toolSandbox = {
      idFromName: vi.fn(),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace;
    const runner = buildCodeRunner({
      toolSandbox,
      authorizeContainer: async () => true,
    });
    const result = await runner.run({
      name: "container",
      code: "",
      tier: 6,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("container_authorized_actor_run_required");
    expect(toolSandbox.get).not.toHaveBeenCalled();
  });
});
