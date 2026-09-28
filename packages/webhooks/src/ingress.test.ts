import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { handleWebhookIngress, validateWebhookSignature, type WebhookProvider } from "./ingress.js";
import { repairPayloadSchema } from "./schema-repair.js";

async function signedRequest(provider: WebhookProvider, payload = '{"id":"evt_1"}', secret = "secret"): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = provider === "stripe" ? `${timestamp}.${payload}` : payload;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const base64 = btoa(String.fromCharCode(...bytes));
  const headers = provider === "stripe" ? { "stripe-signature": `t=${timestamp},v1=${hex}` } : provider === "github" ? { "x-hub-signature-256": `sha256=${hex}` } : { "x-shopify-hmac-sha256": base64 };
  return new Request("https://example.test/webhook", { method: "POST", headers, body: payload });
}

describe("webhook ingress defenses", () => {
  it.each(["stripe", "github", "shopify"] as const)("validates %s HMAC and rejects tampering", async (provider) => {
    expect(await validateWebhookSignature(await signedRequest(provider), "secret", provider)).toBe(true);
    expect(await validateWebhookSignature(await signedRequest(provider), "wrong", provider)).toBe(false);
  });

  it.each([["deleted", 410], ["paused", 204]] as const)("short-circuits a %s tombstone", async (state, status) => {
    const get = vi.fn().mockResolvedValue(state);
    const response = await handleWebhookIngress(await signedRequest("github"), { WEBHOOK_TOMBSTONES: { get } as never }, { webhookId: "wh_1", spaceId: "s", provider: "github", eventId: "e", eventType: "push", secret: "secret" });
    expect(response.status).toBe(status);
    expect(get).toHaveBeenCalledWith("tombstone:wh_1");
  });

  it("revalidates an AI-repaired schema drift", async () => {
    const schema = z.object({ customerId: z.string() });
    const run = vi.fn().mockResolvedValue({ response: '{"customerId":"cus_1"}' });
    await expect(repairPayloadSchema({ customer_id: "cus_1" }, schema, { AI: { run } })).resolves.toEqual({ customerId: "cus_1" });
    expect(run).toHaveBeenCalledWith("@cf/meta/llama-3.2-3b-instruct", expect.anything());
  });
});
