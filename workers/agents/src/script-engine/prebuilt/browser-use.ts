/**
 * browser-use (spec §8 Tier 4 + §12) — the agent's web browser. Operations: browser.navigate,
 * browser.click, browser.type, browser.extract, browser.screenshot.
 *
 * Routes through the Tier-4 isolate (code-runner.ts), which injects a `ctx.browser.navigate`
 * capability proxied to the naelao-browser Worker (CF Browser Rendering + SSRF guard). The
 * agent never gets raw CDP access (spec §8 note) — every call here goes through that proxy.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

interface BrowserAction {
  type: "click" | "type" | "wait" | "scroll";
  selector?: string;
  text?: string;
  ms?: number;
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
  body: { url: string; actions?: BrowserAction[]; take_screenshot?: boolean; extract_links?: boolean }
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
    "browser.navigate": (a, c) => navigate(c, { url: String(a["url"] ?? "") }),
    "browser.click": (a, c) =>
      navigate(c, { url: String(a["url"] ?? ""), actions: [{ type: "click", selector: String(a["selector"] ?? "") }] }),
    "browser.type": (a, c) =>
      navigate(c, {
        url: String(a["url"] ?? ""),
        actions: [{ type: "type", selector: String(a["selector"] ?? ""), text: String(a["text"] ?? "") }],
      }),
    "browser.extract": (a, c) =>
      navigate(c, { url: String(a["url"] ?? ""), extract_links: a["extract_links"] !== false }),
    "browser.screenshot": (a, c) => navigate(c, { url: String(a["url"] ?? ""), take_screenshot: true }),
  },
};
