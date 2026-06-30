/**
 * The concrete Execution Ladder backend (spec bottom appendix §8) — implements
 * `TieredCodeRunner` for tiers 2-5. Tier 1 (R2) is handled in-process by execution-ladder.ts
 * and never reaches here.
 *
 *   Tier 2 — V8 Isolate (CF Worker Loader): TS/JS + HTTP fetch. No filesystem, no native bins.
 *   Tier 3 — Tier 2 + best-effort ESM package resolution (fetched from a CDN at call time and
 *            injected as an extra module — there is no real "npm install" inside an isolate).
 *   Tier 4 — Tier 2 isolate with a `ctx.browser` capability proxied to the naelao-browser
 *            Worker (CF Browser Rendering). Agents never get raw CDP (spec §8 note).
 *   Tier 5 — ToolSandboxDO (CF Container, full Linux) generic /exec route.
 *
 * Stored script code is a TypeScript/JS module exporting a named `run`:
 *   export async function run(args, ctx) { ... return result; }
 * `ctx` always exposes `fetch`; Tier 4 additionally exposes `browser.navigate(...)`.
 *
 * The CF Worker Loader binding (`worker_loaders`) is a 2025 beta primitive — not yet in
 * @cloudflare/workers-types, so its shape is declared locally (same pattern ToolSandboxDO
 * uses for the Container runtime). When the binding is absent (older account / local dev
 * without it configured) tiers 2-4 degrade honestly to "unavailable", matching every other
 * optional binding in this engine (AI, Vectorize, MCP_HUB, ...).
 */

import type { TieredCodeRunner, ScriptRunResult, ExecutionTier } from "./types.js";

// ── CF Worker Loader binding (beta) — minimal local typing ─────────────────────────────

export interface WorkerLoaderModuleConfig {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  /** Bindings visible to the dynamically loaded code as `env`. Passed by reference. */
  env?: Record<string, unknown>;
  /** Restrict outbound fetch from the loaded worker; null disables outbound entirely. */
  globalOutbound?: Fetcher | null;
}

export interface WorkerLoaderStub {
  getEntrypoint(name?: string, options?: { props?: Record<string, unknown> }): Fetcher;
}

export interface WorkerLoaderBinding {
  get(id: string, factory: () => WorkerLoaderModuleConfig | Promise<WorkerLoaderModuleConfig>): WorkerLoaderStub;
}

// ── Options the host (NaelaoAgentDO) supplies when constructing the runner ─────────────

export interface CodeRunnerOptions {
  /** The worker_loaders binding. Tiers 2-4 are unavailable without it. */
  loader?: WorkerLoaderBinding;
  /** naelao-browser service binding (Tier 4). */
  browserWorker?: Fetcher;
  /** Shared internal token the browser worker requires (x-naelao-internal-token). */
  platformSecret?: string;
  /** ToolSandboxDO namespace (Tier 5). */
  toolSandbox?: DurableObjectNamespace;
  /** Per-call wall-clock timeout for isolate tiers (2-4). Default 15s. */
  isolateTimeoutMs?: number;
  /** Per-call wall-clock timeout for the container tier (5). Default 60s. */
  containerTimeoutMs?: number;
}

const DEFAULT_ISOLATE_TIMEOUT_MS = 15_000;
const DEFAULT_CONTAINER_TIMEOUT_MS = 60_000;
const ISOLATE_COMPAT_DATE = "2024-12-01";

/** Bare (non-relative) import specifiers a Tier-3 script wants resolved from a CDN. */
function extractBarePackageImports(code: string): string[] {
  const specs = new Set<string>();
  const importRe = /\bimport\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"'.][^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code))) {
    const spec = m[1];
    if (spec && !spec.startsWith(".") && !spec.startsWith("naelao:")) specs.add(spec);
  }
  return [...specs];
}

/** Builds the single-file isolate module: user code + a fetch() harness appended. */
function buildIsolateModule(userCode: string): string {
  return `${userCode}

export default {
  async fetch(request, env) {
    const { args } = await request.json();
    const ctx = { fetch: (...a) => fetch(...a) };
    if (env.__BROWSER__) {
      ctx.browser = {
        navigate: async (req) => {
          const r = await env.__BROWSER__.fetch("http://browser/v1/browser/navigate", {
            method: "POST",
            headers: { "content-type": "application/json", "x-naelao-internal-token": env.__BROWSER_TOKEN__ || "" },
            body: JSON.stringify(req),
          });
          const body = await r.json();
          if (!r.ok) throw new Error("browser.navigate failed: " + (body && body.message ? body.message : r.status));
          return body;
        },
      };
    }
    if (typeof run !== "function") {
      return Response.json({ ok: false, error: "script must export an async function named 'run'" }, { status: 500 });
    }
    try {
      const result = await run(args, ctx);
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json({ ok: false, error: String((err && err.message) || err) }, { status: 500 });
    }
  },
};
`;
}

/** Fetch a package's ESM bundle from esm.sh for Tier-3 best-effort npm resolution. */
async function fetchEsmModule(pkg: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://esm.sh/${encodeURIComponent(pkg)}`, {
      headers: { accept: "application/javascript,text/javascript" },
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

async function runIsolate(
  opts: CodeRunnerOptions,
  params: { name: string; code: string; tier: ExecutionTier; args: Record<string, unknown>; spaceId: string; agentId: string }
): Promise<ScriptRunResult> {
  const started = Date.now();
  if (!opts.loader) {
    return {
      ok: false,
      error: `Tier ${params.tier} is unavailable: no worker_loaders binding configured in this environment`,
      tier: params.tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  const modules: Record<string, string> = { "main.js": buildIsolateModule(params.code) };

  // Tier 3: best-effort resolve bare-specifier imports from a CDN as extra virtual modules.
  if (params.tier === 3) {
    const pkgs = extractBarePackageImports(params.code);
    for (const pkg of pkgs) {
      const src = await fetchEsmModule(pkg);
      if (src) modules[pkg] = src;
    }
  }

  const env: Record<string, unknown> = {};
  if (params.tier === 4) {
    if (!opts.browserWorker) {
      return {
        ok: false,
        error: "Tier 4 is unavailable: no naelao-browser service binding configured",
        tier: params.tier,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    env.__BROWSER__ = opts.browserWorker;
    env.__BROWSER_TOKEN__ = opts.platformSecret ?? "";
  }

  // One isolate per (space, script, code revision) — never share isolates across spaces.
  const lockId = `${params.spaceId}:${params.name}:${hashCode(params.code)}`;

  try {
    const stub = opts.loader.get(lockId, () => ({
      compatibilityDate: ISOLATE_COMPAT_DATE,
      mainModule: "main.js",
      modules,
      env,
    }));
    const entrypoint = stub.getEntrypoint();

    const controller = new AbortController();
    const timeoutMs = opts.isolateTimeoutMs ?? DEFAULT_ISOLATE_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await entrypoint.fetch(
        new Request("http://script/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args: params.args }),
          signal: controller.signal,
        })
      );
      const body = await resp.json<{ ok: boolean; result?: unknown; error?: string }>();
      return {
        ok: body.ok,
        ...(body.ok ? { output: body.result } : { error: body.error ?? `isolate returned ${resp.status}` }),
        tier: params.tier,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `Tier ${params.tier} execution timed out` : String(err instanceof Error ? err.message : err),
      tier: params.tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
}

async function runContainer(
  opts: CodeRunnerOptions,
  params: { name: string; code: string; args: Record<string, unknown>; spaceId: string; agentId: string }
): Promise<ScriptRunResult> {
  const started = Date.now();
  if (!opts.toolSandbox) {
    return {
      ok: false,
      error: "Tier 5 is unavailable: no ToolSandboxDO (TOOL_SANDBOX) binding configured",
      tier: 5,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  const doId = opts.toolSandbox.idFromName(`sandbox:${params.spaceId}:${params.agentId}`);
  const stub = opts.toolSandbox.get(doId);

  const controller = new AbortController();
  const timeoutMs = opts.containerTimeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await stub.fetch(
      new Request("http://sandbox/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: params.name, code: params.code, args: params.args }),
        signal: controller.signal,
      })
    );
    const body = await resp.json<{ ok: boolean; result?: unknown; error?: string; logs?: string }>();
    return {
      ok: resp.ok && body.ok,
      ...(resp.ok && body.ok ? { output: body.result } : { error: body.error ?? `container returned ${resp.status}` }),
      tier: 5,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "Tier 5 execution timed out" : String(err instanceof Error ? err.message : err),
      tier: 5,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap deterministic string hash (FNV-1a) — used only to key isolate reuse, not security. */
function hashCode(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Builds the TieredCodeRunner the host (NaelaoAgentDO) wires into ScriptEngineEnv.codeRunner. */
export function buildCodeRunner(opts: CodeRunnerOptions): TieredCodeRunner {
  return {
    async run(params) {
      if (params.tier === 5) return runContainer(opts, params);
      if (params.tier === 2 || params.tier === 3 || params.tier === 4) return runIsolate(opts, params);
      return {
        ok: false,
        error: `Tier ${params.tier} has no codeRunner backend (Tier 1 must be handled in-process)`,
        tier: params.tier,
        duration_ms: 0,
        tokens_used: 0,
      };
    },
  };
}
