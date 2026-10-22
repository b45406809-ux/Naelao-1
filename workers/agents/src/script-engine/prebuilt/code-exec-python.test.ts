import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { codeExec } from "./code-exec.js";
import { buildCodeRunner, type WorkerLoaderBinding, type WorkerLoaderModuleConfig } from "../code-runner.js";
import type { ScriptEngineEnv } from "../types.js";

// Exercise the actual generated harness in local CPython. The WorkerEntrypoint/Response
// transport is a double; this does not establish Cloudflare Wasm or network enforcement.
function pythonProvider() {
  const configs: WorkerLoaderModuleConfig[] = [];
  const loader: WorkerLoaderBinding = {
    get: (_id, factory) => ({ getEntrypoint: () => ({
      fetch: async (request: Request) => {
        const config = await factory(); configs.push(config);
        const module = config.modules["main.py"];
        if (!module || typeof module === "string" || !("py" in module)) throw new Error("expected Python module");
        const result = spawnSync("python3", ["-c", `
import asyncio, json, sys, types
payload = json.load(sys.stdin)
workers = types.ModuleType('workers')
workers.WorkerEntrypoint = type('WorkerEntrypoint', (), {})
class Response:
    def __init__(self, body, headers=None): self.body = body
workers.Response = Response
sys.modules['workers'] = workers
namespace = {}
exec(payload['source'], namespace)
class Request:
    async def json(self): return payload['body']
response = asyncio.run(namespace['Default']().fetch(Request()))
sys.stdout.write(response.body)
`], { input: JSON.stringify({ source: module.py, body: await request.json() }), encoding: "utf8", timeout: 2000 });
        if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
        return new Response(result.stdout, { headers: { "content-type": "application/json" } });
      },
    } as unknown as Fetcher) }),
  };
  return { loader, configs };
}

function context(options: Parameters<typeof buildCodeRunner>[0]) {
  return { env: {
    tenantId: "tenant-1", spaceId: "space-1", agentId: "agent-1", maxTier: 2,
    codeRunner: buildCodeRunner(options),
  } as ScriptEngineEnv, run: async () => undefined };
}

describe("bounded lightweight Python execution", () => {
  it("executes arithmetic with input and stdout without allocating native compute", async () => {
    const fixture = pythonProvider(), allocate = vi.fn();
    const ctx = context({ loader: fixture.loader, pythonEnabled: true, toolSandbox: { idFromName: allocate } as unknown as DurableObjectNamespace });
    const result = await codeExec.operations["code.execute_python"]({ code: "print(args['name'])\nresult = 6 * 7", input: { name: "hello" }, timeout: 1 }, ctx);
    expect(result).toMatchObject({ stdout: "hello\n", result: 42, actual_tier: 2, engine: "isolate", runtime_receipt: { backend: "python-wasm", cost_source: "unreported" } });
    expect(fixture.configs[0]?.globalOutbound).toBeNull();
    expect(fixture.configs[0]?.env).not.toHaveProperty("PLATFORM_SECRET");
    expect(allocate).not.toHaveBeenCalled();
    const again = await codeExec.operations["code.execute_python"]({ code: "result = 'name' in globals()" }, ctx);
    expect(again).toMatchObject({ result: false });
  });

  it("reports execution failures and contains oversized Python output", async () => {
    const ctx = context({ loader: pythonProvider().loader, pythonEnabled: true });
    await expect(codeExec.operations["code.execute_python"]({ code: "raise ValueError('invalid data')" }, ctx)).rejects.toThrow("invalid data");
    await expect(codeExec.operations["code.execute_python"]({ code: "print('x' * 100000)" }, ctx)).rejects.toThrow("code_output_limit");
    await expect(codeExec.operations["code.execute_python"]({ code: "import nonexistent_package_for_test" }, ctx)).rejects.toMatchObject({ capability_error: { required_tier: 6 } });
  });

  it("uses the requested deadline and releases capacity after a hung provider", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const loader = { get: () => ({ getEntrypoint: () => ({ fetch }) }) } as unknown as WorkerLoaderBinding;
    const ctx = context({ loader, pythonEnabled: true, maxConcurrentPerTenant: 1, isolateTimeoutMs: 5000 });
    await expect(codeExec.operations["code.execute_python"]({ code: "result = 42", timeout: 0.1 }, ctx)).rejects.toThrow("code_cancelled_or_timed_out");
    await expect(codeExec.operations["code.execute_python"]({ code: "result = 42", timeout: 0.1 }, ctx)).rejects.toThrow("code_cancelled_or_timed_out");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid inputs and never falls back on missing runtimes or pip requests", async () => {
    const allocate = vi.fn(), fixture = pythonProvider();
    const ctx = context({ loader: fixture.loader, pythonEnabled: true, toolSandbox: { idFromName: allocate } as unknown as DurableObjectNamespace });
    for (const timeout of [0, -1, 31, Infinity, "1"]) {
      expect(() => codeExec.operations["code.execute_python"]({ code: "result = 1", timeout }, ctx)).toThrow("python_timeout_invalid");
    }
    expect(() => codeExec.operations["code.execute_python"]({ code: " " }, ctx)).toThrow("code is required");
    expect(fixture.configs).toHaveLength(0);
    await expect(codeExec.operations["code.execute_python"]({ code: "result = 1", install_deps: ["pandas"] }, ctx)).rejects.toThrow("pinned_dependency_artifact_unavailable");
    await expect(codeExec.operations["code.execute_python"]({ code: "result = 1" }, context({ loader: fixture.loader }))).rejects.toThrow("python_wasm_unavailable");
    expect(allocate).not.toHaveBeenCalled();
  });
});
