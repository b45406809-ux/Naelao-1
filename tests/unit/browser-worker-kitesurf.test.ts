import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real, grounded facts behind this file (Cloudflare's own blog, 2026-08-06, and the published
// @cloudflare/puppeteer 1.3.0 types — `WorkersLaunchOptions.browser?: 'kitesurf'`): Kitesurf is a
// lightweight, agent-first browser (3-7x less CPU/memory than Chromium, ~1.7x slower wall time)
// that can't yet do video playback, WebGL, bot-challenge/TLS-fingerprint handshakes, persistent
// authenticated sessions, or pixel-perfect rendering. None of those are what this worker's
// stateless one-shot navigate call needs, so "auto" tries kitesurf first and falls back to
// chromium on any failure — but only for "auto"; an EXPLICIT engine choice is honored strictly
// (no silent substitution), and this file is what proves that split.
//
// Also locks in a real, previously-broken call this session found while adding this: the worker
// used to cast the raw BROWSER binding itself to a fake `{ launch(browser) }` shape and call
// `.launch()` ON the binding (passing the binding back to itself as an argument) — the binding
// only ever implements `fetch()`. The real contract is `puppeteer.launch(binding, options?)`
// where `puppeteer` is the imported package's own default export. Mocking the package here (not
// hand-rolling a fake binding shape) is what would have caught that mismatch.

const launchMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: (...args: unknown[]) => launchMock(...args) },
}));

function makePage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(null),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("page text"),
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeBrowser(page: ReturnType<typeof makePage>) {
  return { newPage: vi.fn().mockResolvedValue(page), close: closeMock };
}

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function env(overrides: Record<string, unknown> = {}) {
  return { ENVIRONMENT: "test", PLATFORM_SECRET, BROWSER: {} as unknown, ...overrides };
}

function req(body: Record<string, unknown>): Request {
  return new Request("https://browser.naelao.com/v1/browser/navigate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-internal-token": PLATFORM_SECRET },
    body: JSON.stringify(body),
  });
}

/** DoH resolution for checkSsrf — resolves any non-blocked hostname to a benign public IP so the
 *  SSRF gate passes and the test can reach the actual launch/navigate logic being tested. */
function mockDohResolution(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://cloudflare-dns.com/")) {
      return new Response(JSON.stringify({ Answer: [{ data: "93.184.216.34" }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("browser worker — Kitesurf-first auto engine with honest fallback", () => {
  let originalFetch: typeof fetch;
  let worker: typeof import("../../workers/browser/src/index.js").default;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    mockDohResolution();
    launchMock.mockReset();
    closeMock.mockReset();
    vi.resetModules();
    worker = (await import("../../workers/browser/src/index.js")).default;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("defaults to 'auto' and launches kitesurf FIRST via the real puppeteer.launch(binding, options) contract", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    launchMock.mockResolvedValueOnce(browser);

    const res = await worker.fetch(req({ url: "https://example.com" }), env(), execCtx);
    const body = (await res.json()) as { engine_used: string; text: string };

    expect(res.status).toBe(200);
    expect(body.engine_used).toBe("kitesurf");
    expect(body.text).toBe("page text");
    // The real contract: launch(endpoint, options) — endpoint is DATA passed IN, never the thing
    // `.launch` is called on. Reproduces exactly the bug this file's header describes.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(expect.anything(), { browser: "kitesurf" });
  });

  it("falls back to chromium when kitesurf fails under 'auto', and says so honestly", async () => {
    launchMock.mockRejectedValueOnce(new Error("kitesurf: bot-challenge handshake unsupported"));
    const page = makePage();
    const browser = makeBrowser(page);
    launchMock.mockResolvedValueOnce(browser);

    const res = await worker.fetch(req({ url: "https://example.com" }), env(), execCtx);
    const body = (await res.json()) as { engine_used: string; kitesurf_fallback: boolean; kitesurf_fallback_reason: string };

    expect(res.status).toBe(200);
    expect(body.engine_used).toBe("chromium");
    expect(body.kitesurf_fallback).toBe(true);
    expect(body.kitesurf_fallback_reason).toContain("bot-challenge");
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(launchMock).toHaveBeenNthCalledWith(1, expect.anything(), { browser: "kitesurf" });
    expect(launchMock).toHaveBeenNthCalledWith(2, expect.anything(), {});
  });

  it("an EXPLICIT engine:'chromium' never even tries kitesurf", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    launchMock.mockResolvedValueOnce(browser);

    const res = await worker.fetch(req({ url: "https://example.com", engine: "chromium" }), env(), execCtx);
    const body = (await res.json()) as { engine_used: string };

    expect(body.engine_used).toBe("chromium");
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("an EXPLICIT engine:'kitesurf' that fails does NOT silently fall back — the caller asked for kitesurf specifically", async () => {
    launchMock.mockRejectedValueOnce(new Error("kitesurf: WebGL not supported"));

    const res = await worker.fetch(req({ url: "https://example.com", engine: "kitesurf" }), env(), execCtx);
    const body = (await res.json()) as { error_code: string; message: string };

    expect(res.status).toBe(500);
    expect(body.error_code).toBe("browser_error");
    expect(body.message).toContain("WebGL");
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("SSRF-blocked URLs never reach launch() at all, regardless of engine", async () => {
    const res = await worker.fetch(req({ url: "http://169.254.169.254/latest/meta-data" }), env(), execCtx);
    expect(res.status).toBe(403);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("screenshot bytes round-trip through Buffer.toString('base64'), not a spread that could overflow the call stack", async () => {
    const page = makePage({ screenshot: vi.fn().mockResolvedValue(new Uint8Array([72, 101, 108, 108, 111])) }); // "Hello"
    const browser = makeBrowser(page);
    launchMock.mockResolvedValueOnce(browser);

    const res = await worker.fetch(req({ url: "https://example.com", take_screenshot: true }), env(), execCtx);
    const body = (await res.json()) as { screenshot_base64: string };

    expect(Buffer.from(body.screenshot_base64, "base64").toString("utf8")).toBe("Hello");
  });

  it("rejects with no internal token", async () => {
    const res = await worker.fetch(
      new Request("https://browser.naelao.com/v1/browser/navigate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
      env(),
      execCtx
    );
    expect(res.status).toBe(401);
    expect(launchMock).not.toHaveBeenCalled();
  });
});
