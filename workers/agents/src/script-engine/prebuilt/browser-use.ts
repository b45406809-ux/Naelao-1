/**
 * browser-use (spec §8 Tier 4 + §12) — the agent's web browser. Operations: browser.navigate,
 * browser.click, browser.type, browser.extract, browser.screenshot.
 *
 * Routes through the Tier-4 isolate (code-runner.ts), which injects a `ctx.browser.navigate`
 * capability proxied to the naelao-browser Worker (CF Browser Rendering + SSRF guard). The
 * agent never gets raw CDP access (spec §8 note) — every call here goes through that proxy.
 *
 * The naelao-browser worker itself defaults every call to `engine: "auto"` — Cloudflare's
 * Kitesurf (a lightweight, agent-first browser announced 2026-08-06: 3-7x less CPU/memory than
 * Chromium, ~1.7x slower wall time) is tried FIRST and falls back to Chromium on any failure,
 * with zero change needed here since "auto" is the worker's own default. An agent can request a
 * specific engine explicitly via `engine: "chromium" | "kitesurf"` on any op below — useful when
 * it already knows the target needs something Kitesurf can't yet do (video playback, WebGL,
 * bot-challenge/TLS-fingerprint handshakes, a persistent authenticated session, or pixel-perfect
 * rendering) — but an explicit choice is honored strictly, with no silent fallback.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

interface BrowserAction {
  type: "click" | "type" | "wait" | "scroll";
  selector?: string;
  text?: string;
  ms?: number;
}

type BrowserEngine = "auto" | "chromium" | "kitesurf";

/** Only forwards `engine` when the agent actually specified one, so the naelao-browser worker's
 *  own "auto" default (Kitesurf-first, Chromium fallback) is what applies otherwise — this
 *  function must never invent a default of its own that could drift from the worker's. */
function engineArg(a: Record<string, unknown>): { engine?: BrowserEngine } {
  const raw = a["engine"];
  return raw === "chromium" || raw === "kitesurf" || raw === "auto" ? { engine: raw } : {};
}

/** The Tier-4 isolate harness — forwards straight to the injected ctx.browser capability. */
const BROWSER_HARNESS = `
export async function run(args, ctx) {
  if (!ctx.browser) throw new Error("Tier 4 browser capability not available");
  return await ctx.browser.navigate(args);
}
`;

async function navigate(
  ctx: PrebuiltOpContext,
  body: { url: string; actions?: BrowserAction[]; take_screenshot?: boolean; save_screenshot?: boolean; accessibility_text?: boolean; extract_links?: boolean; engine?: BrowserEngine }
): Promise<unknown> {
  if (!ctx.env.codeRunner) {
    return { ok: false, reason: "Tier 4 (browser) unavailable: no code runner configured in this environment" };
  }
  const result = await ctx.env.codeRunner.run({
    name: "browser-use.navigate",
    code: BROWSER_HARNESS,
    tier: 4,
    args: body,
    spaceId: ctx.env.spaceId,
    agentId: ctx.env.agentId,
    tenantId: ctx.env.tenantId,
  });
  if (!result.ok) throw new Error(result.error ?? "browser navigation failed");
  return result.output;
}

async function see(ctx: PrebuiltOpContext, args: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.codeRunner) throw new Error("Tier 5 (Chromium vision) unavailable");
  const result = await ctx.env.codeRunner.run({
    name: "browser-use.see", code: "", tier: 5,
    args: { path: String(args["path"] ?? "latest"), ...(args["crop"] ? { crop: String(args["crop"]) } : {}) },
    spaceId: ctx.env.spaceId, agentId: ctx.env.agentId, tenantId: ctx.env.tenantId,
  });
  if (!result.ok) throw new Error(result.error ?? "screenshot loading failed");
  return result.output;
}

export const browserUse: PrebuiltScript = {
  name: "browser-use",
  description: "Navigate, click, type, extract text/links, and screenshot real web pages.",
  domain: "browser",
  requires_tier: 4,
  operations: {
    "browser.navigate": (a, c) => navigate(c, {
      url: String(a["url"] ?? ""),
      save_screenshot: a["save_screenshot"] !== false,
      accessibility_text: true,
      ...engineArg(a),
    }),
    "browser.click": (a, c) =>
      navigate(c, {
        url: String(a["url"] ?? ""),
        actions: [{ type: "click", selector: String(a["selector"] ?? "") }],
        ...engineArg(a),
      }),
    "browser.type": (a, c) =>
      navigate(c, {
        url: String(a["url"] ?? ""),
        actions: [{ type: "type", selector: String(a["selector"] ?? ""), text: String(a["text"] ?? "") }],
        ...engineArg(a),
      }),
    "browser.extract": (a, c) =>
      navigate(c, { url: String(a["url"] ?? ""), extract_links: a["extract_links"] !== false, ...engineArg(a) }),
    "browser.screenshot": (a, c) => navigate(c, { url: String(a["url"] ?? ""), take_screenshot: true, ...engineArg(a) }),
    "browser.see": (a, c) => see(c, a),
  },
};
