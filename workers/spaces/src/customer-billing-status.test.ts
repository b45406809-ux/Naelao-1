import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "product-billing-status-spaces-test";

function harness() {
  const sql: Array<{ query: string; args: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      return { bind(...args: unknown[]) {
        sql.push({ query, args });
        return { async first() {
          if (query.includes("SELECT id, tenant_id, spacetype_id FROM products")) return { id: "product-1", tenant_id: "tenant-1", spacetype_id: "type-1" };
          if (query.includes("FROM product_end_users")) return { 1: 1 };
          return null;
        } };
      } };
    },
  } as unknown as D1Database;
  const calls: Request[] = [];
  const billing = { fetch: vi.fn(async (request: Request) => {
    calls.push(request);
    return Response.json({ subscription: { plan_tier: "growth", status: "past_due", current_period_end: null }, notifications: [] });
  }) };
  return { sql, calls, billing, PLATFORM_DB: db, PLATFORM_SECRET: secret, BILLING_WORKER: billing };
}

async function get(env: ReturnType<typeof harness>, role: string, userId: string, signed = true) {
  const token = signed ? await mintInternalToken(secret, "tenant-1") : "invalid";
  return worker.fetch(new Request("https://spaces.test/spaces/product-1/customer-billing-status?end_user_id=attacker-chosen", {
    method: "GET",
    headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": role, "x-naelao-user-id": userId, "x-naelao-internal-token": token },
  }), env as never, {} as never);
}

describe("Product-user billing status handoff", () => {
  it("requires Router HMAC and rejects non-Product-user roles", async () => {
    const unsigned = harness();
    expect((await get(unsigned, "product_end_user", "user-1", false)).status).toBe(403);
    expect(unsigned.sql).toHaveLength(0);

    const builder = harness();
    expect((await get(builder, "owner", "user-1")).status).toBe(403);
    expect(builder.calls).toHaveLength(0);
  });

  it("derives the Billing query from authenticated Space identity instead of request parameters", async () => {
    const env = harness();
    const response = await get(env, "product_end_user", "verified-user");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subscription: { status: "past_due" } });
    expect(env.sql.map(item => item.args)).toEqual([["product-1", "tenant-1"], ["product-1", "verified-user"]]);
    expect(env.calls).toHaveLength(1);
    const billingRequest = env.calls[0]!;
    expect(new Headers(billingRequest.headers).get("x-naelao-tenant-id")).toBe("tenant-1");
    expect(await billingRequest.json()).toEqual({ product_id: "product-1", end_user_id: "verified-user" });
  });
});
