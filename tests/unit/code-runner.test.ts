import { describe, it, expect, vi } from "vitest";
import { buildCodeRunner, type WorkerLoaderBinding, type WorkerLoaderModuleConfig } from "../../workers/agents/src/script-engine/code-runner.js";

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
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("reports unavailable (not a crash) when no LOADER binding is configured", async () => {
    const runner = buildCodeRunner({});
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 2, args: {}, spaceId: "s", agentId: "a" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("Tier 5 (container) is routed separately and reports unavailable without a ToolSandboxDO binding", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 5, args: {}, spaceId: "s", agentId: "a" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tier 5");
  });

  it("Tier 1 is rejected — execution-ladder.ts must handle it in-process, never via codeRunner", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 1, args: {}, spaceId: "s", agentId: "a" });
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
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ url: "https://example.com", text: "hello" });
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it("Tier 4 reports unavailable without a browserWorker binding", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    const result = await runner.run({ name: "x", code: "export async function run(){}", tier: 4, args: {}, spaceId: "s", agentId: "a" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tier 4");
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
    const result = await runner.run({ name: "x", code: "bad code", tier: 5, args: {}, spaceId: "s", agentId: "a" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("build failed");
  });
});
