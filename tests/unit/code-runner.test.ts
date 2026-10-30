import { describe, it, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { createScopedCodeRpc } from "@naelao/agent-sdk";
import { buildCodeRunner, type WorkerLoaderBinding, type WorkerLoaderModuleConfig } from "../../workers/agents/src/script-engine/code-runner.js";

/** Execute just the compiled guest module. The trusted harness remains exercised through its
 * public request/response contract, while this loader never evaluates host-provided source. */
function fakeLoader(): WorkerLoaderBinding {
  return {
    load(config: WorkerLoaderModuleConfig) {
      return {
        getEntrypoint() {
          return {
            async fetch(request: Request): Promise<Response> {
              const source = config.modules["guest.js"];
              const main = config.modules["main.js"];
              if (typeof source !== "string" || typeof main !== "string") throw new Error("guest module missing");
              const guestBody = source.replace(/\bexport\s+(?=(async\s+)?function\s+run\b)/g, "");
              // Worker Loader isolates do not inherit Node's ambient fetch. Execute the guest in
              // a separate VM context so this mock models the production network boundary instead
              // of accidentally giving untrusted code the test runner's global fetch.
              const run = runInNewContext(`${guestBody}; run`, { fetch: undefined }) as (args: unknown, ctx: Record<string, any>) => Promise<unknown>;
              const mainBody = main
                .replace(/^import .* from ['"]\.\/policy\.js['"];\s*$/m, "")
                .replace(/^import .* from ['"]\.\/guest\.js['"];\s*$/m, "")
                .replace(/\bexport\s+default\b/, "return");
              // Run the production harness source with only its two static imports linked to
              // the compiled guest and immutable policy helpers, as the Worker Loader does.
              // eslint-disable-next-line no-new-func
              const entrypoint = new Function("run", "encode", "freeze", "jsonResponse", "byteLength", mainBody)(
                run, JSON.stringify.bind(JSON), Object.freeze.bind(Object), Response.json.bind(Response),
                (text: string) => new TextEncoder().encode(text).byteLength,
              ) as { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
              return entrypoint.fetch(request, config.env ?? {});
            },
          } as unknown as Fetcher;
        },
      };
    },
    get() { throw new Error("legacy loader path should not be used"); },
  };
}

const scope = { spaceId: "space1", agentId: "agent1", tenantId: "tenant1" };

describe("code-runner isolate boundary", () => {
  it("runs the exported run function in a fresh loader config and returns its output", async () => {
    const load = vi.fn((config: WorkerLoaderModuleConfig) => fakeLoader().load!(config));
    const result = await buildCodeRunner({ loader: { load, get: vi.fn() } }).run({
      ...scope, name: "double", code: "export async function run(args) { return { doubled: args.n * 2 }; }", tier: 2, args: { n: 21 },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ doubled: 42 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0].globalOutbound).toBeNull();
  });

  it("returns guest exceptions as failed results", async () => {
    const result = await buildCodeRunner({ loader: fakeLoader() }).run({
      ...scope, name: "broken", code: 'export async function run() { throw new Error("boom"); }', tier: 2, args: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("denies ambient fetch and bare fetch without exposing a host network function", async () => {
    const ctxResult = await buildCodeRunner({ loader: fakeLoader() }).run({
      ...scope, name: "no-fetch", code: "export async function run(args, ctx) { return typeof ctx.fetch; }", tier: 2, args: {},
    });
    expect(ctxResult).toMatchObject({ ok: true, output: "undefined" });
    const bareResult = await buildCodeRunner({ loader: fakeLoader() }).run({
      ...scope, name: "bare-fetch", code: "export async function run() { return fetch('http://169.254.169.254/'); }", tier: 2, args: {},
    });
    expect(bareResult.ok).toBe(false);
  });

  it("allows only explicitly granted RPC capabilities and forwards operation payload", async () => {
    const dispatch = vi.fn(async (_scope, capability: string, input: unknown) => ({ capability, input }));
    const createRpcBinding = vi.fn(async (options: any) => ({
      binding: { call: createScopedCodeRpc(options) }, close: vi.fn(),
    }));
    const runner = buildCodeRunner({
      loader: fakeLoader(), createRpcBinding, authorizeCodeCapability: async (_scope, cap) => cap === "tool:search", dispatchCodeCapability: dispatch,
      codeTools: () => [{ name: "search", description: "Search authorized messages" }],
    });
    const allowed = await runner.run({ ...scope, name: "search", code: "export async function run(args, ctx) { return ctx.cli.run(['search', '--params', JSON.stringify({ q: args.q })]); }", tier: 2, args: { q: "old messages" }, capabilities: ["tool:search"] });
    expect(allowed.ok).toBe(true);
    expect(allowed.output).toEqual({ capability: "tool:search", input: { q: "old messages" } });

    const denied = await buildCodeRunner({ loader: fakeLoader() }).run({
      ...scope, name: "no-proxy", code: "export async function run(args, ctx) { return ctx.proxy.request({ url: 'https://example.com' }); }", tier: 2, args: {},
    });
    expect(denied).toMatchObject({ ok: false, error: "code_capability_denied:proxy.request" });
  });

  it("rejects ambient imports, dynamic code, and missing run exports before execution", async () => {
    const runner = buildCodeRunner({ loader: fakeLoader() });
    for (const [code, expected] of [
      ["import x from 'x'; export async function run() { return x; }", "code_dependency_not_declared"],
      ["export async function run() { return eval('1'); }", "code_dynamic_import_forbidden"],
      ["export const other = 1", "code_run_export_required"],
    ]) {
      const result = await runner.run({ ...scope, name: "invalid", code, tier: 2, args: {} });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(expected);
    }
  });

  it("rejects overlarge source and request payloads before loader dispatch", async () => {
    const load = vi.fn(() => fakeLoader().load!({}));
    const runner = buildCodeRunner({ loader: { load, get: vi.fn() } });
    const oversizedSource = await runner.run({ ...scope, name: "large-source", code: `export async function run() { return '${"x".repeat(262_145)}'; }`, tier: 2, args: {} });
    expect(oversizedSource.error).toContain("code_source_limit");
    const oversizedInput = await runner.run({ ...scope, name: "large-input", code: "export async function run() { return null; }", tier: 2, args: { value: "x".repeat(2048) }, limits: { inputBytes: 1024 } });
    expect(oversizedInput.error).toContain("code_input_limit");
    expect(load).not.toHaveBeenCalled();
  });

  it("bounds guest output before returning it to the planner", async () => {
    const result = await buildCodeRunner({ loader: fakeLoader() }).run({
      ...scope, name: "large-output", code: `export async function run() { return 'x'.repeat(70_000); }`, tier: 2, args: {},
    });
    expect(result).toMatchObject({ ok: false, error: "code_output_limit" });
  });

  it("fails closed when the loader is absent and rejects Tier 1 dispatch", async () => {
    const runner = buildCodeRunner({});
    expect((await runner.run({ ...scope, name: "x", code: "export async function run() {}", tier: 2, args: {} })).error).toContain("unavailable");
    expect((await runner.run({ ...scope, name: "x", code: "export async function run() {}", tier: 1, args: {} })).ok).toBe(false);
  });
});

describe("code-runner privileged execution", () => {
  function sandbox(response = { ok: true, result: { stdout: "done" } }) {
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    const namespace = { idFromName: vi.fn().mockReturnValue("sandbox-id"), get: vi.fn().mockReturnValue({ fetch }) } as unknown as DurableObjectNamespace;
    return { namespace, fetch };
  }
  const actor = { ...scope, userId: "human-1", runId: "run-1", maxTier: 6 as const };

  it("requires a real actor, run, execution ceiling, and host authorization for Tier 6", async () => {
    const { namespace, fetch } = sandbox();
    const denied = await buildCodeRunner({ toolSandbox: namespace, authorizeContainer: async () => false }).run({ ...actor, name: "exec", code: "", tier: 6, args: {} });
    expect(denied.error).toBe("container_execution_denied");
    expect(fetch).not.toHaveBeenCalled();
    const missingActor = await buildCodeRunner({ toolSandbox: namespace, authorizeContainer: async () => true }).run({ ...actor, userId: undefined, name: "exec", code: "", tier: 6, args: {} });
    expect(missingActor.error).toBe("container_authorized_actor_run_required");
  });

  it("routes an authorized Tier 6 request to the project sandbox", async () => {
    const { namespace, fetch } = sandbox();
    const result = await buildCodeRunner({ toolSandbox: namespace, authorizeContainer: async () => true }).run({ ...actor, projectId: "p1", name: "exec", code: "", tier: 6, args: { commands: "echo done" } });
    expect(result).toMatchObject({ ok: true, output: { stdout: "done" }, tier: 6 });
    expect(namespace.idFromName).toHaveBeenCalledWith("sandbox:space1:p1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("only escalates an isolate capability that requires Tier 6 after explicit approval", async () => {
    const { namespace, fetch } = sandbox();
    const approveEscalation = vi.fn(async () => true);
    const result = await buildCodeRunner({ loader: fakeLoader(), toolSandbox: namespace, authorizeContainer: async () => true, approveEscalation }).run({
      ...actor, name: "needs-package", code: "export async function run() { return 1; }", tier: 2, args: {}, dependencies: ["pinned-package"],
    });
    expect(approveEscalation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, tier: 6, output: { stdout: "done" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not promote when approval is absent", async () => {
    const { namespace, fetch } = sandbox();
    const result = await buildCodeRunner({ loader: fakeLoader(), toolSandbox: namespace, authorizeContainer: async () => true }).run({
      ...actor, name: "needs-package", code: "export async function run() { return 1; }", tier: 2, args: {}, dependencies: ["pinned-package"],
    });
    expect(result.error).toContain("pinned_dependency_artifact_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("code-runner browser authorization", () => {
  it("requires actor/run scope and operation authorization before contacting browser worker", async () => {
    const fetch = vi.fn();
    const result = await buildCodeRunner({
      browserWorker: { fetch } as unknown as Fetcher, platformSecret: "test-secret", authorizeBrowser: async () => false,
    }).run({ ...scope, userId: "human-1", runId: "run-1", name: "browser-use.navigate", code: "", tier: 4, args: { url: "https://example.com" } });
    expect(result.error).toBe("browser_operation_not_authorized");
    expect(fetch).not.toHaveBeenCalled();
  });
});
