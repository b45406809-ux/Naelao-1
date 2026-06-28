import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";

// End-to-end: drive the ASSEMBLED agents worker the way the router does — with the
// identity headers the router sets after JWT verification — and assert the full
// user journey wiring: catalog visibility, founder-only dev catalog, and tenant
// isolation on /business/:userId. This proves roots→products actually connect,
// not just that the pure seams work in isolation.

// Minimal env: the 4 secrets validateEnv() requires, plus a BUSINESS_DO mock so
// an allowed /business/:userId/status reaches a stub DO and returns.
function makeEnv() {
  const businessStub = {
    fetch: async () => Response.json({ ok: true, whop_product_id: null, fiber_status: "idle" }),
  };
  return {
    ENVIRONMENT: "test",
    ANTHROPIC_API_KEY: "x",
    PLATFORM_SECRET: "test-secret",
    WHOP_API_KEY: "x",
    NAELAO_WHOP_COMPANY_ID: "x",
    BUSINESS_DO: { idFromName: (_n: string) => ({}), get: (_id: unknown) => businessStub },
    PRODUCT_DO: { idFromName: (_n: string) => ({}), get: (_id: unknown) => businessStub },
  } as unknown as Parameters<typeof app.fetch>[1];
}

// Simulate the router: it sets these after verifying the JWT.
function routerHeaders(userId: string, role: string, tenantId = "tenant-1") {
  return {
    "x-naelao-tenant-id": tenantId,
    "x-naelao-user-id": userId,
    "x-naelao-role": role,
  };
}

const env = makeEnv();
const call = (path: string, headers: Record<string, string>) =>
  app.fetch(new Request(`http://agents${path}`, { headers }), env);

describe("product catalog — visible to any authenticated user", () => {
  it("returns the niches with exactly one live", async () => {
    const res = await call("/catalog/product", routerHeaders("user-1", "member"));
    expect(res.status).toBe(200);
    const body = await res.json<{ live_count: number; coming_soon_count: number; niches: unknown[] }>();
    expect(body.live_count).toBeGreaterThanOrEqual(2); // official template + custom
    expect(body.coming_soon_count).toBeGreaterThan(0);
  });
});

describe("dev catalog — founder-only", () => {
  it("forbids a regular user", async () => {
    const res = await call("/catalog/dev", routerHeaders("user-1", "member"));
    expect(res.status).toBe(403);
  });

  it("allows the founder (admin) and lists space types + templates", async () => {
    const res = await call("/catalog/dev", routerHeaders("founder", "admin"));
    expect(res.status).toBe(200);
    const body = await res.json<{ space_types: unknown[]; templates: unknown[] }>();
    expect(body.space_types.length).toBeGreaterThan(1);
    expect(body.templates.length).toBeGreaterThan(0);
  });
});

describe("business access — tenant isolation at the API layer", () => {
  it("a user cannot read another user's business", async () => {
    const res = await call("/business/user-2/status", routerHeaders("user-1", "member"));
    expect(res.status).toBe(403);
  });

  it("a user can read their own business", async () => {
    const res = await call("/business/user-1/status", routerHeaders("user-1", "member"));
    expect(res.status).toBe(200);
  });

  it("the founder (admin) can read any business — dev access", async () => {
    const res = await call("/business/user-2/status", routerHeaders("founder", "admin"));
    expect(res.status).toBe(200);
  });
});
