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

function bindings() {
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
  } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1];
}

async function request(url: string, format?: "markdown" | "html") {
  const token = await mintInternalToken("secret", "tenant");
  const fetchWorker = worker.fetch;
  if (!fetchWorker)
    throw new Error("knowledge worker fetch handler unavailable");
  return fetchWorker(
    new Request("https://knowledge/internal/web-search/fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-space-id": "space",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ url, ...(format ? { format } : {}) }),
    }),
    bindings(),
    {} as ExecutionContext
  );
}

describe("guarded Markdown web fetch", () => {
  beforeEach(() => {
    checkSsrf.mockReset().mockResolvedValue({ blocked: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests Markdown and reports when a site serves it", async () => {
    const outbound = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
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
});
