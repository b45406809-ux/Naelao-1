// MS-47 item 4: the template resource proposal path is allowlisted for product sessions (exact path only) and reaches Spaces.
import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, PRODUCT_END_USER_PATH_PATTERNS, type Env } from "./index";

const allowed = (path: string) => PRODUCT_END_USER_PATH_PATTERNS.some(pattern => pattern.test(path));

describe("template resource proposals routing (MS-47)", () => {
  it("accepts the exact list/decision path for a Space", () => {
    expect(allowed("/spaces/space-1/template-resource-proposals")).toBe(true);
    expect(PRODUCT_END_USER_PATH_PATTERNS.map(p => p.exec("/spaces/space-1/template-resource-proposals")).find(Boolean)?.[1]).toBe("space-1");
  });

  it("rejects sub-paths, trailing slashes, extra segments and look-alikes", () => {
    for (const path of ["/spaces/s/template-resource-proposals/", "/spaces/s/template-resource-proposals/x", "/spaces/s/template-resource-proposals/x/approve",
      "/spaces/s/x/template-resource-proposals", "/spaces/template-resource-proposals", "/spaces/s/template-resource-proposal", "/template-resource-proposals"]) {
      expect(allowed(path), path).toBe(false);
    }
  });

  it("proxies GET and POST to Spaces unchanged for an owner", async () => {
    const secret = "template-resource-router-test-secret";
    const seen: string[] = [];
    const spacesFetch = vi.fn(async (request: Request) => { seen.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ reached: "spaces" }); });
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const PLATFORM_DB = { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", reseller_status: "active" }) }) }) } as unknown as D1Database;
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, PLATFORM_DB, SPACES_WORKER: { fetch: spacesFetch }, AGENTS_WORKER: { fetch: vi.fn() } } as unknown as Env;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.request("/v1/spaces/space-1/template-resource-proposals", { headers }, env)).status).toBe(200);
    expect((await app.request("/v1/spaces/space-1/template-resource-proposals", { method: "POST", headers, body: JSON.stringify({ id: "p", decision: "skip" }) }, env)).status).toBe(200);
    expect(seen).toEqual(["GET /spaces/space-1/template-resource-proposals", "POST /spaces/space-1/template-resource-proposals"]);
  });
});
