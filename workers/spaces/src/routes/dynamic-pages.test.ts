import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorResponse, mintInternalToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import { registerDynamicPageRoutes } from "./dynamic-pages.js";

function harness(suffix = "preview.test", applicationSuffix = "app.test", tenantActive = true) {
  const idFromName = vi.fn((name: string) => name as never);
  const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, method: request.method }));
  const app = new Hono();
  app.onError(error => errorResponse(error, "test"));
  registerDynamicPageRoutes(app as never);
  const env = {
    PLATFORM_SECRET: "test-secret",
    DYNAMIC_PAGE_HOST_SUFFIX: suffix,
    APPLICATION_HOST_SUFFIX: applicationSuffix,
    PLATFORM_DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => tenantActive && args[0] === "s" ? { tenant_id: "tenant-a" } : null }) }) },
    MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
  } as never;
  return { app, env, idFromName, fetch };
}

describe("dynamic page isolation boundary", () => {
  it("restricts publication to a tenant's space administrators", async () => {
    const h = harness();
    const path = "/spaces/s/apps/app/pages";
    const token = await mintInternalToken("test-secret", "tenant-a");
    const denied = await h.app.request(path, { method: "POST", headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "member-a", "x-naelao-internal-token": token, "x-naelao-role": "member" }, body: "{}" }, h.env);
    expect(denied.status).toBe(403);
    const allowed = await h.app.request(path, { method: "POST", headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-internal-token": token, "x-naelao-role": "owner" }, body: "{}" }, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/review", method: "POST" });
    expect(h.fetch).toHaveBeenCalledOnce();
    const forged = await h.app.request(path, { method: "POST", headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" }, body: "{}" }, h.env);
    expect(forged.status).toBe(403);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("lists page receipts only for an authenticated Space owner or admin", async () => {
    const h = harness();
    const path = "/spaces/s/apps/app/pages";
    const token = await mintInternalToken("test-secret", "tenant-a");
    const headers = { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-internal-token": token };
    expect((await h.app.request(path, { headers: { ...headers, "x-naelao-role": "member" } }, h.env)).status).toBe(403);
    const response = await h.app.request(path, { headers: { ...headers, "x-naelao-role": "admin" } }, h.env);
    expect(await response.json()).toEqual({ path: "/page/list", method: "GET" });
    expect(h.idFromName).toHaveBeenCalledWith("gadget:app:space:s");
    const forged = await h.app.request(path, { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" } }, h.env);
    expect(forged.status).toBe(403);
  });

  it("publishes only through a separately owner-authorized reviewed receipt", async () => {
    const h = harness();
    const token = await mintInternalToken("test-secret", "tenant-a");
    const response = await h.app.request("/spaces/s/apps/app/pages/publish", { method: "POST", headers: {
      "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-internal-token": token, "x-naelao-role": "owner",
    }, body: JSON.stringify({ review_id: "123e4567-e89b-12d3-a456-426614174000", draft: { slug: "signup" } }) }, h.env);
    expect(await response.json()).toEqual({ path: "/page/publish-reviewed", method: "POST" });
    expect(JSON.parse(await h.fetch.mock.calls[0]![0].clone().text())).toMatchObject({ actor_id: "owner-a", review_id: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("distinguishes malformed page JSON from an oversized request", async () => {
    const h = harness();
    const token = await mintInternalToken("test-secret", "tenant-a");
    const headers = { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-internal-token": token, "x-naelao-role": "owner" };
    const malformed = await h.app.request("/spaces/s/apps/app/pages", { method: "POST", headers, body: "{" }, h.env);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error_code: "invalid_json" });
    const oversized = await h.app.request("/spaces/s/apps/app/pages", { method: "POST", headers,
      body: new Uint8Array(1024 * 1024 + 1) }, h.env);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error_code: "payload_too_large" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("allows only a tenant Space owner/admin to take down an exact public page", async () => {
    const h = harness();
    const path = "/spaces/s/apps/app/pages/spring-signup";
    const token = await mintInternalToken("test-secret", "tenant-a");
    const headers = { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-internal-token": token };
    const denied = await h.app.request(path, { method: "DELETE", headers: { ...headers, "x-naelao-role": "member" } }, h.env);
    expect(denied.status).toBe(403);
    const allowed = await h.app.request(path, { method: "DELETE", headers: { ...headers, "x-naelao-role": "admin" } }, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/unpublish", method: "DELETE" });
    expect(new URL(h.fetch.mock.calls[0]![0].url).searchParams.get("slug")).toBe("spring-signup");
    expect(await h.fetch.mock.calls[0]![0].clone().json()).toEqual({ actor_id: "owner-a" });
    expect(h.idFromName).toHaveBeenCalledWith("gadget:app:space:s");
  });

  it("serves a page only from that tenant's dedicated preview origin", async () => {
    const h = harness();
    const denied = await h.app.request("https://app.example.test/p/s/app/sign", undefined, h.env);
    expect(denied.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
    const allowed = await h.app.request("https://tenant-a.preview.test/p/s/app/sign", undefined, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/render", method: "GET" });
    expect(h.idFromName).toHaveBeenCalledWith("gadget:app:space:s");
  });

  it("blocks public pages and actions after the tenant or Space is suspended", async () => {
    const h = harness("preview.test", "app.test", false);
    const page = await h.app.request("https://tenant-a.preview.test/p/s/app/sign", undefined, h.env);
    const action = await h.app.request("https://tenant-a.preview.test/p/s/app/sign/actions/submit", {
      method: "POST", headers: { origin: "https://tenant-a.preview.test" }, body: "{}",
    }, h.env);
    expect(page.status).toBe(404);
    expect(action.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("requires a same-origin POST for the public form action", async () => {
    const h = harness();
    const path = "https://tenant-a.preview.test/p/s/app/sign/actions/submit";
    const denied = await h.app.request(path, { method: "POST", headers: { origin: "https://attacker.test" }, body: "{}" }, h.env);
    expect(denied.status).toBe(403);
    const allowed = await h.app.request(path, { method: "POST", headers: { origin: "https://tenant-a.preview.test", "cf-connecting-ip": "203.0.113.4" }, body: "{}" }, h.env);
    expect(await allowed.json()).toEqual({ path: "/page/action", method: "POST" });
    const forwarded = h.fetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("x-naelao-page-client")).toBe(await signHmac(JSON.stringify(["public-page-action-client-v1", "203.0.113.4"]), "test-secret"));
    const missingIdentity = await h.app.request(path, { method: "POST", headers: { origin: "https://tenant-a.preview.test" }, body: "{}" }, h.env);
    expect(missingIdentity.status).toBe(503);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("keeps pages disabled without a dedicated origin configuration", async () => {
    const h = harness("");
    const response = await h.app.request("https://tenant-a.preview.test/p/s/app/sign", undefined, h.env);
    expect(response.status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("rejects a preview suffix beneath the application cookie domain", async () => {
    const h = harness("preview.app.test", "app.test");
    const response = await h.app.request("https://tenant-a.preview.app.test/p/s/app/sign", undefined, h.env);
    expect(response.status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
