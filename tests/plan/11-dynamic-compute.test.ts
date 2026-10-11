import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import ts from "typescript";
import { buildCodeRunner, type WorkerLoaderModuleConfig, type WorkerLoaderBinding } from "../../workers/agents/src/script-engine/code-runner.js";
import { compileDynamicCode } from "../../workers/agents/src/script-engine/dynamic-code.js";
import { createScopedCodeRpc, redactCodeValue } from "../../packages/agent-sdk/src/runtime-context.js";

const params = { name: "test.compute", tier: 2 as const, code: "export function run(args) { return args.value * 2; }",
  args: { value: 21 }, tenantId: "tenant-one", spaceId: "space-one", agentId: "worker-one" };

// This provider double executes JS in a fresh VM. Live Python and loopbacks remain deployment checks.
function provider() {
  const configs: WorkerLoaderModuleConfig[] = [];
  const loader: WorkerLoaderBinding = {
    get: (_id, factory) => {
      const pending = Promise.resolve(factory());
      return { getEntrypoint: () => ({ fetch: async (request: Request) => {
        const config = await pending; configs.push(config);
        if (config.mainModule.endsWith(".py")) return Response.json({ ok: false, error: "python_fixture_has_no_wasm" });
        const source = config.modules["guest.js"];
        const javascript = typeof source === "string" ? source : source && "js" in source ? source.js : "";
        const guest = ts.transpileModule(javascript, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const context = vm.createContext({ exports: {}, args: (await request.json() as { args: unknown }).args });
        try {
          new vm.Script(guest).runInContext(context, { timeout: config.limits?.cpuMs ?? 100 });
          const result = await new vm.Script("exports.run(args, Object.freeze({}))").runInContext(context, { timeout: config.limits?.cpuMs ?? 100 });
          return Response.json({ ok: true, result });
        } catch (error) { return Response.json({ ok: false, error: String(error) }); }
      } } as unknown as Fetcher) };
    },
  };
  return { loader, configs };
}

describe("Step 11 isolated computation", () => {
  it("executes TypeScript and pins a SHA-256 immutable artifact", async () => {
    const fixture = provider(), runner = buildCodeRunner({ loader: fixture.loader });
    const result = await runner.run({ ...params, code: "export function run(args: {value:number}): number { return args.value * 2; }" });
    expect(result.ok).toBe(true); expect(result.output).toBe(42);
    expect(result.runtime_receipt?.code_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.runtime_receipt?.cost_source).toBe("unreported");
    expect(fixture.configs[0]?.globalOutbound).toBeNull();
    expect(fixture.configs[0]?.env).not.toHaveProperty("PLATFORM_SECRET");
  });
  it("rejects ambient imports and malformed modules before allocating a worker", async () => {
    const fixture = provider(), runner = buildCodeRunner({ loader: fixture.loader });
    expect((await runner.run({ ...params, code: 'import fs from "node:fs"; export function run(){return fs;}' })).ok).toBe(false);
    expect((await runner.run({ ...params, code: "export function run( {" })).ok).toBe(false);
    expect(fixture.configs).toHaveLength(0);
  });
  it("caches immutable compilation, never invocation globals or bindings", async () => {
    const source = "let calls=0; export function run(){return ++calls;}";
    expect(await compileDynamicCode(source)).toBe(await compileDynamicCode(source));
    const fixture = provider(), runner = buildCodeRunner({ loader: fixture.loader });
    expect((await runner.run({ ...params, code: source })).output).toBe(1);
    expect((await runner.run({ ...params, code: source, tenantId: "tenant-two" })).output).toBe(1);
  });
  it("bounds a non-yielding loop through provider CPU limits", async () => {
    const fixture = provider();
    const result = await buildCodeRunner({ loader: fixture.loader }).run({ ...params, code: "export function run(){while(true){}}", limits: { cpuMs: 10 } });
    expect(result.ok).toBe(false); expect(result.error).toMatch(/timed out/);
    expect(fixture.configs[0]?.limits?.cpuMs).toBe(10);
  });
  it("contains oversized results and denies unsupported smaller memory quotas", async () => {
    const fixture = provider(), runner = buildCodeRunner({ loader: fixture.loader });
    expect((await runner.run({ ...params, code: 'export function run(){return "x".repeat(5000);}', limits: { outputBytes: 128 } })).error).toBe("code_output_limit");
    expect((await runner.run({ ...params, limits: { memoryMb: 32 } })).capability_error?.code).toBe("isolate_memory_quota_unsupported");
  });
  it("cancels a hung fetch and releases loader slots", async () => {
    const controller = new AbortController();
    const loader = { get: () => ({ getEntrypoint: () => ({ fetch: () => new Promise(() => {}) }) }) } as unknown as WorkerLoaderBinding;
    const runner = buildCodeRunner({ loader, maxConcurrentPerTenant: 1 });
    const result = runner.run({ ...params, signal: controller.signal });
    await Promise.resolve(); controller.abort();
    expect((await result).ok).toBe(false);
    expect((await runner.run({ ...params, limits: { wallMs: 1 } })).error).toBe("code_cancelled_or_timed_out");
  });
  it("requests provider Python/Wasm and never bootstraps remote CDN packages", async () => {
    const fixture = provider();
    await buildCodeRunner({ loader: fixture.loader, pythonEnabled: true }).run({ ...params, name: "code-exec.execute_python", language: "python", args: { code: "result = 6 * 7" } });
    expect(fixture.configs[0]?.mainModule).toBe("main.py");
    expect(fixture.configs[0]?.compatibilityFlags).toContain("python_workers");
    expect(JSON.stringify(fixture.configs[0])).not.toMatch(/esm\.sh|cdn\.jsdelivr/);
  });
  it("does not spend a container on dependency errors without explicit policy approval", async () => {
    const allocate = vi.fn();
    const result = await buildCodeRunner({ loader: provider().loader, pythonEnabled: true, toolSandbox: { idFromName: allocate } as unknown as DurableObjectNamespace })
      .run({ ...params, name: "code-exec.execute_python", args: { code: "import native_lib", install_deps: ["native_lib"] }, maxTier: 6 });
    expect(result.capability_error?.required_tier).toBe(6); expect(allocate).not.toHaveBeenCalled();
  });
  it("reauthorizes RPCs, redacts results and rejects calls after cancellation", async () => {
    const controller = new AbortController(), dispatch = vi.fn(async () => ({ api_key: "sensitive", value: 1 }));
    let active = true;
    const call = createScopedCodeRpc({ scope: params, capabilities: ["tool:list"], signal: controller.signal, authorize: async () => active, dispatch });
    expect(await call("tool:list", {})).toEqual({ api_key: "[redacted]", value: 1 });
    active = false; await expect(call("tool:list", {})).rejects.toThrow("denied");
    active = true; controller.abort(); await expect(call("tool:list", {})).rejects.toThrow("closed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(redactCodeValue({ note: "secret-value" }, 1024, ["secret-value"])).toEqual({ note: "[redacted]" });
  });
});
