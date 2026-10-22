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

  it("rejects huge extension arrays and unsafe monetary values before provider work", async () => {
    const base = { space_id: "space-a", template_id: "template-a", plan_price_cents: 100, requested_price_cents: 100, developer_user_id: "dev-a" };
    const oversized = await worker.fetch(post("/billing/template-subscriptions", JSON.stringify({ ...base, extensions: Array.from({ length: 65 }, () => ({ wholesaleFeeCents: 1 })) })), env as never, {} as never);
    const unsafe = await worker.fetch(post("/billing/template-subscriptions", JSON.stringify({ ...base, requested_price_cents: Number.MAX_SAFE_INTEGER + 1 })), env as never, {} as never);
    expect(oversized.status).toBe(400);
    expect(unsafe.status).toBe(400);
  });

  it("returns 400 for malformed auto-payout JSON instead of a route 500", async () => {
    const response = await worker.fetch(post("/billing/partner/auto-payout", "null"), env as never, {} as never);
    expect(response.status).toBe(400);
  });

  it("only assigns organic commissions to an active developer partner profile", async () => {
    const inactiveDb = { prepare: () => ({ bind: () => ({ async first() { return null; } }) }) } as unknown as D1Database;
    await expect(resolveDeveloperAttribution(inactiveDb, { space_id: "space", template_id: "template", developer_user_id: "user" }))
      .rejects.toThrow("developer_profile_required");
    const activeDb = { prepare: () => ({ bind: () => ({ async first() { return { user_id: "verified-user" }; } }) }) } as unknown as D1Database;
    await expect(resolveDeveloperAttribution(activeDb, { space_id: "space", template_id: "template", developer_user_id: "user" }))
      .resolves.toMatchObject({ developerId: "verified-user", channel: "MARKETPLACE_ORGANIC" });
  });
});
