import { describe, expect, it } from "vitest";
import { call, createWebhook, fixture, seedTenant, WEBHOOK_KEY, ALL_SCOPES } from "./test-helpers.js";
import { isPrivateHost, checkWebhookUrl } from "./ssrf.js";
import { decryptSecret, encryptSecret, generateWebhookSecret, signPayload, verifySignature, webhookAad } from "./webhooks.js";

const HOOK = "https://hooks.partner.example/naelao";

describe("webhook create and delete (MS-34)", () => {
  it("returns the secret once; only ciphertext is stored and the secret is recoverable for signing", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const res = await createWebhook(f, key, HOOK, ["email.message.received"]);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = (await res.json()) as { data: { id: string; secret: string; url: string; event_types: string[]; status: string } };
    expect(data.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(data).toMatchObject({ url: HOOK, event_types: ["email.message.received"], status: "active" });

    const row = f.db.prepare("SELECT * FROM nemail_webhooks WHERE id = ?").get(data.id) as Record<string, string>;
    expect(row.secret_ciphertext).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(data.secret);
    expect(await decryptSecret(WEBHOOK_KEY, row.secret_ciphertext, webhookAad("t1", data.id))).toBe(data.secret);
    // Bound to the tenant and webhook: the same ciphertext does not decrypt under another row's context.
    expect(await decryptSecret(WEBHOOK_KEY, row.secret_ciphertext, webhookAad("t2", data.id))).toBeNull();
    expect(await decryptSecret("x".repeat(40), row.secret_ciphertext, webhookAad("t1", data.id))).toBeNull();

    // The secret never reaches the idempotency table or any other stored row.
    const everything = JSON.stringify([
      f.db.prepare("SELECT * FROM nemail_idempotency").all(),
      f.db.prepare("SELECT * FROM nemail_api_keys").all(),
      f.db.prepare("SELECT * FROM nemail_webhook_deliveries").all(),
    ]);
    expect(everything).not.toContain(data.secret);
  });

  it("refuses an unsafe or malformed destination with 400 and stores nothing", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const bad = [
      "http://hooks.partner.example/x", // not https
      "ftp://hooks.partner.example/x",
      "https://user:pw@hooks.partner.example/x",
      "https://hooks.partner.example:8443/x", // non-default port
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.0.10/x",
      "https://172.20.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://[fd00::5]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://metadata.google.internal/x",
      "https://intranet/x", // single-label name
      "not a url",
    ];
    for (const url of bad) {
      const res = await createWebhook(f, key, url, ["email.message.received"]);
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error_code: string }).error_code, url).toBe("invalid_webhook_url");
    }
    expect((await createWebhook(f, key, 42 as unknown as string, ["email.message.received"])).status).toBe(400);
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_webhooks").get()).toEqual({ n: 0 });
  });

  it("validates event types: non-empty, duplicate-free subset of the five types", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    for (const types of [[], ["email.message.sent"], ["email.message.received", "email.message.received"], "email.delivery.sent", ["email.delivery.sent", "nope"]]) {
      const res = await call(f, "POST", "/v1/webhooks", key, { url: HOOK, event_types: types });
      expect(res.status, JSON.stringify(types)).toBe(400);
    }
    const all = await call(f, "POST", "/v1/webhooks", key, {
      url: HOOK,
      event_types: ["email.message.received", "email.delivery.sent", "email.delivery.failed", "email.delivery.bounced", "email.delivery.complained"],
    });
    expect(all.status).toBe(201);
  });

  it("without NEMAIL_WEBHOOK_KEY the create is refused (503) and nothing is stored", async () => {
    const f = fixture({ NEMAIL_WEBHOOK_KEY: "short" });
    const key = await seedTenant(f, "t1");
    const res = await createWebhook(f, key, HOOK, ["email.message.received"]);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error_code: string }).error_code).toBe("offering_unavailable");
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_webhooks").get()).toEqual({ n: 0 });
  });

  it("requires webhooks:write; a read-only key gets 403 and the flag off gives 404", async () => {
    const f = fixture();
    const readOnly = await seedTenant(f, "t1", ["inboxes:read"]);
    expect((await createWebhook(f, readOnly, HOOK, ["email.message.received"])).status).toBe(403);
    const off = fixture({ NAELAO_EMAIL_ENABLED: "false" });
    const k = await seedTenant(off, "t2", ALL_SCOPES);
    expect((await createWebhook(off, k, HOOK, ["email.message.received"])).status).toBe(404);
  });

  it("DELETE is idempotent per key, a second delete is not-found, and cross-tenant delete changes nothing", async () => {
    const f = fixture();
    const a = await seedTenant(f, "ta"), b = await seedTenant(f, "tb");
    const { data } = (await (await createWebhook(f, a, HOOK, ["email.message.received"])).json()) as { data: { id: string } };
    const cross = await call(f, "DELETE", `/v1/webhooks/${data.id}`, b);
    expect(cross.status).toBe(404);
    expect(f.db.prepare("SELECT status, deleted_at FROM nemail_webhooks WHERE id = ?").get(data.id)).toEqual({ status: "active", deleted_at: null });

    const first = await call(f, "DELETE", `/v1/webhooks/${data.id}`, a, undefined, { "idempotency-key": "d1" });
    expect(first.status).toBe(200);
    const replay = await call(f, "DELETE", `/v1/webhooks/${data.id}`, a, undefined, { "idempotency-key": "d1" });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await call(f, "DELETE", `/v1/webhooks/${data.id}`, a)).status).toBe(404);
    expect(f.db.prepare("SELECT status FROM nemail_webhooks WHERE id = ?").get(data.id)).toEqual({ status: "deleted" });
  });
});

describe("destination guard (MS-34 SSRF)", () => {
  it("blocks private, loopback, link-local, reserved and internal hosts", () => {
    for (const host of [
      "localhost", "a.localhost", "printer.local", "db.internal", "host.localdomain", "intranet",
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.2.1", "192.168.1.1", "198.18.0.1", "203.0.113.9", "224.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "fc00::1", "fd12:3456::1", "fe80::1",
      "fec0::1", "ff02::1", "2001:db8::1", "2002:c000:0201::1", "100::1",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public hosts and public addresses", () => {
    for (const host of ["hooks.partner.example", "example.com", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "[2606:4700:4700::1111]"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it("checkWebhookUrl requires https, no credentials, default port, and a public host", () => {
    expect(checkWebhookUrl(HOOK)).toEqual({ ok: true, href: HOOK });
    expect(checkWebhookUrl("https://hooks.partner.example:443/x").ok).toBe(true);
    expect(checkWebhookUrl("https://169.254.169.254/").ok).toBe(false);
    expect(checkWebhookUrl(`https://a.example/${"x".repeat(2100)}`).ok).toBe(false);
  });
});

describe("secret encryption and signature", () => {
  it("encrypts and decrypts with the same key and context only", async () => {
    const secret = generateWebhookSecret();
    const ct = await encryptSecret(WEBHOOK_KEY, secret, "webhook:t1:w1");
    expect(ct).not.toContain(secret);
    expect(await decryptSecret(WEBHOOK_KEY, ct, "webhook:t1:w1")).toBe(secret);
    expect(await decryptSecret(WEBHOOK_KEY, ct, "webhook:t1:w2")).toBeNull();
    expect(await decryptSecret(WEBHOOK_KEY, "v1.bad", "webhook:t1:w1")).toBeNull();
    expect(await decryptSecret(WEBHOOK_KEY, null, "webhook:t1:w1")).toBeNull();
  });

  it("signature verifies with the secret and the exact body, and fails when altered", async () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ id: "evt_1", type: "email.delivery.sent", version: 1 });
    const now = 1_800_000_000;
    const header = await signPayload(secret, now, body);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(await verifySignature(secret, header, body, now)).toBe(true);
    expect(await verifySignature(secret, header, body + " ", now)).toBe(false);
    expect(await verifySignature(generateWebhookSecret(), header, body, now)).toBe(false);
    expect(await verifySignature(secret, header, body, now + 301)).toBe(false); // replay outside tolerance
    expect(await verifySignature(secret, null, body, now)).toBe(false);
  });
});
