import { describe, expect, it, vi } from "vitest";
import { checkSsrf, resolveHostnameIps } from "./ssrf.js";

describe("SSRF DNS resolution stress boundaries", () => {
  it("fails closed on an oversized DNS-over-HTTPS body", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(70 * 1024)));
    await expect(
      checkSsrf("https://example.com", { fetchImpl })
    ).resolves.toMatchObject({ blocked: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a DNS response contains too many answers", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        Status: 0,
        Answer: Array.from({ length: 257 }, () => ({ data: "93.184.216.34" })),
      })
    );
    await expect(
      checkSsrf("https://example.com", { fetchImpl })
    ).resolves.toMatchObject({ blocked: true });
  });

  it("rejects invalid host lengths before making a DNS request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      resolveHostnameIps("x".repeat(254), fetchImpl)
    ).rejects.toThrow("DNS hostname is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("puts a timeout on both DNS-over-HTTPS lookups", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ Status: 0, Answer: [{ data: "93.184.216.34" }] }));
    await expect(checkSsrf("https://example.com", { fetchImpl })).resolves.toMatchObject({ blocked: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
