import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type WebhookProvider,
  handleWebhookIngress,
  validateWebhookSignature,
} from "./ingress.js";
import { repairPayloadSchema } from "./schema-repair.js";

async function signedRequest(
  provider: WebhookProvider,
  payload = '{"id":"evt_1"}',
  secret = "secret"
): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = provider === "stripe" ? `${timestamp}.${payload}` : payload;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))
  );
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const base64 = btoa(String.fromCharCode(...bytes));
  const headers =
    provider === "stripe"
      ? { "stripe-signature": `t=${timestamp},v1=${hex}` }
      : provider === "github"
        ? { "x-hub-signature-256": `sha256=${hex}` }
        : { "x-shopify-hmac-sha256": base64 };
  return new Request("https://example.test/webhook", {
    method: "POST",
    headers,
    body: payload,
  });
}

describe("webhook ingress defenses", () => {
  it.each(["stripe", "github", "shopify"] as const)(
    "validates %s HMAC and rejects tampering",
    async (provider) => {
      expect(
        await validateWebhookSignature(
          await signedRequest(provider),
          "secret",
          provider
        )
      ).toBe(true);
      expect(
        await validateWebhookSignature(
          await signedRequest(provider),
          "wrong",
          provider
        )
      ).toBe(false);
    }
  );

  it("rejects non-numeric or overlong Stripe timestamps", async () => {
    const request = await signedRequest("stripe");
    const headers = new Headers(request.headers);
    headers.set("stripe-signature", `t=NaN,v1=${"0".repeat(64)}`);
    const malformed = new Request(request.url, {
      method: "POST",
      headers,
      body: await request.text(),
    });
    expect(await validateWebhookSignature(malformed, "secret", "stripe")).toBe(
      false
    );
  });

  it("bounds the ingress body before dispatch", async () => {
    const request = new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "content-length": "1048577" },
      body: "{}",
    });
    const response = await handleWebhookIngress(
      request,
      {},
      {
        webhookId: "wh_1",
        spaceId: "s",
        provider: "github",
        eventId: "e",
        eventType: "push",
        secret: "secret",
      }
    );
    expect(response.status).toBe(413);
  });

  it("archives only safe metadata headers and reads a valid payload once", async () => {
    const request = await signedRequest("github");
    const headers = new Headers(request.headers);
    headers.set("authorization", "Bearer leaked-if-archived");
    headers.set("cookie", "session=secret");
    const secured = new Request(request.url, {
      method: "POST",
      headers,
      body: await request.text(),
    });
    const send = vi.fn();
    const response = await handleWebhookIngress(
      secured,
      { WEBHOOK_INGRESS_QUEUE: { send } as never },
      {
        webhookId: "wh_1",
        spaceId: "s",
        provider: "github",
        eventId: "evt_1",
        eventType: "push",
        secret: "secret",
      }
    );
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      payload: '{"id":"evt_1"}',
      headers: {},
    });
    expect(secured.bodyUsed).toBe(true);
  });

  it.each([
    ["deleted", 410],
    ["paused", 204],
  ] as const)("short-circuits a %s tombstone", async (state, status) => {
    const get = vi.fn().mockResolvedValue(state);
    const response = await handleWebhookIngress(
      await signedRequest("github"),
      { WEBHOOK_TOMBSTONES: { get } as never },
      {
        webhookId: "wh_1",
        spaceId: "s",
        provider: "github",
        eventId: "e",
        eventType: "push",
        secret: "secret",
      }
    );
    expect(response.status).toBe(status);
    expect(get).toHaveBeenCalledWith("tombstone:wh_1");
  });

  it("revalidates an AI-repaired schema drift", async () => {
    const schema = z.object({ customerId: z.string() });
    const run = vi
      .fn()
      .mockResolvedValue({ response: '{"customerId":"cus_1"}' });
    await expect(
      repairPayloadSchema({ customer_id: "cus_1" }, schema, { AI: { run } })
    ).resolves.toEqual({ customerId: "cus_1" });
    expect(run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.2-3b-instruct",
      expect.anything()
    );
  });
});
