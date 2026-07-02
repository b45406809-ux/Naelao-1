// G-BR01..G-BR05: CF Browser Rendering worker — SSRF-safe web navigation for agents
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

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

interface NavigateRequest {
  url: string;
  actions?: BrowserAction[];
  take_screenshot?: boolean;
  extract_links?: boolean;
}

// Type stubs for CF Puppeteer (not typed in @cloudflare/workers-types)
interface BrowserPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(opts: { type: string; fullPage: boolean }): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

// SSRF protection — block private/internal IP ranges and localhost
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^fc00:/i,
  /^fe80:/i,
  /^0\./,
];

function isSsrfBlocked(rawUrl: string): { blocked: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { blocked: true, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { blocked: true, reason: `Protocol not allowed: ${parsed.protocol}` };
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOSTS) {
    if (pattern.test(hostname)) {
      return { blocked: true, reason: `Blocked host: ${hostname}` };
    }
  }
  if (hostname.endsWith(".internal") || hostname.endsWith(".local") || hostname.endsWith(".localhost")) {
    return { blocked: true, reason: `Blocked internal domain: ${hostname}` };
  }
  return { blocked: false };
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

app.post("/v1/browser/navigate", async (c) => {
  const body = await c.req.json<NavigateRequest>();
  if (!body.url) return c.json({ error_code: "bad_request", message: "url required" }, 400);

  const ssrf = isSsrfBlocked(body.url);
  if (ssrf.blocked) {
    return c.json({ error_code: "forbidden", message: `SSRF blocked: ${ssrf.reason}` }, 403);
  }

  let browser: BrowserInstance | undefined;
  try {
    // Use CF Browser Rendering via the BROWSER binding (puppeteer API)
    const puppeteer = c.env.BROWSER as unknown as { launch: (browser: Fetcher) => Promise<BrowserInstance> };
    browser = await puppeteer.launch(c.env.BROWSER);
    const page = await browser.newPage();

    await page.goto(body.url, { waitUntil: "networkidle0", timeout: 30000 });

    // Execute actions sequentially
    for (const action of body.actions ?? []) {
      if (action.type === "click" && action.selector) {
        await page.click(action.selector);
      } else if (action.type === "type" && action.selector && action.text) {
        await page.type(action.selector, action.text);
      } else if (action.type === "wait") {
        await new Promise<void>((r) => setTimeout(r, Math.min(action.ms ?? 1000, 10000)));
      } else if (action.type === "scroll") {
        // Pass as string to avoid TypeScript analyzing browser globals
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      }
    }

    // Extract text content (passed as string so TS doesn't evaluate DOM globals)
    const text = (await page.evaluate("document.body.innerText")) as string;

    // Extract links if requested
    let links: string[] = [];
    if (body.extract_links) {
      const rawLinks = (await page.evaluate(
        "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 50)"
      )) as string[];
      links = rawLinks;
    }

    // Screenshot if requested
    let screenshotBase64: string | undefined;
    if (body.take_screenshot) {
      const screenshotBytes = await page.screenshot({ type: "png", fullPage: false });
      screenshotBase64 = btoa(String.fromCharCode(...screenshotBytes));
    }

    await page.close();

    return c.json({
      url: body.url,
      text: typeof text === "string" ? text.slice(0, 50000) : "",
      links,
      screenshot_base64: screenshotBase64,
    });
  } catch (err) {
    console.error("[browser] Navigation failed:", err);
    return c.json({ error_code: "browser_error", message: String(err) }, 500);
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
