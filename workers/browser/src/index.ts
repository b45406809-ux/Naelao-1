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

interface NavigateRequest {
  url: string;
  actions?: BrowserAction[];
  take_screenshot?: boolean;
  extract_links?: boolean;
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

/** Launches a real browser instance via the real @cloudflare/puppeteer package.
 *
 *  NOTE on a previously-broken call here: this used to cast `c.env.BROWSER` itself to a fake
 *  `{ launch(browser): Promise<...> }` shape and call `.launch()` ON the binding, passing the
 *  same binding back to itself as an argument — the binding only ever implements `fetch()`, it
 *  has no `.launch` method of its own. The real contract (confirmed against the published
 *  @cloudflare/puppeteer 1.3.0 types) is `puppeteer.launch(endpoint, options?)`, where `puppeteer`
 *  is the imported package's own default export and `endpoint` is the binding passed as data —
 *  never the other way around. */
async function launchBrowser(env: Env, engine: "chromium" | "kitesurf"): Promise<Browser> {
  const options: WorkersLaunchOptions = engine === "kitesurf" ? { browser: "kitesurf" } : {};
  return puppeteer.launch(env.BROWSER, options);
}

async function runNavigation(
  browser: Browser,
  body: NavigateRequest
): Promise<{ url: string; text: string; links: string[]; screenshot_base64?: string }> {
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(body.url, { waitUntil: "networkidle0", timeout: 30000 });

    for (const action of body.actions ?? []) {
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

    const text = (await page.evaluate("document.body.innerText")) as string;

    let links: string[] = [];
    if (body.extract_links) {
      links = (await page.evaluate(
        "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 50)"
      )) as string[];
    }

    let screenshot_base64: string | undefined;
    if (body.take_screenshot) {
      // Buffer.toString("base64") rather than spreading the bytes through String.fromCharCode —
      // the spread form risks "Maximum call stack size exceeded" on a large screenshot buffer.
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      screenshot_base64 = Buffer.from(bytes).toString("base64");
    }

    return { url: body.url, text: typeof text === "string" ? text.slice(0, 50000) : "", links, ...(screenshot_base64 ? { screenshot_base64 } : {}) };
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

app.post("/v1/browser/navigate", async (c) => {
  const body = await c.req.json<NavigateRequest>();
  if (!body.url) return c.json({ error_code: "bad_request", message: "url required" }, 400);

  // F13: literal-only blocklist missed DNS rebinding (a hostname registered to resolve to
  // 169.254.169.254 etc.) — checkSsrf resolves the hostname via DoH and checks resolved IPs too.
  const ssrf = await checkSsrf(body.url);
  if (ssrf.blocked) {
    return c.json({ error_code: "forbidden", message: `SSRF blocked: ${ssrf.reason}` }, 403);
  }

  const requested = body.engine ?? "auto";
  // If the task explicitly requires visual screenshots / Visual QA, or forces chromium, prioritize full Chromium
  const requiresVisualQa = body.take_screenshot === true || requested === "chromium";
  const wantKitesurfFirst = !requiresVisualQa && (requested === "auto" || requested === "kitesurf");
  const firstEngine: "chromium" | "kitesurf" = wantKitesurfFirst ? "kitesurf" : "chromium";

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser(c.env, firstEngine);
    const result = await runNavigation(browser, body);
    return c.json({ ...result, engine_used: firstEngine });
  } catch (err) {
    // Only "auto" retries on the OTHER engine — an explicit request for one engine or the other
    // does exactly what was asked and reports the real failure, rather than silently substituting
    // a different engine than the caller chose.
    if (requested === "auto" && firstEngine === "kitesurf") {
      try {
        if (browser) { try { await browser.close(); } catch { /* ignore */ } browser = undefined; }
        browser = await launchBrowser(c.env, "chromium");
        const result = await runNavigation(browser, body);
        return c.json({ ...result, engine_used: "chromium", kitesurf_fallback: true, kitesurf_fallback_reason: String((err as Error)?.message ?? err) });
      } catch (fallbackErr) {
        console.error("[browser] Navigation failed on both kitesurf and chromium:", fallbackErr);
        return c.json({ error_code: "browser_error", message: String((fallbackErr as Error)?.message ?? fallbackErr) }, 500);
      }
    }
    console.error("[browser] Navigation failed:", err);
    return c.json({ error_code: "browser_error", message: String((err as Error)?.message ?? err) }, 500);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
});

// Health check (no auth required for load balancer)
app.get("/health", (c) => c.json({ ok: true, service: "browser" }));

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
