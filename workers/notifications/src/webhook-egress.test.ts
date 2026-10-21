import { afterEach, describe, expect, it, vi } from "vitest";
import { queue } from "./index.js";

function makeEnv() {
  return {
    WEBHOOK_SIGNING_SECRET: "test-webhook-secret",
    PLATFORM_DB: {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => query.includes("FROM orgs") ? { status: "active" } : { config_json: "{}" },
        }),
      }),
    },
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notification webhook egress", () => {
  it("blocks a public hostname that resolves to a private address", async () => {
    const fetch = vi.fn(async () => Response.json({ Answer: [{ data: "10.12.0.8" }] }));
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ack = vi.fn();
    const retry = vi.fn();

    await queue({ messages: [{
      id: "webhook-private-dns",
      body: { type: "webhook", tenantId: "tenant-a", spaceId: "space-a", webhookUrl: "https://hooks.example.test/path/secret-token?key=secret-query", data: { ok: true } },
      ack,
      retry,
    }] } as never, makeEnv());

    expect(fetch).toHaveBeenCalledTimes(2); // A and AAAA DNS lookups only; webhook was never called.
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret-token|secret-query/);
  });

  it("blocks private IPv6 literal destinations", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ack = vi.fn();

    await queue({ messages: [{
      id: "webhook-private-ipv6",
      body: { type: "webhook", tenantId: "tenant-a", spaceId: "space-a", webhookUrl: "http://[fc00::1]/callback" },
      ack,
      retry: vi.fn(),
    }] } as never, makeEnv());

    expect(fetch).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("delivers to a hostname whose DNS answers are public and bounds the request", async () => {
    let webhookSignal: AbortSignal | undefined;
    let webhookRedirect: string | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("cloudflare-dns.com")) return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      webhookSignal = init?.signal as AbortSignal | undefined;
      webhookRedirect = init?.redirect;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const ack = vi.fn();

    await queue({ messages: [{
      id: "webhook-public-dns",
      body: { type: "webhook", tenantId: "tenant-a", spaceId: "space-a", webhookUrl: "https://hooks.example.test/callback" },
      ack,
      retry: vi.fn(),
    }] } as never, makeEnv());

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(webhookSignal).toBeInstanceOf(AbortSignal);
    expect(webhookRedirect).toBe("error");
    expect(ack).toHaveBeenCalledOnce();
  });

  it("does not log secret-bearing webhook URLs when delivery fails", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("cloudflare-dns.com")) return Response.json({ Answer: [{ data: "93.184.216.34" }] });
      return new Response("rejected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();

    await queue({ messages: [{
      id: "webhook-secret-failure",
      body: {
        type: "webhook", tenantId: "tenant-a", spaceId: "space-a",
        webhookUrl: "https://hooks.example.test/path/secret-token?key=secret-query",
      },
      ack: vi.fn(),
      retry,
    }] } as never, makeEnv());

    expect(retry).toHaveBeenCalledOnce();
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/secret-token|secret-query/);
  });
});
