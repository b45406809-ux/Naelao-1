import { describe, it, expect } from "vitest";
import { handleLemonSqueezyWebhook } from "../../workers/billing/src/lemon-squeezy.js";
import type { LemonSqueezyEnv } from "../../workers/billing/src/lemon-squeezy.js";

const WEBHOOK_SECRET = "test-ls-webhook-secret";

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("retired Space-owned storefront events", () => {
  it("acknowledges a valid legacy order webhook without waking an agent or applying commerce accounting", async () => {
    const body = JSON.stringify({
      meta: { event_name: "order_created", custom_data: { spaceId: "space-1" } },
      data: { id: "order-1", attributes: { total: 1999, currency: "USD", customer_id: "customer-1", custom_data: { spaceId: "space-1" } } },
    });
    const calls: string[] = [];
    const env = {
      LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_DB: { prepare(sql: string) { calls.push(sql); return { bind() { return this; }, first: async () => null, run: async () => ({ meta: { changes: 1 } }) }; } },
      AGENTS_WORKER: { fetch: async () => { calls.push("agent_wake"); return Response.json({ ok: true }); } },
    } as unknown as LemonSqueezyEnv;
    const response = await handleLemonSqueezyWebhook(new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST", headers: { "X-Signature": await signBody(body) }, body,
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, skipped: true, reason: "legacy_space_commerce_removed" });
    expect(calls).toEqual([]);
  });

  it("continues to reject an invalid signature", async () => {
    const env = { LEMON_SQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET, PLATFORM_DB: {} } as unknown as LemonSqueezyEnv;
    const response = await handleLemonSqueezyWebhook(new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
      method: "POST", headers: { "X-Signature": "bad" }, body: "{}",
    }), env);
    expect(response.status).toBe(401);
  });
});
