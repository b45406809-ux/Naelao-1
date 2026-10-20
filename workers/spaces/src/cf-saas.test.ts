import { afterEach, describe, expect, it, vi } from "vitest";
import { cfSaasConfig, createCustomHostname, getCustomHostname, normalizeCustomHostname } from "./cf-saas.js";

const config = { apiToken: "token", zoneId: "zone_1" };

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare for SaaS hostname boundary", () => {
  it("normalizes public hostnames and rejects malformed or Naelao-owned names", () => {
    expect(normalizeCustomHostname("  Shop.Example.COM. ")).toBe("shop.example.com");
    for (const value of ["localhost", "127.0.0.1", "*.example.com", "x.example.com/path", "naelao.com", "shop.naelao.com", "bad..example.com"]) {
      expect(() => normalizeCustomHostname(value)).toThrow();
    }
  });

  it("sends a normalized hostname to the fixed Cloudflare API and parses DCV records", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_url)).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/custom_hostnames");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
      expect(JSON.parse(String(init?.body)).hostname).toBe("shop.example.com");
      return Response.json({ success: true, result: { id: "cf-id", hostname: "shop.example.com", status: "pending", ssl: { status: "pending_validation", validation_records: [{ txt_name: "_cf", txt_value: "proof" }] } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createCustomHostname(config, "Shop.Example.com");
    expect(result).toMatchObject({ id: "cf-id", hostname: "shop.example.com", status: "pending", ssl_status: "pending_validation", validation_records: [{ txt_name: "_cf", txt_value: "proof" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not call Cloudflare for invalid input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createCustomHostname(config, "shop.naelao.com")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-success HTTP and API responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream failure", { status: 503 })));
    await expect(getCustomHostname(config, "cf-id")).rejects.toThrow("503");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false, errors: [{ code: 1000, message: "denied" }] })));
    await expect(getCustomHostname(config, "cf-id")).rejects.toThrow("denied");
  });

  it("rejects path-injection references before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCustomHostname(config, "../other-zone")).rejects.toThrow("Invalid Cloudflare");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only enables Cloudflare when both deploy secrets are present", () => {
    expect(cfSaasConfig({})).toBeNull();
    expect(cfSaasConfig({ CF_API_TOKEN: "token" })).toBeNull();
    expect(cfSaasConfig({ CF_API_TOKEN: "token", CF_SAAS_ZONE_ID: "zone" })).toEqual({ apiToken: "token", zoneId: "zone" });
  });
});
