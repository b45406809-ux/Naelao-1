import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import browserWorker from "../../workers/browser/src/index.js";
import { BrowserSessionDO } from "../../workers/browser/src/BrowserSessionDO.js";
import type { BrowserSessionRecord } from "../../workers/browser/src/browser-session-state.js";

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: (...args: unknown[]) => launchMock(...args) },
}));

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "user-1",
  agentId: "naelao-agent",
  runId: "run-1",
  sessionId: "session-1",
  expiresAt: Date.now() + 60_000,
  authorizedOrigins: ["https://example.com"],
  authorizedActions: [],
  maxTier: 4 as const,
};

function makeEnv() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(request: Request) {
        calls.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
        return Response.json({ ok: true, engine_used: "kitesurf", result: { text: "page text" } });
      },
    }),
  };
  return {
    calls,
    env: { ENVIRONMENT: "test", PLATFORM_SECRET, BROWSER: {}, BROWSER_SESSION_DO: namespace },
  };
}

async function request(body: Record<string, unknown>, tenantId = "tenant-1", signed = true): Promise<Request> {
  const headers = new Headers({ "content-type": "application/json", "x-naelao-tenant-id": tenantId });
  if (signed) headers.set("x-naelao-internal-token", await mintInternalToken(PLATFORM_SECRET, tenantId));
  return new Request("https://browser.naelao.com/v1/browser/navigate", {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

describe("browser worker — scoped session protocol", () => {
  it("forwards a verified tenant scope to the session Durable Object", async () => {
    const { env, calls } = makeEnv();
    const res = await browserWorker.fetch(await request({ scope, url: "https://example.com" }), env as never, execCtx);
    const body = await res.json() as { engine_used: string; result: { text: string } };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ engine_used: "kitesurf", result: { text: "page text" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/navigate");
    expect(calls[0]!.body).toMatchObject({ scope, url: "https://example.com" });
    expect(await verifyInternalToken(
      (await request({ scope, url: "https://example.com" })).headers.get("x-naelao-internal-token")!,
      "tenant-1", PLATFORM_SECRET,
    )).toBe(true);
  });

  it("rejects a scope for a different tenant before reaching the session Durable Object", async () => {
    const { env, calls } = makeEnv();
    const res = await browserWorker.fetch(
      await request({ scope: { ...scope, tenantId: "tenant-2" }, url: "https://example.com" }),
      env as never, execCtx,
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed or missing scope before reaching the session Durable Object", async () => {
    const { env, calls } = makeEnv();
    const res = await browserWorker.fetch(await request({ url: "https://example.com" }), env as never, execCtx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "browser_scope_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("rejects direct requests without an internal token", async () => {
    const { env, calls } = makeEnv();
    const res = await browserWorker.fetch(await request({ scope, url: "https://example.com" }, "tenant-1", false), env as never, execCtx);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("BrowserSessionDO — tier 4 Kitesurf provider selection", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; launchMock.mockReset(); });

  it("launches the real browser binding through puppeteer.launch with the Kitesurf option", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://cloudflare-dns.com/")) {
        return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const page = {
      async setBypassServiceWorker() {},
      async evaluateOnNewDocument() {},
      async createCDPSession() {
        return {
          async send(method: string) {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Accessibility.getFullAXTree") return { nodes: [] };
            return {};
          },
          async detach() {},
        };
      },
      async setRequestInterception() {},
      removeAllListeners() {},
      on() {},
      async goto() {},
      url() { return "https://example.com/"; },
      async title() { return "Example"; },
      async evaluate() { return "page text"; },
      async cookies() { return []; },
      async close() {},
    };
    const browser = {
      async pages() { return [page]; },
      async newPage() { return page; },
      on() {},
      async close() {},
    };
    launchMock.mockResolvedValueOnce(browser);

    const values = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async put<T>(key: string, value: T) { values.set(key, value); },
      async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
      async transaction<T>(callback: (target: typeof storage) => Promise<T>) { return callback(storage); },
      async setAlarm() {},
      async deleteAlarm() {},
    };
    const spacesWorker = {
      async fetch() { return Response.json({ data: [{ user_id: scope.actorId, role: "owner" }] }); },
    };
    const instance = new BrowserSessionDO({ storage } as never, {
      ENVIRONMENT: "test", PLATFORM_SECRET, BROWSER: {}, SPACES_WORKER: spacesWorker,
    } as never);
    const response = await instance.fetch(new Request("http://browser/navigate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, url: "https://example.com" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ engine_used: "kitesurf", result: { engine: "kitesurf", text: "page text" } });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(expect.anything(), { browser: "kitesurf" });
  });
});

describe("BrowserSessionDO — screenshot integrity boundary", () => {
  async function requestScreenshot(storedBytes: Uint8Array, responseBytes: Uint8Array) {
    const screenshotScope = { ...scope, maxTier: 5 as const };
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", storedBytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const path = "spaces/tenant-1/space-1/run-1/session-1/shot.png";
    const record: BrowserSessionRecord = {
      scope: screenshotScope, status: "open", engine: "chromium", url: "https://example.com", actions: 0,
      screenshots: [path], lastUsedAt: Date.now(),
      observation: {
        schema: 1, sessionId: screenshotScope.sessionId, revision: "revision-1", engine: "chromium", url: "https://example.com",
        title: "Example", text: "", elements: [], untrusted: true, capturedAt: Date.now(), expiresAt: screenshotScope.expiresAt,
        features: { interactive: true, pixelAccurate: true, persistentLogin: true },
        screenshot: { path, mimeType: "image/png", bytes: storedBytes.byteLength, sha256 },
      },
    };
    const values = new Map<string, unknown>([["browser-session", record]]);
    const storage = {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async put<T>(key: string, value: T) { values.set(key, value); },
      async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
      async transaction<T>(callback: (target: typeof storage) => Promise<T>) { return callback(storage); },
      async setAlarm() {}, async deleteAlarm() {},
    };
    const artifacts = { async get() { return { size: responseBytes.byteLength, async arrayBuffer() { return responseBytes.slice().buffer; } }; } };
    const spacesWorker = { async fetch() { return Response.json({ data: [{ user_id: scope.actorId, role: "owner" }] }); } };
    const instance = new BrowserSessionDO({ storage } as never, {
      ENVIRONMENT: "test", PLATFORM_SECRET, SPACES_WORKER: spacesWorker, BROWSER_ARTIFACTS: artifacts,
    } as never);
    return instance.fetch(new Request("http://browser/see", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: screenshotScope }),
    }));
  }

  it("serves the bounded screenshot bytes whose SHA-256 is in the observation", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const response = await requestScreenshot(bytes, bytes);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rejects an R2 screenshot replacement that no longer matches the observation hash", async () => {
    const response = await requestScreenshot(Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6]));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error_code: "browser_screenshot_integrity_failed" });
  });
});
