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

export async function executeBrowserPrebuilt(
  args: { action?: string; url?: string; selector?: string; text?: string; engine?: string; takeScreenshot?: boolean; take_screenshot?: boolean; actions?: any[]; extract_links?: boolean },
  ctx: PrebuiltOpContext
) {
  const browserWorkerUrl = ctx.env.BROWSER_ROUTER_SERVICE || "http://internal/browser-task";

  const response = await fetch(browserWorkerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ctx.env.PLATFORM_SECRET ? { "x-naelao-internal-token": ctx.env.PLATFORM_SECRET } : {})
    },
    body: JSON.stringify({
      url: args.url,
      action: args.action || "navigate",
      actions: args.actions,
      selector: args.selector,
      text: args.text,
      engine: args.engine || "auto",
      take_screenshot: args.take_screenshot ?? args.takeScreenshot,
      extract_links: args.extract_links
    })
  });

  if (!response.ok) {
    throw new Error(`Browser execution failed with status ${response.status}`);
  }

  const result = await response.json() as any;
  return {
    ok: true,
    engineUsed: result.engineUsed,
    title: result.title,
    content: (result.textContent || result.text || "").slice(0, 4000), // Trim to protect LLM context window
    links: result.links || [],
    screenshotCaptured: !!(result.screenshotBase64 || result.screenshot_base64),
    ...(result.screenshotBase64 || result.screenshot_base64 ? { screenshotBase64: result.screenshotBase64 || result.screenshot_base64 } : {})
  };
}

async function navigate(
  ctx: PrebuiltOpContext,
  body: { url: string; action?: string; actions?: any[]; take_screenshot?: boolean; takeScreenshot?: boolean; extract_links?: boolean; engine?: BrowserEngine; selector?: string; text?: string }
): Promise<unknown> {
  // Try direct browser service fetch first if configured, or delegate to codeRunner
  try {
    return await executeBrowserPrebuilt(body, ctx);
  } catch (err) {
    if (!ctx.env.codeRunner) {
      throw err;
    }
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

export const browserUse: PrebuiltScript = {
  name: "browser-use",
  description: "Navigate, click, type, extract text/links, and screenshot real web pages.",
  domain: "browser",
  requires_tier: 4,
  operations: {
    "browser.navigate": (a, c) => navigate(c, { url: String(a["url"] ?? ""), action: "navigate", ...engineArg(a) }),
    "browser.click": (a, c) =>
      navigate(c, {
        url: String(a["url"] ?? ""),
        action: "click",
        selector: String(a["selector"] ?? ""),
        ...engineArg(a),
      }),
    "browser.type": (a, c) =>
      navigate(c, {
        url: String(a["url"] ?? ""),
        action: "type",
        selector: String(a["selector"] ?? ""),
        text: String(a["text"] ?? ""),
        ...engineArg(a),
      }),
    "browser.extract": (a, c) =>
      navigate(c, { url: String(a["url"] ?? ""), action: "extract", extract_links: a["extract_links"] !== false, ...engineArg(a) }),
    "browser.screenshot": (a, c) => navigate(c, { url: String(a["url"] ?? ""), action: "screenshot", take_screenshot: true, ...engineArg(a) }),
  },
};
