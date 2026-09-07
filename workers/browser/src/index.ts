// G-BR01..G-BR05: CF Browser Rendering worker — SSRF-safe web navigation for agents
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";
import { checkSsrf } from "@naelao/security";
import puppeteer from "@cloudflare/puppeteer";
import type { Browser, Page, WorkersLaunchOptions } from "@cloudflare/puppeteer";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  BROWSER: Fetcher; // CF Browser Rendering binding
}

interface BrowserAction {
  type: "click" | "type" | "wait" | "scroll";
  selector?: string;
  text?: string;
  ms?: number;
}

// "auto" (default) tries Kitesurf first and falls back to Chromium on any failure — the
// documented "3-7x less CPU/memory, ~1.7x slower wall time" tradeoff is worth taking by default
// for the stateless, one-shot navigation this worker does (launch → act → extract → close, never
// a persisted session across calls), which is exactly the shape Kitesurf is built for. Explicit
// "chromium"/"kitesurf" skip the fallback logic and do exactly what's asked. Cloudflare's own
// blog (2026-08-06) names Kitesurf's real gaps: no video playback, no WebGL, no bot-challenge/TLS-
// fingerprint handshakes, no persistent authenticated sessions, and CSS parsing that isn't
// pixel-perfect — none of which this worker's usage (real-time text/link extraction, DOM actions)
// structurally depends on, but a heavily-JS/bot-protected target site can still trip one of them,
// which is what the fallback exists for.
type BrowserEngine = "auto" | "chromium" | "kitesurf";

interface BrowserTaskRequest {
  url: string;
  action?: "navigate" | "click" | "type" | "screenshot" | "extract";
  actions?: BrowserAction[];
  selector?: string;
  text?: string;
  take_screenshot?: boolean;
  takeScreenshot?: boolean;
  extract_links?: boolean;
  requiresWebGL?: boolean;
  engine?: BrowserEngine;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Require internal HMAC token to prevent unauthorized access
app.use("/v1/*", async (c, next) => {
  const token = c.req.header("x-naelao-internal-token");
  if (!token || token !== c.env.PLATFORM_SECRET) {
    return c.json({ error_code: "unauthorized", message: "Missing internal token" }, 401);
  }
  return next();
});

/** Launches a real browser instance via the real @cloudflare/puppeteer package. */
async function launchBrowser(env: Env, engine: "chromium" | "kitesurf"): Promise<Browser> {
  const options: WorkersLaunchOptions = engine === "kitesurf" ? { browser: "kitesurf" } : {};
  return puppeteer.launch(env.BROWSER, options);
}

async function runNavigation(
  browser: Browser,
  body: BrowserTaskRequest
): Promise<{ url: string; title?: string; textContent?: string; text: string; links: string[]; screenshot_base64?: string; screenshotBase64?: string }> {
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(body.url, { waitUntil: "networkidle0", timeout: 30000 });
    const title = await page.title();

    // Normalise actions / single action
    const actions: BrowserAction[] = body.actions ? [...body.actions] : [];
    if (body.action === "click" && body.selector) {
      actions.push({ type: "click", selector: body.selector });
    } else if (body.action === "type" && body.selector && body.text) {
      actions.push({ type: "type", selector: body.selector, text: body.text });
    }

    for (const action of actions) {
      if (action.type === "click" && action.selector) {
        await page.click(action.selector);
      } else if (action.type === "type" && action.selector && action.text) {
        await page.type(action.selector, action.text);
      } else if (action.type === "wait") {
        await new Promise<void>((r) => setTimeout(r, Math.min(action.ms ?? 1000, 10000)));
      } else if (action.type === "scroll") {
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      }
    }

    const textContent = (await page.evaluate("document.body.innerText")) as string;

    let links: string[] = [];
    if (body.extract_links) {
      links = (await page.evaluate(
        "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 50)"
      )) as string[];
    }

    let screenshot_base64: string | undefined;
    const shouldScreenshot = body.take_screenshot || body.takeScreenshot || body.action === "screenshot";
    if (shouldScreenshot) {
      const bytes = await page.screenshot({ type: "png", fullPage: true });
      screenshot_base64 = Buffer.from(bytes).toString("base64");
    }

    const trimmedText = typeof textContent === "string" ? textContent.slice(0, 50000) : "";
    return {
      url: body.url,
      title,
      textContent: trimmedText,
      text: trimmedText,
      links,
      ...(screenshot_base64 ? { screenshot_base64, screenshotBase64: screenshot_base64 } : {})
    };
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

async function handleBrowserRequest(env: Env, body: BrowserTaskRequest) {
  if (!body.url) throw new Error("url required");

  // SSRF check
  const ssrf = await checkSsrf(body.url);
  if (ssrf.blocked) {
    throw new Error(`SSRF blocked: ${ssrf.reason}`);
  }

  const requested = body.engine ?? "auto";
  const needsHeavyChromium = body.take_screenshot || body.takeScreenshot || body.requiresWebGL || requested === "chromium";
  const wantKitesurfFirst = requested === "auto" && !needsHeavyChromium;
  const firstEngine: "chromium" | "kitesurf" = wantKitesurfFirst ? "kitesurf" : "chromium";

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(env, firstEngine);
    const result = await runNavigation(browser, body);
    return {
      success: true,
      engineUsed: firstEngine,
      ...result
    };
  } catch (err) {
    if (requested === "auto" && firstEngine === "kitesurf") {
      try {
        if (browser) { try { await browser.close(); } catch { /* ignore */ } browser = undefined; }
        browser = await launchBrowser(env, "chromium");
        const result = await runNavigation(browser, body);
        return {
          success: true,
          engineUsed: "chromium" as const,
          kitesurf_fallback: true,
          kitesurf_fallback_reason: String((err as Error)?.message ?? err),
          ...result
        };
      } catch (fallbackErr) {
        throw new Error(String((fallbackErr as Error)?.message ?? fallbackErr));
      }
    }
    throw new Error(String((err as Error)?.message ?? err));
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

app.post("/v1/browser/navigate", async (c) => {
  const body = await c.req.json<BrowserTaskRequest>();
  try {
    const res = await handleBrowserRequest(c.env, body);
    return c.json(res);
  } catch (err: any) {
    const msg = err?.message || String(err);
    const code = msg.includes("SSRF blocked") ? 403 : 500;
    return c.json({ error_code: code === 403 ? "forbidden" : "browser_error", message: msg }, code);
  }
});

// Alias for browser task endpoint requested in spec
app.post("/browser-task", async (c) => {
  const body = await c.req.json<BrowserTaskRequest>();
  try {
    const res = await handleBrowserRequest(c.env, body);
    return c.json(res);
  } catch (err: any) {
    const msg = err?.message || String(err);
    const code = msg.includes("SSRF blocked") ? 403 : 500;
    return c.json({ success: false, error: msg }, code);
  }
});

// Health check
app.get("/health", (c) => c.json({ ok: true, service: "browser" }));

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
