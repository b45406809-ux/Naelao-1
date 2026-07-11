import { describe, it, expect } from "vitest";
import { getAdapter, isChannelType, sessionKey } from "../../workers/agents/src/launchpad/channels.js";

// One adapter interface across channels (appendix @4211129/@4198622/@4200734/@3190360).

describe("channel adapters — inbound normalization", () => {
  it("normalizes an email payload", () => {
    const n = getAdapter("email")!.normalizeInbound({ from: "User@Example.com", text: "hi", message_id: "m1" });
    expect(n).toEqual({ channel: "email", channel_user_id: "user@example.com", text: "hi", external_id: "m1", timestamp: expect.any(Number) });
  });

  it("normalizes a slack payload and ignores bot echoes", () => {
    const a = getAdapter("slack")!;
    expect(a.normalizeInbound({ user: "U1", text: "hello", ts: "1700000000.0001" })?.channel_user_id).toBe("U1");
    expect(a.normalizeInbound({ bot_id: "B1", user: "U1", text: "x", ts: "1" })).toBeNull(); // bot echo ignored
  });

  it("normalizes a discord payload and ignores bots", () => {
    const a = getAdapter("discord")!;
    expect(a.normalizeInbound({ author: { id: "D1" }, content: "yo", id: "msg1" })?.channel_user_id).toBe("D1");
    expect(a.normalizeInbound({ author: { id: "D1", bot: true }, content: "x", id: "m" })).toBeNull();
  });

  it("returns null for incomplete payloads (no crash)", () => {
    expect(getAdapter("email")!.normalizeInbound({})).toBeNull();
    expect(getAdapter("slack")!.normalizeInbound({ user: "U1" })).toBeNull();
  });

  it("normalizes a WhatsApp Cloud API text message", () => {
    const raw = {
      entry: [{ changes: [{ value: { messages: [{ from: "16505551234", id: "wamid.X", timestamp: "1700000000", text: { body: "hi there" } }] } }] }],
    };
    const n = getAdapter("whatsapp")!.normalizeInbound(raw);
    expect(n).toEqual({ channel: "whatsapp", channel_user_id: "16505551234", text: "hi there", external_id: "wamid.X", timestamp: 1700000000000 });
  });

  it("ignores WhatsApp delivery-receipt (statuses) callbacks", () => {
    const raw = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }] };
    expect(getAdapter("whatsapp")!.normalizeInbound(raw)).toBeNull();
  });

  it("ignores non-text WhatsApp messages (not handled yet) without crashing", () => {
    const raw = { entry: [{ changes: [{ value: { messages: [{ from: "1650555", id: "w1", type: "image" }] } }] }] };
    expect(getAdapter("whatsapp")!.normalizeInbound(raw)).toBeNull();
  });
});

describe("channel adapters — outbound formatting", () => {
  it("formats per channel", () => {
    expect(getAdapter("slack")!.formatOutbound({ text: "hi" })).toHaveProperty("blocks");
    expect(getAdapter("discord")!.formatOutbound({ text: "hi" })).toEqual({ content: "hi" });
    expect(getAdapter("email")!.formatOutbound({ text: "hi" })).toMatchObject({ body: "hi" });
    expect(getAdapter("whatsapp")!.formatOutbound({ text: "hi" })).toEqual({ messaging_product: "whatsapp", type: "text", text: { body: "hi" } });
  });
});

describe("per-user session keys (appendix @3245389 — no cross-user bleed)", () => {
  it("includes the channel user id, so two Slack users get different sessions", () => {
    expect(sessionKey("slack", "U1")).not.toBe(sessionKey("slack", "U2"));
    expect(sessionKey("slack", "U1")).toBe("slack:U1");
  });
});

describe("channel type guard", () => {
  it("accepts known channels, rejects unknown", () => {
    expect(isChannelType("email")).toBe(true);
    expect(isChannelType("whatsapp")).toBe(true);
    expect(isChannelType("telegram")).toBe(false);
    expect(getAdapter("telegram")).toBeUndefined();
  });
});

// Inbound webhook signature verification (appendix: "Outbound Webhooks Not Verified by
// Default" — applies symmetrically to inbound channel ingress). Each channel verifies
// against its own real scheme: Slack HMAC-SHA256, Discord Ed25519, email HMAC (Mailgun-style).

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("channel adapters — inbound signature verification", () => {
  it("Slack: valid HMAC-SHA256(v0:timestamp:body) passes, tampered body fails", async () => {
    const secret = "slack-signing-secret";
    const rawBody = JSON.stringify({ type: "event_callback" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
    const adapter = getAdapter("slack")!;

    const ok = await adapter.verifySignature({
      rawBody,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      secret,
    });
    expect(ok).toBe(true);

    const tampered = await adapter.verifySignature({
      rawBody: rawBody + "x",
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      secret,
    });
    expect(tampered).toBe(false);
  });

  it("Slack: rejects a replayed (stale) timestamp even with a correct signature", async () => {
    const secret = "slack-signing-secret";
    const rawBody = "{}";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes old
    const signature = `v0=${await hmacSha256Hex(secret, `v0:${staleTimestamp}:${rawBody}`)}`;
    const ok = await getAdapter("slack")!.verifySignature({
      rawBody,
      headers: { "x-slack-request-timestamp": staleTimestamp, "x-slack-signature": signature },
      secret,
    });
    expect(ok).toBe(false);
  });

  it("Slack: rejects when the secret is wrong", async () => {
    const rawBody = "{}";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${await hmacSha256Hex("correct-secret", `v0:${timestamp}:${rawBody}`)}`;
    const ok = await getAdapter("slack")!.verifySignature({
      rawBody,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      secret: "wrong-secret",
    });
    expect(ok).toBe(false);
  });

  it("Discord: valid Ed25519 signature passes, tampered body fails", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const publicKeyHex = [...publicKeyBytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    const rawBody = JSON.stringify({ type: 1 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(timestamp + rawBody))
    );
    const signatureHex = [...sigBytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    const adapter = getAdapter("discord")!;
    const ok = await adapter.verifySignature({
      rawBody,
      headers: { "x-signature-ed25519": signatureHex, "x-signature-timestamp": timestamp },
      secret: publicKeyHex,
    });
    expect(ok).toBe(true);

    const tampered = await adapter.verifySignature({
      rawBody: rawBody + "x",
      headers: { "x-signature-ed25519": signatureHex, "x-signature-timestamp": timestamp },
      secret: publicKeyHex,
    });
    expect(tampered).toBe(false);
  });

  it("email: valid Mailgun-style HMAC(timestamp+token) passes, wrong secret fails", async () => {
    const secret = "mailgun-key";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "tok123";
    const signature = await hmacSha256Hex(secret, `${timestamp}${token}`);
    const adapter = getAdapter("email")!;

    const ok = await adapter.verifySignature({
      rawBody: "from=a@b.com&text=hi",
      headers: { "x-mailgun-timestamp": timestamp, "x-mailgun-token": token, "x-mailgun-signature": signature },
      secret,
    });
    expect(ok).toBe(true);

    const wrong = await adapter.verifySignature({
      rawBody: "from=a@b.com&text=hi",
      headers: { "x-mailgun-timestamp": timestamp, "x-mailgun-token": token, "x-mailgun-signature": signature },
      secret: "wrong",
    });
    expect(wrong).toBe(false);
  });

  it("email: rejects a replayed (stale) timestamp even with a correct signature", async () => {
    const secret = "mailgun-key";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes old
    const token = "tok123";
    const signature = await hmacSha256Hex(secret, `${staleTimestamp}${token}`);
    const ok = await getAdapter("email")!.verifySignature({
      rawBody: "from=a@b.com&text=hi",
      headers: { "x-mailgun-timestamp": staleTimestamp, "x-mailgun-token": token, "x-mailgun-signature": signature },
      secret,
    });
    expect(ok).toBe(false);
  });

  it("Discord: rejects a replayed (stale) timestamp even with a correct signature", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const publicKeyHex = [...publicKeyBytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    const rawBody = JSON.stringify({ type: 1 });
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes old
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(staleTimestamp + rawBody))
    );
    const signatureHex = [...sigBytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    const ok = await getAdapter("discord")!.verifySignature({
      rawBody,
      headers: { "x-signature-ed25519": signatureHex, "x-signature-timestamp": staleTimestamp },
      secret: publicKeyHex,
    });
    expect(ok).toBe(false);
  });

  it("WhatsApp (Meta Cloud API): valid HMAC-SHA256(rawBody, app_secret) passes, tampered body fails", async () => {
    const secret = "meta-app-secret";
    const rawBody = JSON.stringify({ entry: [] });
    const header = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
    const adapter = getAdapter("whatsapp")!;

    const ok = await adapter.verifySignature({ rawBody, headers: { "x-hub-signature-256": header }, secret });
    expect(ok).toBe(true);

    const tampered = await adapter.verifySignature({ rawBody: rawBody + "x", headers: { "x-hub-signature-256": header }, secret });
    expect(tampered).toBe(false);
  });

  it("WhatsApp: rejects a replayed message with a stale embedded timestamp even with a correct signature", async () => {
    const secret = "meta-app-secret";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes old
    const rawBody = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "165", id: "wamid.replay", timestamp: staleTimestamp, text: { body: "hi" } }] } }] }],
    });
    const header = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
    const ok = await getAdapter("whatsapp")!.verifySignature({ rawBody, headers: { "x-hub-signature-256": header }, secret });
    expect(ok).toBe(false);
  });

  it("WhatsApp: a status-callback payload (no messages array) is unaffected by the freshness check", async () => {
    const secret = "meta-app-secret";
    const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }] });
    const header = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
    const ok = await getAdapter("whatsapp")!.verifySignature({ rawBody, headers: { "x-hub-signature-256": header }, secret });
    expect(ok).toBe(true);
  });

  it("every channel fails closed when headers/secret are missing entirely", async () => {
    for (const channel of ["slack", "discord", "email", "whatsapp"] as const) {
      const ok = await getAdapter(channel)!.verifySignature({ rawBody: "{}", headers: {}, secret: "" });
      expect(ok).toBe(false);
    }
  });
});
