import { mintInternalToken } from "@naelao/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkSsrf } = vi.hoisted(() => ({
  checkSsrf: vi.fn(
    async (_url: string): Promise<{ blocked: boolean; reason?: string }> => ({
      blocked: false,
    })
  ),
}));
vi.mock("@naelao/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naelao/security")>();
  return { ...actual, checkSsrf };
});

import worker from "./index.js";

function bindings(extra: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({ config_json: "{}" })),
        })),
      })),
    },
    ...extra,
  } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1];
}

async function requestEndpoint(
  endpoint: "fetch" | "extract" | "download",
  url: string,
  format?: "markdown" | "html",
  extraBindings: Record<string, unknown> = {}
) {
  const token = await mintInternalToken("secret", "tenant");
  const fetchWorker = worker.fetch;
  if (!fetchWorker)
    throw new Error("knowledge worker fetch handler unavailable");
  return fetchWorker(
    new Request(`https://knowledge/internal/web-search/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-space-id": "space",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ url, ...(format ? { format } : {}) }),
    }),
    bindings(extraBindings),
    {} as ExecutionContext
  );
}

const request = (url: string, format?: "markdown" | "html") =>
  requestEndpoint("fetch", url, format);

describe("guarded Markdown web fetch", () => {
  beforeEach(() => {
    checkSsrf.mockReset().mockResolvedValue({ blocked: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests Markdown and reports when a site serves it", async () => {
    const outbound = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init?.headers).get("accept")).toContain(
          "text/markdown"
        );
        return new Response("# Docs", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
    );
    vi.stubGlobal("fetch", outbound);
    const response = await request("https://example.com/docs", "markdown");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: "https://example.com/docs",
      format: "markdown",
      markdown_requested: true,
      content: "# Docs",
      truncated: false,
    });
    expect(checkSsrf).toHaveBeenCalledOnce();
  });

  it("revalidates every redirect destination before fetching it", async () => {
    const outbound = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://second.example/path" },
        })
      )
      .mockResolvedValueOnce(
        new Response("body", { headers: { "content-type": "text/plain" } })
      );
    vi.stubGlobal("fetch", outbound);
    const response = await request("https://first.example/");
    await expect(response.json()).resolves.toMatchObject({
      url: "https://second.example/path",
      content: "body",
    });
    expect(checkSsrf.mock.calls.map(([url]) => url)).toEqual([
      "https://first.example/",
      "https://second.example/path",
    ]);
    expect(outbound.mock.calls.map(([url]) => String(url))).toEqual([
      "https://first.example/",
      "https://second.example/path",
    ]);
  });

  it("blocks a redirect rejected by the second SSRF check", async () => {
    checkSsrf
      .mockResolvedValueOnce({ blocked: false })
      .mockResolvedValueOnce({ blocked: true, reason: "private address" });
    const outbound = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      })
    );
    vi.stubGlobal("fetch", outbound);
    const response = await request("https://example.com/");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "forbidden",
      message: "private address",
    });
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("bounds streamed body size and rejects unsupported URL schemes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("a".repeat(60_000))
                );
                controller.enqueue(
                  new TextEncoder().encode("b".repeat(60_000))
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/html" } }
          )
      )
    );
    const response = await request("https://example.com/large");
    await expect(response.json()).resolves.toMatchObject({
      truncated: true,
      content: "a".repeat(60_000) + "b".repeat(40_000),
    });
    const invalid = await request("file:///etc/passwd");
    expect(invalid.status).toBe(400);
  });

  it("rejects oversized web URLs before DNS validation or outbound requests", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await request(`https://example.com/${"x".repeat(2_050)}`);
    expect(response.status).toBe(400);
    expect(checkSsrf).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized search requests before provider egress", async () => {
    const token = await mintInternalToken("secret", "tenant");
    const makeRequest = (body: unknown) => worker.fetch!(new Request("https://knowledge/internal/web-search/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-space-id": "space",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify(body),
    }), bindings({ TAVILY_API_KEY: "test" }), {} as ExecutionContext);
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const longQuery = await makeRequest({ query: "x".repeat(1_001) });
    expect(longQuery.status).toBe(400);
    const invalidCount = await makeRequest({ query: "search", max_results: Number.NaN });
    expect(invalidCount.status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(["extract", "download"] as const)(
    "revalidates a %s redirect before making the next request",
    async (endpoint) => {
      checkSsrf
        .mockResolvedValueOnce({ blocked: false })
        .mockResolvedValueOnce({ blocked: false })
        .mockResolvedValueOnce({ blocked: true, reason: "private address" });
      const outbound = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        })
      );
      vi.stubGlobal("fetch", outbound);
      const response = await requestEndpoint(
        endpoint,
        "https://first.example/"
      );
      expect(response.status).toBe(403);
      expect(outbound).toHaveBeenCalledOnce();
      expect(checkSsrf.mock.calls.map(([url]) => url)).toContain(
        "http://127.0.0.1/private"
      );
    }
  );

  it("stops reading and cancels an oversized binary download at the configured cap", async () => {
    let enqueued = 0;
    let cancelled = false;
    const outbound = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (enqueued >= 20) return controller.close();
              enqueued++;
              controller.enqueue(new Uint8Array(1_000_000));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/pdf" } }
        )
    );
    vi.stubGlobal("fetch", outbound);
    const response = await requestEndpoint(
      "download",
      "https://example.com/large.pdf"
    );
    expect(response.status).toBe(413);
    // A ReadableStream may prefetch one chunk into its own queue, but the route stops after that.
    expect(enqueued).toBeLessThanOrEqual(14);
    expect(cancelled).toBe(true);
  });
});
