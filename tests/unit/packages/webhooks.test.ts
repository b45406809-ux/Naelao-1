// Unit tests for @naelao/webhooks (G-WH01..WH05)
import { describe, it, expect } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../../packages/webhooks/src/index.js";

describe("Webhook signing (G-WH01)", () => {
  it("produces t=<ts>,v1=<hex> format", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload('{"event":"test"}', "my-secret", ts);
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });

  it("includes the correct timestamp", async () => {
    const ts = 1700000000;
    const sig = await signWebhookPayload('{}', "secret", ts);
    expect(sig.startsWith(`t=${ts},`)).toBe(true);
  });

  it("different secrets produce different signatures", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const s1 = await signWebhookPayload("payload", "secret-1", ts);
    const s2 = await signWebhookPayload("payload", "secret-2", ts);
    expect(s1).not.toBe(s2);
  });

  it("different payloads produce different signatures", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const s1 = await signWebhookPayload("payload-a", "secret", ts);
    const s2 = await signWebhookPayload("payload-b", "secret", ts);
    expect(s1).not.toBe(s2);
  });

  it("v1 portion is lowercase hex", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload("test", "key", ts);
    const v1 = sig.split(",v1=")[1] ?? "";
    expect(/^[0-9a-f]+$/.test(v1)).toBe(true);
    expect(v1.length).toBe(64); // HMAC-SHA256 = 32 bytes = 64 hex chars
  });
});

describe("Webhook signature verification (G-WH02)", () => {
  it("verifies a freshly signed payload", async () => {
    const payload = '{"event":"space.created","space_id":"sp_123"}';
    const secret = "test-webhook-secret";
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload(payload, secret, ts);
    const valid = await verifyWebhookSignature(payload, sig, secret);
    expect(valid).toBe(true);
  });

  it("rejects tampered payload", async () => {
    const secret = "secret";
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload("original payload", secret, ts);
    const valid = await verifyWebhookSignature("tampered payload", sig, secret);
    expect(valid).toBe(false);
  });

  it("rejects wrong secret", async () => {
    const payload = "test payload";
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload(payload, "correct-secret", ts);
    const valid = await verifyWebhookSignature(payload, sig, "wrong-secret");
    expect(valid).toBe(false);
  });

  it("rejects stale timestamp (> 5 minutes old)", async () => {
    const payload = "test";
    const staleTs = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const sig = await signWebhookPayload(payload, "secret", staleTs);
    const valid = await verifyWebhookSignature(payload, sig, "secret");
    expect(valid).toBe(false);
  });

  it("accepts timestamp within 5-minute tolerance", async () => {
    const payload = "test";
    const ts = Math.floor(Date.now() / 1000) - 60; // 60s ago — within tolerance
    const sig = await signWebhookPayload(payload, "secret", ts);
    const valid = await verifyWebhookSignature(payload, sig, "secret");
    expect(valid).toBe(true);
  });

  it("rejects malformed signature header", async () => {
    const valid = await verifyWebhookSignature("payload", "not-a-valid-sig", "secret");
    expect(valid).toBe(false);
  });
});
