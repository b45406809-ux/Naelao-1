import { describe, it, expect } from "vitest";
import {
  verifyWebhookSignature,
  normalizeWebhook,
  webhookGoal,
} from "../../workers/agents/src/connectors/webhook-normalizer.js";
import type { WebhookSpec } from "../../workers/agents/src/connectors/webhook-normalizer.js";
import { getConnector } from "../../workers/agents/src/connectors/catalogue.js";

const WHOP_SPEC: WebhookSpec = {
  signature_header: "x-whop-signature",
  signature_encoding: "hex",
  event_path: "action",
  secret_credential_name: "WHOP_WEBHOOK_SECRET",
};

async function sign(body: string, secret: string, encoding: "hex" | "base64"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  if (encoding === "base64") {
    let s = ""; for (const b of new Uint8Array(sig)) s += String.fromCharCode(b); return btoa(s);
  }
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("connector webhook normalizer (#3)", () => {
  it("accepts a correctly-signed body", async () => {
    const body = JSON.stringify({ action: "membership.went_valid", data: { id: "mem_1" } });
    const sig = await sign(body, "shhh", "hex");
    expect(await verifyWebhookSignature(WHOP_SPEC, body, sig, "shhh")).toBe(true);
  });

  it("rejects a wrong signature, wrong secret, or missing header", async () => {
    const body = JSON.stringify({ action: "x" });
    const good = await sign(body, "shhh", "hex");
    expect(await verifyWebhookSignature(WHOP_SPEC, body, good, "different-secret")).toBe(false);
    expect(await verifyWebhookSignature(WHOP_SPEC, body, "deadbeef", "shhh")).toBe(false);
    expect(await verifyWebhookSignature(WHOP_SPEC, body, null, "shhh")).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const sig = await sign(JSON.stringify({ action: "x" }), "shhh", "hex");
    const tampered = JSON.stringify({ action: "x", injected: true });
    expect(await verifyWebhookSignature(WHOP_SPEC, tampered, sig, "shhh")).toBe(false);
  });

  it("strips a signature prefix before comparing", async () => {
    const spec: WebhookSpec = { ...WHOP_SPEC, signature_prefix: "sha256=" };
    const body = JSON.stringify({ action: "x" });
    const sig = await sign(body, "shhh", "hex");
    expect(await verifyWebhookSignature(spec, body, `sha256=${sig}`, "shhh")).toBe(true);
  });

  it("normalizes the event type from the configured path", () => {
    const n = normalizeWebhook("whop", WHOP_SPEC, JSON.stringify({ action: "payment.succeeded", data: { id: "p1" } }));
    expect(n).toEqual({ platform: "whop", event_type: "payment.succeeded", payload: { action: "payment.succeeded", data: { id: "p1" } } });
  });

  it("falls back to 'unknown' on an unparseable body and produces a safe goal", () => {
    const n = normalizeWebhook("whop", WHOP_SPEC, "not json");
    expect(n.event_type).toBe("unknown");
    expect(webhookGoal(n)).toMatch(/untrusted external data/);
  });

  it("the Whop connector ships a webhook spec referencing a vault secret", () => {
    const whop = getConnector("whop");
    expect(whop?.webhook?.signature_header).toBe("x-whop-signature");
    expect(whop?.webhook?.secret_credential_name).toBe("WHOP_WEBHOOK_SECRET");
  });
});
