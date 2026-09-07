import type { BrowserTaskRequest } from "../../../browser/src/index.js";

export interface BrowserToolParams {
  action?: "navigate" | "click" | "type" | "screenshot" | "extract";
  url?: string;
  selector?: string;
  text?: string;
  takeScreenshot?: boolean;
  take_screenshot?: boolean;
  requiresWebGL?: boolean;
  extract_links?: boolean;
  actions?: Array<{ type: "click" | "type" | "wait" | "scroll"; selector?: string; text?: string; ms?: number }>;
  engine?: "auto" | "chromium" | "kitesurf";
}

export async function executeBrowserTool(params: BrowserToolParams, ctx: { env: any; spaceId?: string }) {
  try {
    // If ctx.env has BROWSER binding or browser service, invoke it directly or via fetch/worker binding
    const browserBinding = ctx.env?.BROWSER_WORKER || ctx.env?.BROWSER;
    
    let result: any;
    const taskPayload: BrowserTaskRequest = {
      url: params.url || "",
      action: params.action || "navigate",
      actions: params.actions,
      selector: params.selector,
      text: params.text,
      take_screenshot: params.takeScreenshot ?? params.take_screenshot ?? (params.action === "screenshot"),
      extract_links: params.extract_links,
      requiresWebGL: params.requiresWebGL,
      engine: params.engine || "auto"
    };

    if (browserBinding && typeof browserBinding.fetch === "function") {
      const internalToken = ctx.env.PLATFORM_SECRET || "";
      const res = await browserBinding.fetch(new Request("https://browser.internal/v1/browser/navigate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-internal-token": internalToken
        },
        body: JSON.stringify(taskPayload)
      }));
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Browser worker returned status ${res.status}: ${errText}`);
      }
      result = await res.json();
    } else {
      // Fallback: import processBrowserTask or invoke dynamic handler if available in local test env
      const browserWorker = await import("../../../browser/src/index.js");
      // If browserWorker has default fetch or handler
      const req = new Request("https://browser.internal/v1/browser/navigate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-internal-token": ctx.env?.PLATFORM_SECRET || "test" },
        body: JSON.stringify(taskPayload)
      });
      const res = await browserWorker.default.fetch(req, ctx.env);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Browser local worker returned status ${res.status}: ${errText}`);
      }
      result = await res.json();
    }

    return {
      success: true,
      data: result,
      message: `✔ Browser action '${params.action || "navigate"}' executed successfully via ${result.engineUsed || "browser"}.`
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Browser execution failed",
      message: `✖ Browser action failed: ${err.message}`
    };
  }
}
