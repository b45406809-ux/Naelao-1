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

import type { TieredCodeRunner, ScriptRunResult, ExecutionTier, ScriptEngineEnv } from "./types.js";
import { mintInternalToken } from "@naelao/http";
import { r2Workspace } from "./prebuilt/r2-workspace.js";
import { projectJournal } from "./prebuilt/project-journal.js";
import { projectCoordination } from "./prebuilt/project-coordination.js";
import { workspaceAdmin } from "./prebuilt/workspace-admin.js";
import { businessWallet } from "./prebuilt/business-wallet.js";
import { notifications } from "./prebuilt/notifications.js";
import { mcpConnector } from "./prebuilt/mcp-connector.js";
import { browserUse } from "./prebuilt/browser-use.js";
import { tierPrimitives } from "./prebuilt/tier-primitives.js";

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
];

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
          const payload = typeof req === "string" ? { url: req } : { ...req };
          if (env.__DEFAULT_ENGINE__ && !payload.engine) {
            payload.engine = env.__DEFAULT_ENGINE__;
          }
          const r = await env.__BROWSER__.fetch("http://browser/v1/browser/navigate", {
            method: "POST",
            headers: { "content-type": "application/json", "x-naelao-internal-token": env.__BROWSER_TOKEN__ || "" },
            body: JSON.stringify(payload),
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
        "x-naelao-user-id": env.__MCP_AGENT__ || "",
        "x-naelao-agent-id": env.__MCP_AGENT__ || "",
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
    }
    if (typeof run !== "function") {
      return Response.json({ ok: false, error: "script must export an async function named 'run'" }, { status: 500 });
    }
    // Universal Zero-Leak Vault Outbound Fetcher
    ctx.vault = {
      fetchWithAuth: async (url, init = {}) => {
        const headers = new Headers(init.headers || {});
        if (init.credentialName) {
          headers.set("x-naelao-vault-credential", init.credentialName);
        }
        return __ssrfGuardedFetch(url, {
          ...init,
          headers,
        });
      },
    };
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
  params: {
    name: string;
    code: string;
    tier: ExecutionTier;
    args: Record<string, unknown>;
    spaceId: string;
    agentId: string;
    tenantId: string;
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
  if (params.tier === 4 || params.tier === 5) {
    if (!opts.browserWorker) {
      return {
        ok: false,
        error: `Tier ${params.tier} is unavailable: no naelao-browser service binding configured`,
        tier: params.tier,
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    env.__BROWSER__ = opts.browserWorker;
    env.__BROWSER_TOKEN__ = opts.platformSecret ?? "";
    env.__DEFAULT_ENGINE__ = params.tier === 4 ? "kitesurf" : "chromium";
  }

  // ctx.mcp is available at every isolate tier (2-4) — Code Mode's core use case is fast,
  // pure-JS multi-MCP orchestration, not something that should require Tier 4. Mints a
  // short-lived (60s), tenant-scoped token here in real TS — the isolate only ever receives
  // the finished token string, never the platform secret itself.
  if (opts.mcpHubWorker) {
    env.__MCP_HUB__ = opts.mcpHubWorker;
    env.__MCP_TOKEN__ = await mintInternalToken(opts.platformSecret ?? "", params.tenantId);
    env.__MCP_TENANT__ = params.tenantId;
    env.__MCP_SPACE__ = params.spaceId;
    env.__MCP_AGENT__ = params.agentId;
  }

  // One isolate per (space, script, code revision) — never share isolates across spaces.
  // `loader.get(id, factory)` caches by id and does NOT re-invoke `factory` (so does not
  // refresh `env`) while a warm isolate for that id exists. That's fine for env values with no
  // expiry (browser token, static bindings) but would silently stale-out __MCP_TOKEN__ (60s
  // freshness window) if the isolate stayed warm longer than that. So ONLY when mcp-hub is
  // wired, fold a coarse time bucket into the id — well inside the token's freshness window —
  // forcing a fresh isolate (and a fresh token) periodically. Scripts that never touch ctx.mcp
  // keep the original stable id, so their isolate-reuse cache hit rate is unaffected.
  const mcpTimeBucket = opts.mcpHubWorker ? `:mcp${Math.floor(Date.now() / 45_000)}` : "";
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
    const errMsg = aborted ? `Tier ${params.tier} execution timed out` : String(err instanceof Error ? err.message : err);

    // Auto-promotion — see ISOLATE_PROMOTION_ERROR_PATTERNS's own doc for why only an unresolved-
    // import failure qualifies (never a timeout, which this branch also handles above but does
    // NOT match any of the patterns). No-op when Tier 5 itself isn't wired — the caller gets the
    // original isolate error, which is still more useful than a second "unavailable" on top of it.
    if (opts.toolSandbox && !aborted && ISOLATE_PROMOTION_ERROR_PATTERNS.some((p) => p.test(errMsg))) {
      console.warn(`[execution-ladder] auto-promoting '${params.name}' from Tier ${params.tier} to Tier 5 after: ${errMsg}`);
      const promoted = await runContainer(opts, {
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
      return { ...promoted, error: `Tier ${params.tier} failed (${errMsg}); auto-promoted to Tier 5, which also failed: ${promoted.error ?? "unknown error"}` };
    }

    return {
      ok: false,
      error: errMsg,
      tier: params.tier,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }
}

async function runContainer(
  opts: CodeRunnerOptions,
  params: { name: string; code: string; args: Record<string, unknown>; spaceId: string; agentId: string; projectId?: string; containerImage?: string }
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
        duration_ms: Date.now() - started,
        tokens_used: 0,
      };
    }
    const doId = namespace.idFromName(`slot:${params.containerImage}:${params.spaceId}:${params.projectId ?? "_assistant"}`);
    const stub = namespace.get(doId);
    return runContainerRequest(stub, opts, params, started);
  }

  if (!opts.toolSandbox) {
    return {
      ok: false,
      error: "Tier 6 is unavailable: no ToolSandboxDO (TOOL_SANDBOX) binding configured",
      tier: 6,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  }

  const doId = opts.toolSandbox.idFromName(`sandbox:${params.spaceId}:${params.projectId ?? "_assistant"}`);
  const stub = opts.toolSandbox.get(doId);
  return runContainerRequest(stub, opts, params, started);
}

async function runContainerRequest(
  stub: DurableObjectStub,
  opts: CodeRunnerOptions,
  params: { name: string; code: string; args: Record<string, unknown>; spaceId: string; agentId: string; projectId?: string },
  started: number
): Promise<ScriptRunResult> {
  const controller = new AbortController();
  const timeoutMs = opts.containerTimeoutMs ?? DEFAULT_CONTAINER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await stub.fetch(
      new Request("http://sandbox/exec", {
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
    const body = await resp.json<{ ok: boolean; result?: unknown; error?: string; logs?: string }>();
    return {
      ok: resp.ok && body.ok,
      ...(resp.ok && body.ok ? { output: body.result } : { error: body.error ?? `container returned ${resp.status}` }),
      tier: 6,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "Tier 6 execution timed out" : String(err instanceof Error ? err.message : err),
      tier: 6,
      duration_ms: Date.now() - started,
      tokens_used: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detects if an execution failure in an Isolate is caused by missing native tools or compilers,
 * signaling that the task should be automatically promoted to Tier 6 Container.
 */
function requiresContainerPromotion(errorMsg: string, code: string): boolean {
  const nativeKeywords = [
    "npm", "pnpm", "npx", "pip", "python", "esbuild", "vite", "astro",
    "Cannot find module", "command not found", "ENOENT", "spawn"
  ];
  return nativeKeywords.some((kw) => errorMsg.includes(kw) || code.includes(kw));
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
      if (params.tier === 1) {
        throw new Error("Tier 1 scripts are pure R2/SQLite and must be handled in-process.");
      }

      // Execute in Isolate for Tiers 2, 4, 5
      if (params.tier <= 5) {
        const res = await runIsolate(opts, params);

        // Ladder Self-Healing: Automatically promote to Container if isolate hits a native tool wall
        if (!res.ok && res.error && opts.toolSandbox && requiresContainerPromotion(res.error, params.code)) {
          return await runContainer(opts, {
            ...params,
            args: { ...params.args, _promotedFromTier: params.tier },
          });
        }
        return res;
      }
      return runContainer(opts, params);
    },
  };
}

/**
 * TypeScript API definition of the Universal AVOS Runtime SDK (v2.0).
 * Injected into agent reasoning context for Tier 2/3/6 CodeMode scripts.
 */
export const AVOS_SDK_DTS = `/**
 * AVOS RUNTIME ENVIRONMENT DEFINITIONS (v2.0)
 * Available in all Isolate CodeMode (Tier 2), Workflows (Tier 3), and Container (Tier 6) scripts.
 */
declare namespace ctx {
  namespace fs {
    function read(path: string, opts?: { offset?: number; limit?: number }): Promise<{ content: string; totalLines: number }>;
    function edit(path: string, oldString: string, newString: string): Promise<{ ok: boolean; message: string }>;
    function write(path: string, content: string): Promise<{ ok: boolean; bytesWritten: number }>;
    function grep(pattern: string, path?: string): Promise<{ matches: Array<{ file: string; line: number; text: string }> }>;
    function glob(pattern: string): Promise<{ files: string[] }>;
    function diff(path: string, newContent: string): Promise<{ ok: boolean; differences: Array<{ line: number; original: string; modified: string }> }>;
  }
  namespace project {
    const id: string;
    function getJournal(): Promise<{ goal: string; status: string; todos: Array<{ text: string; done: boolean }> }>;
    function updateJournal(status: string, goal?: string): Promise<{ ok: boolean }>;
    function createTask(title: string, deps?: string[]): Promise<{ ok: boolean }>;
    function listThreads(): Promise<Array<{ id: string; title: string }>>;
    function postMessage(threadId: string, text: string): Promise<{ ok: boolean }>;
    function readRules(): Promise<{ content: string }>;
  }
  // ONLY available in Space Assistant (CEO) context
  namespace space {
    const id: string;
    function createProject(name: string, kind?: string, templateId?: string): Promise<{ id: string; name: string }>;
    function listProjects(): Promise<Array<{ id: string; name: string; kind: string }>>;
    function configureProject(id: string, config?: Record<string, unknown>): Promise<{ ok: boolean }>;
    function getWalletBalance(): Promise<{ balance_cents: number; currency: string }>;
    function requestPayout(destId: string, cents: number): Promise<{ ok: boolean; payoutId: string }>;
    function sendNotification(title: string, body?: string): Promise<{ ok: boolean }>;
  }
  namespace vault {
    function fetchWithAuth(url: string, init: { credentialName?: string; method?: string; headers?: Record<string, string>; body?: any }): Promise<Response>;
  }
  namespace mcp {
    function call(server: string, tool: string, params?: Record<string, any>): Promise<any>;
    function listTools(server: string): Promise<Array<{ name: string; description: string }>>;
  }
  namespace browser {
    function navigate(url: string): Promise<{ title: string; textContent: string }>;
    function click(selector: string): Promise<{ ok: boolean }>;
    function type(selector: string, text: string): Promise<{ ok: boolean }>;
    function extract(selector: string): Promise<string[]>;
  }
  function runSkill(skillName: string, args?: Record<string, any>): Promise<any>;
}`;

/**
 * Universal AVOS Runtime SDK builder for all 6 tiers.
 * Scoped by role: Space Assistant (SPACE_WIDE) gets ctx.space; Project Agents get ctx.project.
 */
export function buildTierSdkContext(
  env: ScriptEngineEnv,
  scope: "SPACE_WIDE" | "PROJECT_BOUND" = env.projectId ? "PROJECT_BOUND" : "SPACE_WIDE"
) {
  const dummyRun = async (name: string, params: Record<string, unknown>) => {
    if (env.codeRunner) {
      const res = await env.codeRunner.run({
        name,
        code: "",
        tier: 2,
        args: params,
        spaceId: env.spaceId,
        agentId: env.agentId,
        tenantId: env.tenantId,
        projectId: env.projectId,
      });
      if (!res.ok) throw new Error(res.error ?? `Execution of ${name} failed`);
      return res.output;
    }
    return null;
  };

  // 1. Filesystem bound to the correct workspace prefix
  const fs = {
    read: (path: string, opts?: { offset?: number; limit?: number }) =>
      r2Workspace.operations.Read({ path, ...opts }, { env, run: dummyRun }),
    edit: (path: string, oldString: string, newString: string) =>
      r2Workspace.operations.Edit({ path, oldString, newString }, { env, run: dummyRun }),
    write: (path: string, content: string) =>
      r2Workspace.operations.Write({ path, content }, { env, run: dummyRun }),
    grep: (pattern: string, path?: string) =>
      r2Workspace.operations.Grep({ pattern, path }, { env, run: dummyRun }),
    glob: (pattern: string) =>
      r2Workspace.operations.Glob({ pattern }, { env, run: dummyRun }),
    diff: (path: string, newContent: string) =>
      tierPrimitives.operations.exec_sqlite_fs({ op: "diff", path, content: newContent }, { env, run: dummyRun }),
  };

  // 2. Project-level primitives (available to both Assistant and Project Agents)
  const project = env.projectId
    ? {
        id: env.projectId,
        getJournal: () => projectJournal.operations["project_journal.read"]({}, { env, run: dummyRun }),
        updateJournal: (status: string, goal?: string) =>
          projectJournal.operations["project_journal.set_status"]({ status, goal }, { env, run: dummyRun }),
        createTask: (title: string, deps?: string[]) =>
          projectJournal.operations["project_journal.add_todo"]({ text: title, deps }, { env, run: dummyRun }),
        listThreads: () =>
          projectCoordination.operations["thread.list"]({ project_id: env.projectId }, { env, run: dummyRun }),
        postMessage: (threadId: string, text: string) =>
          projectCoordination.operations["thread.send_message"]({ thread_id: threadId, message: text }, { env, run: dummyRun }),
        readRules: () => r2Workspace.operations.Read({ path: "CLAUDE.md" }, { env, run: dummyRun }),
      }
    : undefined;

  // 3. Space-level primitives (STRICTLY RESTRICTED to Space Assistant)
  const space =
    scope === "SPACE_WIDE"
      ? {
          id: env.spaceId,
          createProject: (name: string, kind?: string, templateId?: string) =>
            workspaceAdmin.operations["project.create_from_template"]({ templateId, name, kind }, { env, run: dummyRun }),
          listProjects: () => workspaceAdmin.operations["project.list"]({}, { env, run: dummyRun }),
          configureProject: (id: string, config?: Record<string, unknown>) =>
            workspaceAdmin.operations["project.configure"]({ id, ...config }, { env, run: dummyRun }),
          getWalletBalance: () => businessWallet.operations["business_wallet.balance"]({}, { env, run: dummyRun }),
          requestPayout: (destId: string, cents: number) =>
            businessWallet.operations["business_wallet.request_payout"]({ destination_id: destId, amount_cents: cents }, { env, run: dummyRun }),
          sendNotification: (title: string, body?: string) =>
            notifications.operations["notify.email"]({ title, body: body || "" }, { env, run: dummyRun }),
        }
      : undefined;

  // 4. Zero-Leak Vault / Outbound Fetcher
  const vault = {
    fetchWithAuth: async (
      url: string,
      init?: { credentialName?: string; method?: string; headers?: Record<string, string>; body?: unknown }
    ) => {
      const headers = new Headers(init?.headers || {});
      if (init?.credentialName) {
        const secret = env.spaceCredentials?.[init.credentialName];
        if (secret) {
          headers.set("Authorization", `Bearer ${secret}`);
        } else {
          headers.set("x-naelao-vault-credential", init.credentialName);
        }
      }
      return fetch(url, {
        method: init?.method || "GET",
        headers,
        body: init?.body ? (typeof init.body === "string" ? init.body : JSON.stringify(init.body)) : undefined,
      });
    },
  };

  // 5. MCP Connector
  const mcp = {
    call: (server: string, tool: string, params?: Record<string, unknown>) =>
      mcpConnector.operations["mcp.call"]({ server, tool, params: params || {} }, { env, run: dummyRun }),
    listTools: (server: string) => mcpConnector.operations["mcp.list_tools"]({ server }, { env, run: dummyRun }),
  };

  // 6. Browser (Tier 4 / 5)
  const browser = {
    navigate: (url: string) => browserUse.operations["browser.navigate"]({ url }, { env, run: dummyRun }),
    click: (selector: string) => browserUse.operations["browser.click"]({ selector }, { env, run: dummyRun }),
    type: (selector: string, text: string) => browserUse.operations["browser.type"]({ selector, text }, { env, run: dummyRun }),
    extract: (selector: string) => browserUse.operations["browser.extract"]({ selector }, { env, run: dummyRun }),
  };

  // 7. Skill Distillation & Reusable Run
  const runSkill = (skillName: string, args?: Record<string, unknown>) =>
    env.codeRunner?.run({
      name: skillName,
      code: "",
      tier: 2,
      args: args || {},
      spaceId: env.spaceId,
      agentId: env.agentId,
      tenantId: env.tenantId,
      projectId: env.projectId,
    });

  return { fs, project, space, vault, mcp, browser, runSkill, fetch: vault.fetchWithAuth };
}

