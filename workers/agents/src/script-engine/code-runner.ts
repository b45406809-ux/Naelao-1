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
 * §A1.17 Phase I — `ctx.mcp` (Code Mode, Tiers 2-4): when the host wires a `mcpHubWorker`
 * binding, every isolate ALSO gets `ctx.mcp.{call,list_servers,list_tools}`, looping back to the
 * SAME `naelao-mcp-hub` worker the `mcp-connector` prebuilt already uses — so ONE authored
 * script can deterministically chain several MCP servers (get data from A, act on B) instead of
 * that composition living only in the model-driven, one-op-per-turn reasoning loop. The isolate
 * never receives a credential: mcp-hub still resolves auth server-side exactly as it does for
 * the prebuilt path. What the isolate DOES receive is a short-lived (60s), tenant-scoped internal
 * token minted just before isolate construction — never the platform secret itself — so the
 * mcp-hub's `requireInternalHmac` gate is satisfied without widening what a compromised script
 * could do with it.
 *
 * The CF Worker Loader binding (`worker_loaders`) is a 2025 beta primitive — not yet in
 * @cloudflare/workers-types, so its shape is declared locally (same pattern ToolSandboxDO
 * uses for the Container runtime). When the binding is absent (older account / local dev
 * without it configured) tiers 2-4 degrade honestly to "unavailable", matching every other
 * optional binding in this engine (AI, Vectorize, MCP_HUB, ...).
 */

import { mintInternalToken } from "@naelao/http";
import type {
  ExecutionTier,
  ScriptRunResult,
  TieredCodeRunner,
} from "./types.js";
import { requiresNativeCompilation } from "./execution-ladder.js";

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
  getEntrypoint(
    name?: string,
    options?: { props?: Record<string, unknown> }
  ): Fetcher;
}

export interface WorkerLoaderBinding {
  get(
    id: string,
    factory: () => WorkerLoaderModuleConfig | Promise<WorkerLoaderModuleConfig>
  ): WorkerLoaderStub;
}

// ── Options the host (NaelaoAgentDO) supplies when constructing the runner ─────────────

export interface CodeRunnerOptions {
  /** The worker_loaders binding. Tiers 2-4 are unavailable without it. */
  loader?: WorkerLoaderBinding;
  /** naelao-browser service binding (Tier 4). */
  browserWorker?: Fetcher;
  /** naelao-mcp-hub service binding — powers Tiers 2-4's ctx.mcp (§A1.17 Phase I). */
  mcpHubWorker?: Fetcher;
  /** Used to mint short-lived internal tokens for the browser/mcp-hub loopbacks — never handed
   *  to the isolate directly. */
  platformSecret?: string;
  /** ToolSandboxDO namespace (Tier 5, the Phase K base per-project sandbox). */
  toolSandbox?: DurableObjectNamespace;
  /** §A1.17 Phase L: Container Marketplace image id -> its own DO namespace binding. Empty/absent
   *  today — every catalogue image ships `available:false` (see container-catalogue.ts) until a
   *  real Dockerfile + persistence strategy + wrangler binding lands for it. */
  containerImages?: Record<string, DurableObjectNamespace>;
  /** Per-call wall-clock timeout for isolate tiers (2-4). Default 15s. */
  isolateTimeoutMs?: number;
  /** Per-call wall-clock timeout for the container tier (5). Default 60s. */
  containerTimeoutMs?: number;
}

const DEFAULT_ISOLATE_TIMEOUT_MS = 15_000;
const DEFAULT_CONTAINER_TIMEOUT_MS = 60_000;
const ISOLATE_COMPAT_DATE = "2024-12-01";

/**
 * Execution Ladder auto-promotion (AVOS plan, step 3): a Tier 2-4 isolate has NO real OS, no
 * `npm`/`pip`, and (at Tier 2) no package resolution at all — Tier 3's own CDN-ESM-shim
 * (extractBarePackageImports, above) is already the isolate's best attempt at "install a
 * package," and Tier 4 adds only a browser proxy, not a filesystem. So a script whose failure is
 * genuinely "this isolate structurally cannot do that" (an unresolved import — the isolate has
 * no module the CDN shim could find, or Tier 2 didn't even try) is a real, deterministic signal
 * that Tier 5 (a real container: real npm/pip, real files) can plausibly succeed where the
 * isolate never could. Deliberately narrow, and deliberately does NOT include a plain execution
 * timeout: a script that's slow or genuinely stuck is not obviously fixed by a cold-starting
 * container with a longer (60s vs 15s) but still finite timeout — retrying there risks doubling
 * the wall-clock cost of something that was always going to fail, for no real capability gain.
 */
const ISOLATE_PROMOTION_ERROR_PATTERNS = [
  /cannot find module/i,
  /failed to resolve (specifier|module)/i,
  /no such module/i,
  /module not found/i,
  /No module named/i,
  /ImportError.*native/i,
  /native.*required/i,
];

/** Bare (non-relative) import specifiers a Tier-3 script wants resolved from a CDN. */
function extractBarePackageImports(code: string): string[] {
  const specs = new Set<string>();
  const importRe =
    /\bimport\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"'.][^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code))) {
    const spec = m[1];
    if (spec && !spec.startsWith(".") && !spec.startsWith("naelao:"))
      specs.add(spec);
  }
  return [...specs];
}

// F10: the isolate previously handed scripts a raw, unguarded `fetch` — any Tier 2/3/4
// script could reach internal-only addresses (e.g. 169.254.169.254) with no SSRF check at
// all. This module runs as standalone JS text inside a CF Worker Loader isolate (no bundler,
// no imports beyond what's in `modules`), so the guard can't be pulled in from
// @naelao/security — it's inlined here and kept in sync with that package's logic by hand.
// `globalThis.fetch` is overridden (not just `ctx.fetch`) so a script that calls bare
// `fetch(...)` directly — bypassing the `ctx` convention — is still guarded.
const SSRF_GUARD_PRELUDE = `
const __realFetch = fetch;
const __SSRF_BLOCKED_RE = [/^localhost$/i, /^127\\./, /^0\\.0\\.0\\.0$/, /^::1$/, /^169\\.254\\./, /^10\\./, /^172\\.(1[6-9]|2\\d|3[01])\\./, /^192\\.168\\./, /^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./, /^fc00:/i, /^fd00:/i, /^fe80:/i, /^0\\./];
function __isBlockedHost(h) {
  return __SSRF_BLOCKED_RE.some((re) => re.test(h)) || h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".localhost");
}
async function __resolveIps(hostname) {
  try {
    const q = (type) => __realFetch("https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(hostname) + "&type=" + type, { headers: { accept: "application/dns-json" } }).then((r) => r.ok ? r.json() : null).catch(() => null);
    const [a, aaaa] = await Promise.all([q("A"), q("AAAA")]);
    const answers = [...((a && a.Answer) || []), ...((aaaa && aaaa.Answer) || [])];
    return answers.map((x) => x.data).filter(Boolean);
  } catch { return []; }
}
async function __ssrfGuardedFetch(...args) {
  const req = args[0];
  const rawUrl = typeof req === "string" ? req : (req && req.url) || "";
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("ssrf_blocked: invalid URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("ssrf_blocked: protocol " + parsed.protocol + " not allowed");
  const hostname = parsed.hostname.toLowerCase();
  if (__isBlockedHost(hostname)) throw new Error("ssrf_blocked: host " + hostname + " not allowed");
  const resolved = await __resolveIps(hostname);
  if (resolved.some(__isBlockedHost)) throw new Error("ssrf_blocked: host " + hostname + " resolves to a blocked address");
  return __realFetch(...args);
}
globalThis.fetch = __ssrfGuardedFetch;
`;

/** Builds the single-file isolate module: SSRF guard prelude + user code + a fetch() harness. */
function buildIsolateModule(userCode: string): string {
  return `${SSRF_GUARD_PRELUDE}
${userCode}

export default {
  async fetch(request, env) {
    const { args } = await request.json();
    const ctx = { fetch: (...a) => __ssrfGuardedFetch(...a) };
    if (env.__BROWSER__) {
      ctx.browser = {
        navigate: async (req) => {
          const r = await env.__BROWSER__.fetch("http://browser/v1/browser/navigate", {
            method: "POST",
            headers: { "content-type": "application/json", "x-naelao-internal-token": env.__BROWSER_TOKEN__ || "" },
            body: JSON.stringify({ engine: env.__BROWSER_ENGINE__ || "kitesurf", ...(typeof req === "string" ? { url: req } : req) }),
          });
          const body = await r.json();
          if (!r.ok) throw new Error("browser.navigate failed: " + (body && body.message ? body.message : r.status));
          return body;
        },
      };
    }
    if (env.__MCP_HUB__) {
      const mcpHeaders = () => ({
        "content-type": "application/json",
        "x-naelao-tenant-id": env.__MCP_TENANT__ || "",
        "x-naelao-user-id": env.__MCP_USER__ || "",
        "x-naelao-agent-id": env.__MCP_AGENT__ || "",
        "x-naelao-project-id": env.__MCP_PROJECT__ || "",
        "x-naelao-internal-token": env.__MCP_TOKEN__ || "",
      });
      const mcpFetch = async (path, init) => {
        const r = await env.__MCP_HUB__.fetch(new Request("http://mcp-hub/v1/spaces/" + env.__MCP_SPACE__ + path, {
          method: init.method,
          headers: mcpHeaders(),
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        }));
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((body && body.message) || ("mcp-hub " + path + " failed: " + r.status));
        return body;
      };
      const resolveServerId = async (ref) => {
        const listed = await mcpFetch("/mcp-servers", { method: "GET" });
        const servers = (listed && listed.data) || [];
        const match = servers.find((s) => s.id === ref) || servers.find((s) => s.name === ref);
        if (!match) throw new Error("ctx.mcp: no registered server named '" + ref + "'");
        return match.id;
      };
      ctx.mcp = {
        list_servers: async () => {
          const listed = await mcpFetch("/mcp-servers", { method: "GET" });
          return listed.data || [];
        },
        list_tools: async (server) => {
          const id = await resolveServerId(server);
          return mcpFetch("/mcp-servers/" + id + "/tools", { method: "GET" });
        },
        call: async (server, tool, params) => {
          const id = await resolveServerId(server);
          return mcpFetch("/mcp-servers/" + id + "/tools/call", { method: "POST", body: { tool_name: tool, input: params || {} } });
        },
      };
      ctx.connectors = {
        call: async (alias, tool, params, requiredScopes) => {
          const headers = mcpHeaders();
          if (Array.isArray(requiredScopes) && requiredScopes.length) headers["x-naelao-required-scopes"] = requiredScopes.join(",");
          const r = await env.__MCP_HUB__.fetch(new Request("http://mcp-hub/v1/spaces/" + env.__MCP_SPACE__ + "/connector-aliases/" + encodeURIComponent(alias) + "/tools/call", {
            method: "POST", headers, body: JSON.stringify({ tool_name: tool, input: params || {} }),
          }));
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((body && body.message) || ("connector alias call failed: " + r.status));
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

/** Pyodide is loaded inside the dynamic Worker, never in the orchestration worker. Stdout is
 * captured explicitly so Python has the same result contract as the Linux harness. */
function buildPythonIsolateModule(): string {
  return `${SSRF_GUARD_PRELUDE}
import { loadPyodide } from "pyodide";
let __runtime;
export default {
  async fetch(request) {
    const { args } = await request.json();
    const lines = [];
    __runtime ||= loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/",
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    try {
      const pyodide = await __runtime;
      const result = await pyodide.runPythonAsync(String(args.code || ""));
      return Response.json({ ok: true, result: { stdout: lines.join("\\n"), result: result == null ? null : String(result) } });
    } catch (err) {
      return Response.json({ ok: false, error: String((err && err.message) || err) }, { status: 500 });
    }
  },
};`;
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
  params: {
    name: string;
    code: string;
    tier: ExecutionTier;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
    tenantId: string;
    userId?: string;
    // Widened to accept (and, on auto-promotion, forward) the same optional fields
    // runContainer expects — absent for the overwhelming majority of Tier 2-4 calls.
    projectId?: string;
  }
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

  const python = params.name === "code-exec.execute_python";
  const modules: Record<string, string> = {
    "main.js": python ? buildPythonIsolateModule() : buildIsolateModule(params.code),
  };

  if (python) {
    const pyodideModule = await fetchEsmModule("pyodide@0.27.7");
    if (!pyodideModule) {
      return { ok: false, error: "Pyodide module could not be loaded", tier: 2, actual_tier: 2, engine: "isolate", duration_ms: Date.now() - started, tokens_used: 0 };
    }
    modules.pyodide = pyodideModule;
  }

  // Tier 3: best-effort resolve bare-specifier imports from a CDN as extra virtual modules.
  if (params.tier === 3) {
    const pkgs = extractBarePackageImports(params.code);
    for (const pkg of pkgs) {
      const src = await fetchEsmModule(pkg);
      if (src) modules[pkg] = src;
    }
  }

  const env: Record<string, unknown> = {};
  if (params.tier === 4 || params.tier === 5) {
    if (!opts.browserWorker) {
      return {
        ok: false,
        error: `Tier ${params.tier} is unavailable: no naelao-browser service binding configured`,
        tier: params.tier,
        actual_tier: params.tier,
        engine: "isolate",
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    env.__BROWSER__ = opts.browserWorker;
    env.__BROWSER_TOKEN__ = opts.platformSecret ?? "";
    env.__BROWSER_ENGINE__ = params.tier === 4 ? "kitesurf" : "chromium";
  }

  // ctx.mcp is available at every isolate tier (2-4) — Code Mode's core use case is fast,
  // pure-JS multi-MCP orchestration, not something that should require Tier 4. Mints a
  // short-lived (60s), tenant-scoped token here in real TS — the isolate only ever receives
  // the finished token string, never the platform secret itself.
  if (opts.mcpHubWorker) {
    env.__MCP_HUB__ = opts.mcpHubWorker;
    env.__MCP_TOKEN__ = await mintInternalToken(
      opts.platformSecret ?? "",
      params.tenantId
    );
    env.__MCP_TENANT__ = params.tenantId;
    env.__MCP_SPACE__ = params.spaceId;
    env.__MCP_AGENT__ = params.agentId;
    env.__MCP_USER__ = params.userId ?? "";
    env.__MCP_PROJECT__ = params.projectId ?? "";
  }

  // One isolate per (space, script, code revision) — never share isolates across spaces.
  // `loader.get(id, factory)` caches by id and does NOT re-invoke `factory` (so does not
  // refresh `env`) while a warm isolate for that id exists. That's fine for env values with no
  // expiry (browser token, static bindings) but would silently stale-out __MCP_TOKEN__ (60s
  // freshness window) if the isolate stayed warm longer than that. So ONLY when mcp-hub is
  // wired, fold a coarse time bucket into the id — well inside the token's freshness window —
  // forcing a fresh isolate (and a fresh token) periodically. Scripts that never touch ctx.mcp
  // keep the original stable id, so their isolate-reuse cache hit rate is unaffected.
  const mcpTimeBucket = opts.mcpHubWorker
    ? `:mcp${Math.floor(Date.now() / 45_000)}`
    : "";
  const lockId = `${params.spaceId}:${params.name}:${hashCode(params.code)}${mcpTimeBucket}`;

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
      const body = await resp.json<{
        ok: boolean;
        result?: unknown;
        error?: string;
      }>();
      return {
        ok: body.ok,
        ...(body.ok
          ? { output: body.result }
          : { error: body.error ?? `isolate returned ${resp.status}` }),
        tier: params.tier,
        actual_tier: params.tier,
        engine: "isolate",
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const errMsg = aborted
      ? `Tier ${params.tier} execution timed out`
      : String(err instanceof Error ? err.message : err);

    // Auto-promotion — see ISOLATE_PROMOTION_ERROR_PATTERNS's own doc for why only an unresolved-
    // import failure qualifies (never a timeout, which this branch also handles above but does
    // NOT match any of the patterns). No-op when Tier 5 itself isn't wired — the caller gets the
    // original isolate error, which is still more useful than a second "unavailable" on top of it.
    if (
      opts.toolSandbox &&
      !aborted &&
      (ISOLATE_PROMOTION_ERROR_PATTERNS.some((p) => p.test(errMsg)) ||
        params.code.includes("import torch"))
    ) {
      console.warn(
        `[execution-ladder] auto-promoting '${params.name}' from Tier ${params.tier} to Tier 6 after: ${errMsg}`
      );
      const promoted = await runContainer(opts, {
        tier: 6,
        name: params.name,
        code: params.code,
        args: params.args,
        spaceId: params.spaceId,
        agentId: params.agentId,
        ...(params.projectId ? { projectId: params.projectId } : {}),
      });
      // A successful promotion's `output` is the script's own real return value — left exactly
      // as runContainer produced it, never annotated. A FAILED promotion gets the isolate's
      // original error folded in ahead of the container's own, so "why did this fail" reads as
      // one coherent story instead of only the second attempt's error with no trace of the first.
      if (promoted.ok) return promoted;
      return {
        ...promoted,
        error: `Tier ${params.tier} failed (${errMsg}); auto-promoted to Tier 6, which also failed: ${promoted.error ?? "unknown error"}`,
      };
    }

    return {
      ok: false,
      error: errMsg,
      tier: params.tier,
      actual_tier: params.tier,
      engine: "isolate",
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
}

async function runBrowser(
  opts: CodeRunnerOptions,
  params: {
    name: string;
    code: string;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
    tenantId: string;
    userId?: string;
    tier?: ExecutionTier;
  },
  engine: "kitesurf" | "chromium"
): Promise<ScriptRunResult> {
  const started = Date.now();
  if (!opts.browserWorker) {
    return {
      ok: false,
      error: `Browser engine '${engine}' is unavailable: no naelao-browser service binding configured`,
      tier: engine === "kitesurf" ? 4 : 5,
      actual_tier: engine === "kitesurf" ? 4 : 5,
      engine,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
  const browserWorker = opts.browserWorker;

  let selectedEngine: "kitesurf" | "chromium" = engine;
  let fallbackReason: string | undefined;

  if (
    engine === "kitesurf" &&
    Boolean(params.args["needsScreenshot"] || params.args["take_screenshot"] || params.args["pdf"] || params.args["needsWebGL"] || params.args["needsCanvas"])
  ) {
    selectedEngine = "chromium";
    fallbackReason = "visual QA / WebGL requested";
  }

  const token = await mintInternalToken(
    opts.platformSecret ?? "",
    params.tenantId
  );

  const dispatch = async (eng: "kitesurf" | "chromium") => {
    const endpoint = params.name === "browser-use.see" ? "/v1/browser/see" : "/v1/browser/navigate";
    const resp = await browserWorker.fetch(
      new Request(`http://browser${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ ...params.args, engine: eng }),
      })
    );
    const body: {
      ok?: boolean;
      result?: unknown;
      error?: string;
      message?: string;
    } = await resp
      .json<{
        ok?: boolean;
        result?: unknown;
        error?: string;
        message?: string;
      }>()
      .catch(() => ({ ok: resp.ok }));
    return { resp, body };
  };

  try {
    let { resp, body } = await dispatch(selectedEngine);

    if (!resp.ok && selectedEngine === "kitesurf") {
      selectedEngine = "chromium";
      fallbackReason = `kitesurf failed (${body.message || resp.status}), elevated to Chromium`;
      const retry = await dispatch("chromium");
      resp = retry.resp;
      body = retry.body;
    }

    return {
      ok: resp.ok && body.ok !== false,
      output: {
        ...(typeof body.result === "object" && body.result
          ? (body.result as object)
          : { data: body.result }),
        engine: selectedEngine,
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      },
      tier: selectedEngine === "kitesurf" ? 4 : 5,
      actual_tier: selectedEngine === "kitesurf" ? 4 : 5,
      engine: selectedEngine,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err),
      tier: selectedEngine === "kitesurf" ? 4 : 5,
      actual_tier: selectedEngine === "kitesurf" ? 4 : 5,
      engine: selectedEngine,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
}

async function runContainer(
  opts: CodeRunnerOptions,
  params: {
    name: string;
    code: string;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
    projectId?: string;
    containerImage?: string;
    tier?: ExecutionTier;
  }
): Promise<ScriptRunResult> {
  const started = Date.now();

  // §A1.17 Phase L: a script tagged with a Container Marketplace image routes to THAT image's
  // own binding, never the base sandbox — fails closed with a clear message when the image
  // isn't wired yet (every catalogue image ships unavailable today; see container-catalogue.ts).
  if (params.containerImage) {
    const namespace = opts.containerImages?.[params.containerImage];
    if (!namespace) {
      return {
        ok: false,
        error: `Container image '${params.containerImage}' is not available in this environment yet`,
        tier: 6,
        actual_tier: 6,
        engine: "container",
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    // No live image binds a namespace yet (see the comment above), so this branch has no
    // reachable success path today — the addressing convention (per project, like Phase K's
    // base sandbox) is documented here for whichever image lands it first.
    const doId = namespace.idFromName(
      `slot:${params.containerImage}:${params.spaceId}:${params.projectId ?? "_assistant"}`
    );
    const stub = namespace.get(doId);
    return runContainerRequest(stub, opts, params, started);
  }

  if (!opts.toolSandbox) {
    return {
      ok: false,
      error:
        "Tier 6 is unavailable: no ToolSandboxDO (TOOL_SANDBOX) binding configured",
      tier: 6,
      actual_tier: 6,
      engine: "container",
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  // §A1.17 Phase K: addressed per PROJECT (not per agent) so every thread's agent in the same
  // project shares one container + R2 workspace (spec §33b) — matches workspacePrefix()'s own
  // space/project scoping. "_assistant" is a fixed per-space slot for the Space Assistant
  // (projectId absent), analogous to workspacePrefix()'s space-scoped fallback.
  const doId = opts.toolSandbox.idFromName(
    `sandbox:${params.spaceId}:${params.projectId ?? "_assistant"}`
  );
  const stub = opts.toolSandbox.get(doId);
  return runContainerRequest(stub, opts, params, started);
}

async function runContainerRequest(
  stub: DurableObjectStub,
  opts: CodeRunnerOptions,
  params: {
    name: string;
    code: string;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
    projectId?: string;
  },
  started: number
): Promise<ScriptRunResult> {
  const controller = new AbortController();
  const timeoutMs = opts.containerTimeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const computerEndpoint = params.name === "computer-use.screenshot"
      ? "/computer/screenshot"
      : params.name === "computer-use.action" ? "/computer/action" : "/exec";
    const resp = await stub.fetch(
      new Request(`http://sandbox${computerEndpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: params.name,
          code: params.code,
          args: params.args,
          spaceId: params.spaceId,
          ...(params.projectId ? { projectId: params.projectId } : {}),
        }),
        signal: controller.signal,
      })
    );
    if (computerEndpoint === "/computer/screenshot") {
      if (!resp.ok) return { ok: false, error: `display capture failed (${resp.status})`, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
      const bytes = new Uint8Array(await resp.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { ok: true, output: { media_type: "image/png", data_base64: btoa(binary), explicit_vision_request: true }, tier: 6, actual_tier: 6, engine: "container", duration_ms: Date.now() - started, tokens_used: 0 };
    }
    const body = await resp.json<{
      ok: boolean;
      result?: unknown;
      error?: string;
      logs?: string;
    }>();
    return {
      ok: resp.ok && body.ok,
      ...(resp.ok && body.ok
        ? { output: body.result }
        : { error: body.error ?? `container returned ${resp.status}` }),
      tier: 6,
      actual_tier: 6,
      engine: "container",
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "Tier 6 execution timed out"
        : String(err instanceof Error ? err.message : err),
      tier: 6,
      actual_tier: 6,
      engine: "container",
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
      const commandIntent = String(params.args["commands"] ?? params.args["command"] ?? params.args["code"] ?? params.code);
      if (params.tier !== 6 && requiresNativeCompilation(commandIntent)) {
        return runContainer(opts, { ...params, tier: 6 });
      }
      if (params.tier === 6) return runContainer(opts, params);
      if (params.tier === 4 || params.tier === 5) {
        if (params.name.startsWith("browser-use.")) {
          return runBrowser(opts, params, params.tier === 4 ? "kitesurf" : "chromium");
        }
        if (params.code && params.code.includes("export async function run")) {
          return runIsolate(opts, params);
        }
        return runBrowser(
          opts,
          params,
          params.tier === 4 ? "kitesurf" : "chromium"
        );
      }
      if (params.tier === 2 || params.tier === 3)
        return runIsolate(opts, params);
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
