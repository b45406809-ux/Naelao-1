import { describe, expect, it, vi } from "vitest";
import {
  EgressPolicyError,
  authorizeEgressRedirect,
  authorizeEgressUrl,
  normalizeAllowedHosts,
} from "./egress-policy.js";

describe("space egress policy boundaries", () => {
  it("normalizes exact grants and rejects wildcards, paths, and unbounded lists", () => {
    expect(
      normalizeAllowedHosts([
        " EXAMPLE.COM. ",
        "*.example.com",
        "example.com/path",
      ])
    ).toEqual(["example.com"]);
    expect(
      normalizeAllowedHosts(Array.from({ length: 1001 }, () => "example.com"))
    ).toEqual([]);
    expect(normalizeAllowedHosts(["x".repeat(254)])).toEqual([]);
  });

  it("requires explicit host, scheme, and port grants before DNS resolution", async () => {
    const dns = vi.fn() as unknown as typeof fetch;
    await expect(
      authorizeEgressUrl(
        "https://sub.example.com/path",
        { allowedHosts: ["example.com"] },
        dns
      )
    ).rejects.toMatchObject({ code: "host_not_granted" });
    await expect(
      authorizeEgressUrl(
        "http://example.com",
        { allowedHosts: ["example.com"] },
        dns
      )
    ).rejects.toMatchObject({ code: "scheme_denied" });
    await expect(
      authorizeEgressUrl(
        "https://example.com:8443",
        { allowedHosts: ["example.com"] },
        dns
      )
    ).rejects.toMatchObject({ code: "port_denied" });
    expect(dns).not.toHaveBeenCalled();
  });

  it("denies a granted hostname that resolves to a private address", async () => {
    const dns = vi.fn(async () =>
      Response.json({ Status: 0, Answer: [{ data: "10.0.0.4" }] })
    ) as unknown as typeof fetch;
    await expect(
      authorizeEgressUrl(
        "https://example.com",
        { allowedHosts: ["example.com"] },
        dns
      )
    ).rejects.toMatchObject({ code: "network_denied" });
  });

  it("keeps authenticated redirects on the authorized origin", async () => {
    const dns = vi.fn(async () =>
      Response.json({ Status: 0, Answer: [{ data: "93.184.216.34" }] })
    ) as unknown as typeof fetch;
    const policy = { allowedHosts: ["example.com", "other.example"] };
    await expect(
      authorizeEgressRedirect("https://example.com/start", "/next", policy, dns)
    ).resolves.toBeInstanceOf(URL);
    await expect(
      authorizeEgressRedirect(
        "https://example.com/start",
        "https://other.example/next",
        policy,
        dns
      )
    ).rejects.toBeInstanceOf(EgressPolicyError);
  });
});
