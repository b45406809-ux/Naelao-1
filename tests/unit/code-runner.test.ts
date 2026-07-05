import { describe, it, expect, vi } from "vitest";
import { buildCodeRunner, type WorkerLoaderBinding, type WorkerLoaderModuleConfig } from "../../workers/agents/src/script-engine/code-runner.js";
import { verifyInternalToken } from "@naelao/http";

// A fake Worker Loader that actually executes the assembled module's `fetch` handler by
// evaluating it with `new Function` — enough to verify the harness wiring (user code +
// fetch wrapper + injected env) without a real CF isolate.
function fakeLoader(): WorkerLoaderBinding {
  return {
    get(_id: string, factory: () => WorkerLoaderModuleConfig | Promise<WorkerLoaderModuleConfig>) {
      return {
        getEntrypoint() {
          return {
            async fetch(req: Request): Promise<Response> {
              const cfg = await factory();
              const source = cfg.modules["main.js"]!;
              // Strip ESM export syntax so the source runs as a plain function body: the
              // harness's `export default {...}` becomes `return {...}`, and the user code's
              // `export async function run(...)` becomes a plain (still-hoisted) declaration.
              const body = source.replace(/export\s+default/, "return").replace(/export\s+/g, "");
              // eslint-disable-next-line no-new-func
              const build = new Function(`${body}`);
              const mod = build() as { fetch: (r: Request, env: Record<string, unknown>) => Promise<Response> };
              return mod.fetch(req, cfg.env ?? {});
            },
          } as unknown as Fetcher;
        },
      };
    },
  };
}

describe("code-runner — Tier 2/3 isolate execution", () => {
  it("runs a stored script's exported run() and returns its output", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "double",
      code: `export async function run(args, ctx) { return { doubled: args.n * 2 }; }`,
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
    const runner = buildCodeRunner({ loader: fakeLoader() });
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
    const runner = buildCodeRunner({});
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 2, args: {}, spaceId: "s", agentId: "a", tenantId: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("Tier 5 (container) is routed separately and reports unavailable without a ToolSandboxDO binding", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 5, args: {}, spaceId: "s", agentId: "a", tenantId: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tier 5");
  });

  it("Tier 1 is rejected — execution-ladder.ts must handle it in-process, never via codeRunner", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 1, args: {}, spaceId: "s", agentId: "a", tenantId: "t" });
    expect(result.ok).toBe(false);
  });
});

describe("code-runner — F10 SSRF guard inside the isolate", () => {
  it("blocks ctx.fetch to a literal link-local/metadata address", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "ssrf-attempt",
      code: `export async function run(args, ctx) { await ctx.fetch("http://169.254.169.254/latest/meta-data"); return "unreachable"; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ssrf_blocked");
  });

  it("also blocks a bare fetch() call (not just ctx.fetch) — global fetch is overridden too", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "ssrf-attempt-bare",
      code: `export async function run(args, ctx) { await fetch("http://10.0.0.5/"); return "unreachable"; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ssrf_blocked");
  });

  it("blocks a non-http(s) protocol", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "ssrf-file-protocol",
      code: `export async function run(args, ctx) { await ctx.fetch("file:///etc/passwd"); return "unreachable"; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ssrf_blocked");
  });
});

describe("code-runner — Tier 4 browser capability injection", () => {
  it("injects ctx.browser.navigate proxied to the BROWSER_WORKER binding", async () => {
    const navigateSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://example.com", text: "hello" }), { status: 200 })
    );
    const browserWorker = { fetch: navigateSpy } as unknown as Fetcher;

    const runner = buildCodeRunner({ loader: fakeLoader(), browserWorker, platformSecret: "shh" });
    const result = await runner.run({
      name: "browse",
      code: `export async function run(args, ctx) { return await ctx.browser.navigate({ url: args.url }); }`,
      tier: 4,
      args: { url: "https://example.com" },
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ url: "https://example.com", text: "hello" });
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it("Tier 4 reports unavailable without a browserWorker binding", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 4, args: {}, spaceId: "s", agentId: "a", tenantId: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tier 4");
  });
});

// §A1.17 Phase I: ctx.mcp lets ONE authored script deterministically chain several MCP servers
// (get data from A, act on B) instead of that composition only happening across multiple
// model-driven reasoning-loop turns. The isolate never receives a credential — mcp-hub still
// resolves auth server-side — it receives only a short-lived (60s), tenant-scoped internal
// token, minted in real TS before the isolate is constructed, never the platform secret itself.
describe("code-runner — Tier 2 ctx.mcp capability injection (§A1.17 Phase I)", () => {
  it("injects ctx.mcp proxied to the MCP_HUB binding with a verified internal token", async () => {
    const hubSpy = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/mcp-servers") && req.method === "GET") {
        return new Response(JSON.stringify({ data: [{ id: "srv-1", name: "whop" }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/tools/call")) {
        const body = await req.json<{ tool_name: string; input: unknown }>();
        return new Response(JSON.stringify({ result: { echoed: body.tool_name } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const mcpHubWorker = { fetch: hubSpy } as unknown as Fetcher;

    const runner = buildCodeRunner({ loader: fakeLoader(), mcpHubWorker, platformSecret: "shh" });
    const result = await runner.run({
      name: "single-mcp-call",
      code: `export async function run(args, ctx) { return await ctx.mcp.call("whop", "list_members", {}); }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ result: { echoed: "list_members" } });

    // Every hub call carried a token verifiable against the caller's own tenant.
    for (const call of hubSpy.mock.calls) {
      const req = call[0] as Request;
      const token = req.headers.get("x-naelao-internal-token");
      expect(await verifyInternalToken(token ?? undefined, "tenant1", "shh")).toBe(true);
    }
  });

  it("one script chains TWO different MCP servers deterministically — the core multi-MCP ask", async () => {
    const hubSpy = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/mcp-servers")) {
        return new Response(JSON.stringify({ data: [{ id: "srv-a", name: "server-a" }, { id: "srv-b", name: "server-b" }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/tools/call")) {
        const body = await req.json<{ tool_name: string; input: Record<string, unknown> }>();
        if (url.pathname.includes("srv-a")) return new Response(JSON.stringify({ result: { value: 42 } }), { status: 200 });
        if (url.pathname.includes("srv-b")) return new Response(JSON.stringify({ result: { acked: body.input["value"] } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const mcpHubWorker = { fetch: hubSpy } as unknown as Fetcher;

    const runner = buildCodeRunner({ loader: fakeLoader(), mcpHubWorker, platformSecret: "shh" });
    const result = await runner.run({
      name: "multi-mcp-chain",
      code: `
        export async function run(args, ctx) {
          const a = await ctx.mcp.call("server-a", "get_value", {});
          const b = await ctx.mcp.call("server-b", "act_on_value", { value: a.result.value });
          return { chained: b.result.acked };
        }
      `,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ chained: 42 });
  });

  it("ctx.mcp.list_servers/list_tools work without a tool call", async () => {
    const hubSpy = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/mcp-servers")) {
        return new Response(JSON.stringify({ data: [{ id: "srv-1", name: "whop" }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/tools")) {
        return new Response(JSON.stringify({ tools: [{ name: "list_members" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const mcpHubWorker = { fetch: hubSpy } as unknown as Fetcher;
    const runner = buildCodeRunner({ loader: fakeLoader(), mcpHubWorker, platformSecret: "shh" });
    const result = await runner.run({
      name: "list-mcp",
      code: `export async function run(args, ctx) { const servers = await ctx.mcp.list_servers(); const tools = await ctx.mcp.list_tools("whop"); return { servers, tools }; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ servers: [{ id: "srv-1", name: "whop" }], tools: { tools: [{ name: "list_members" }] } });
  });

  it("ctx.mcp is absent (not a crash) when no mcpHubWorker binding is configured", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({
      name: "no-mcp",
      code: `export async function run(args, ctx) { return typeof ctx.mcp; }`,
      tier: 2,
      args: {},
      spaceId: "space1",
      agentId: "agent1",
      tenantId: "tenant1",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("undefined");
  });
});

describe("code-runner — Tier 5 container execution", () => {
  it("forwards to the ToolSandboxDO's /exec route and returns its result", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { stdout: "hi" } }), { status: 200 }));
    const toolSandbox = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;

    const runner = buildCodeRunner({ toolSandbox });
    const result = await runner.run({
      name: "code-exec.execute_bash",
      code: "export async function run(args){ return {stdout:'hi'} }",
      tier: 5,
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
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "build failed" }), { status: 200 }));
    const toolSandbox = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const runner = buildCodeRunner({ toolSandbox });
    const result = await runner.run({ name: "x", code: "bad code", tier: 5, args: {}, spaceId: "s", agentId: "a", tenantId: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("build failed");
  });

  // §A1.17 Phase K: addressed per PROJECT (not per agent) so every thread's agent in the same
  // project shares one container + R2 workspace.
  it("addresses the sandbox DO per project, not per agent — two agents in the same project share one container", async () => {
    const idFromName = vi.fn().mockReturnValue("do-id");
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    const toolSandbox = { idFromName, get: vi.fn().mockReturnValue({ fetch: fetchSpy }) } as unknown as DurableObjectNamespace;
    const runner = buildCodeRunner({ toolSandbox });

    await runner.run({ name: "x", code: "c", tier: 5, args: {}, spaceId: "space1", agentId: "agent-A", tenantId: "t", projectId: "proj-1" });
    await runner.run({ name: "x", code: "c", tier: 5, args: {}, spaceId: "space1", agentId: "agent-B", tenantId: "t", projectId: "proj-1" });

    expect(idFromName).toHaveBeenNthCalledWith(1, "sandbox:space1:proj-1");
    expect(idFromName).toHaveBeenNthCalledWith(2, "sandbox:space1:proj-1");
  });

  it("falls back to a fixed per-space slot when projectId is absent (the Space Assistant)", async () => {
    const idFromName = vi.fn().mockReturnValue("do-id");
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    const toolSandbox = { idFromName, get: vi.fn().mockReturnValue({ fetch: fetchSpy }) } as unknown as DurableObjectNamespace;
    const runner = buildCodeRunner({ toolSandbox });

    await runner.run({ name: "x", code: "c", tier: 5, args: {}, spaceId: "space1", agentId: "naelao-agent", tenantId: "t" });

    expect(idFromName).toHaveBeenCalledWith("sandbox:space1:_assistant");
  });

  it("sends spaceId/projectId to the sandbox DO so it can sync the right R2 workspace prefix", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    const toolSandbox = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: fetchSpy }),
    } as unknown as DurableObjectNamespace;
    const runner = buildCodeRunner({ toolSandbox });

    await runner.run({ name: "x", code: "c", tier: 5, args: { a: 1 }, spaceId: "space1", agentId: "agent1", tenantId: "t", projectId: "proj-1" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const req = fetchSpy.mock.calls[0]![0] as Request;
    const parsed = await req.json();
    expect(parsed).toMatchObject({ spaceId: "space1", projectId: "proj-1" });
  });
});
