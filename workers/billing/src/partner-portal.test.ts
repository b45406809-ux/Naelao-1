import { describe, expect, it } from "vitest";
import { resolveDeveloperAttribution } from "./partner-portal.js";
import worker from "./index.js";

const env = {
  ENVIRONMENT: "test",
  PLATFORM_SECRET: "test-secret",
  PLATFORM_DB: {
    prepare() {
      return { bind() { return { async first() { return null; } }; } };
    },
  },
};

function post(path: string, body: string): Request {
  return new Request(`https://billing.test${path}`, {
    method: path.endsWith("auto-payout") ? "PUT" : "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a" },
    body,
  });
}

describe("Billing partner portal malformed input boundaries", () => {
  it("returns 400 for malformed or non-object subscription JSON", async () => {
    for (const body of ["{", "null", "[]", "\"wrong-shape\""]) {
      const response = await worker.fetch(post("/billing/template-subscriptions", body), env as never, {} as never);
      expect(response.status).toBe(400);
    }
  });

  it("rejects missing marketplace attribution, huge extension arrays, and unsafe monetary values before provider work", async () => {
    const base = { space_id: "space-a", marketplace_listing_id: "listing-a", plan_price_cents: 100, requested_price_cents: 100 };
    const missingListing = await worker.fetch(post("/billing/template-subscriptions", JSON.stringify({ ...base, marketplace_listing_id: undefined })), env as never, {} as never);
    const oversized = await worker.fetch(post("/billing/template-subscriptions", JSON.stringify({ ...base, extensions: Array.from({ length: 65 }, () => ({ wholesaleFeeCents: 1 })) })), env as never, {} as never);
    const unsafe = await worker.fetch(post("/billing/template-subscriptions", JSON.stringify({ ...base, requested_price_cents: Number.MAX_SAFE_INTEGER + 1 })), env as never, {} as never);
    expect(missingListing.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(unsafe.status).toBe(400);
  });

  it("returns 400 for malformed auto-payout JSON instead of a route 500", async () => {
    const response = await worker.fetch(post("/billing/partner/auto-payout", "null"), env as never, {} as never);
    expect(response.status).toBe(400);
  });

  it("derives subscription ownership and template identity from the published marketplace listing", async () => {
    let sql = "";
    const publishedDb = {
      prepare(query: string) {
        sql = query;
        return {
          bind(...args: unknown[]) {
            expect(args).toEqual(["listing-a"]);
            return { first: async () => ({ developer_user_id: "verified-author", template_id: "template-a" }) };
          },
        };
      },
    } as unknown as D1Database;
    await expect(resolveDeveloperAttribution(publishedDb, { space_id: "space", marketplace_listing_id: "listing-a", plan_price_cents: 100, requested_price_cents: 100 }))
      .resolves.toMatchObject({ developerId: "verified-author", templateId: "template-a", channel: "MARKETPLACE_ORGANIC" });
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain("pricing_model = 'freemium_tiered'");
    const missingListingDb = { prepare: () => ({ bind: () => ({ async first() { return null; } }) }) } as unknown as D1Database;
    await expect(resolveDeveloperAttribution(missingListingDb, { space_id: "space", marketplace_listing_id: "draft", plan_price_cents: 100, requested_price_cents: 100 }))
      .rejects.toThrow("published_template_listing_required");
  });
});
