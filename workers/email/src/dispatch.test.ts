import { describe, expect, it, vi } from "vitest";
import { call, createInbox, createWebhook, fakeFetch, fixture, seedTenant, sendMail, WEBHOOK_KEY, type FakeCall, type Fixture } from "./test-helpers.js";
import { dispatchDue, RETRY_DELAYS_MS, retryDelayMs } from "./dispatch.js";
import { verifySignature } from "./webhooks.js";
import { applyFeedback } from "./feedback.js";
import handler from "./index.js";

const HOOK = "https://hooks.partner.example/naelao";
const T0 = Date.parse("2026-11-26T12:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);

async function webhookWithSecret(f: Fixture, key: string, url: string, types: string[]) {
  const res = await createWebhook(f, key, url, types);
  return ((await res.json()) as { data: { id: string; secret: string } }).data;
}
async function sendOne(f: Fixture, key: string, inboxId: string, text = "secret body text") {
  return (await (await sendMail(f, key, inboxId, { to: ["bob@example.com"], subject: "Hi", text })).json()) as { data: { message_id: string; rfc822_message_id: string } };
}
const deliveries = (f: Fixture) => f.db.prepare("SELECT status, attempts, last_error, last_status_code, delivered_at FROM nemail_webhook_deliveries").all() as Array<Record<string, unknown>>;

describe("webhook dispatch (MS-34)", () => {
  it("delivers a signed envelope that verifies with the returned secret and carries references only", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    const hook = await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    const sent = await sendOne(f, key, inbox);
    const fake = fakeFetch();
    const result = await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    expect(result).toEqual({ fannedOut: 1, attempted: 1 });
    expect(fake.calls).toHaveLength(1);
    const c = fake.calls[0]!;
    expect(c.url).toBe(HOOK);
    expect(await verifySignature(hook.secret, c.headers["naelao-signature"] ?? null, c.body, Math.floor(T0 / 1000))).toBe(true);
    expect(await verifySignature("z".repeat(50), c.headers["naelao-signature"] ?? null, c.body, Math.floor(T0 / 1000))).toBe(false);
    expect(c.body).not.toContain("secret body text");
    const env = JSON.parse(c.body) as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual(["data", "id", "inbox_id", "occurred_at", "tenant", "type", "version"]);
    expect(env).toMatchObject({ type: "email.delivery.sent", version: 1, tenant: "t1", data: { message_id: sent.data.message_id, status: "sent", recipient: "bob@example.com" } });
    expect(env.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(c.headers["naelao-event-id"]).toBe(env.id);
    expect(c.signal).toBeDefined();
    expect(deliveries(f)[0]).toMatchObject({ status: "delivered", attempts: 1, last_status_code: 200 });
    // Idempotent: a later pass neither re-fans-out nor re-posts a delivered event.
    await dispatchDue(f.env, { now: at(3600), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(1);
  });

  it("outbox: sent and failed are recorded per recipient; an unknown outcome records nothing", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await sendOne(f, key, inbox);
    expect((f.db.prepare("SELECT event_type FROM nemail_events ORDER BY event_type").all() as Array<{ event_type: string }>).map(r => r.event_type)).toEqual(["email.delivery.sent"]);

    // No transport binding at all: nothing is invoked, so each recipient is `failed`.
    const binding = f.env.EMAIL;
    delete (f.env as { EMAIL?: SendEmail }).EMAIL;
    const failed = await sendMail(f, key, inbox, { to: ["carol@example.com", "dan@example.com"], subject: "x", text: "y" });
    expect(failed.status).toBe(502);
    expect((f.db.prepare("SELECT event_type, count(*) AS n FROM nemail_events GROUP BY event_type ORDER BY event_type").all())).toEqual([
      { event_type: "email.delivery.failed", n: 2 }, { event_type: "email.delivery.sent", n: 1 },
    ]);

    (f.env as { EMAIL?: SendEmail }).EMAIL = binding;
    f.emailMode.mode = "throw"; // binding invoked, then failed: outcome unknown
    await sendMail(f, key, inbox, { to: ["erin@example.com"], subject: "x", text: "y" });
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_events").get()).toEqual({ n: 3 }); // unknown adds nothing
  });

  it("bounce and complaint feedback record an outbox event once, on the status change", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    const sent = await sendOne(f, key, inbox);
    const report = [{ kind: "bounce" as const, originalMessageId: sent.data.rfc822_message_id, recipients: ["bob@example.com"] }];
    expect(await applyFeedback(f.env.PLATFORM_DB, report)).toBe(1);
    expect(await applyFeedback(f.env.PLATFORM_DB, report)).toBe(0); // replay: no second transition, no second event
    expect((f.db.prepare("SELECT event_type, count(*) AS n FROM nemail_events WHERE event_type = 'email.delivery.bounced' GROUP BY event_type").get() as { n: number }).n).toBe(1);
  });

  it("subscriptions filter by type", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await webhookWithSecret(f, key, "https://bounces.partner.example/h", ["email.delivery.bounced"]);
    await sendOne(f, key, inbox);
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(0);
    expect(f.db.prepare("SELECT dispatched_at IS NOT NULL AS done FROM nemail_events").get()).toEqual({ done: 1 });
  });

  it("an inbox-scoped webhook receives only its own inbox's events; an unknown or foreign inbox is not found", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const other = await seedTenant(f, "t2");
    const a = await createInbox(f, key, "bot-a");
    const b = await createInbox(f, key, "bot-b");
    const foreign = await createInbox(f, other, "bot-c");
    const scoped = await call(f, "POST", "/v1/webhooks", key, { url: "https://a.partner.example/h", event_types: ["email.delivery.sent"], inbox_id: a });
    expect(scoped.status).toBe(201);
    expect(((await scoped.json()) as { data: { inbox_id: string } }).data.inbox_id).toBe(a);
    await webhookWithSecret(f, key, "https://all.partner.example/h", ["email.delivery.sent"]);
    expect((await call(f, "POST", "/v1/webhooks", key, { url: "https://x.partner.example/h", event_types: ["email.delivery.sent"], inbox_id: foreign })).status).toBe(404);
    expect((await call(f, "POST", "/v1/webhooks", key, { url: "https://x.partner.example/h", event_types: ["email.delivery.sent"], inbox_id: "inb_missing" })).status).toBe(404);
    await sendOne(f, key, a);
    await sendOne(f, key, b);
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    const toScoped = fake.calls.filter(c => c.url === "https://a.partner.example/h");
    const toAll = fake.calls.filter(c => c.url === "https://all.partner.example/h");
    expect(toScoped).toHaveLength(1);
    expect((JSON.parse(toScoped[0]!.body) as { inbox_id: string }).inbox_id).toBe(a);
    expect(toAll).toHaveLength(2);
  });

  it("retries on the backoff schedule and dead-letters after the 24 h window (8 attempts)", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    await sendOne(f, key, inbox);
    const fake = fakeFetch(() => new Response("nope", { status: 500 }));
    const attemptOffsets = [0, 60, 360, 2160, 9360, 30960, 52560, 74160]; // seconds: 0, +1m, +5m, +30m, +2h, +6h, +6h, +6h
    for (const t of attemptOffsets) {
      if (t > 0) {
        await dispatchDue(f.env, { now: at(t - 1), fetchImpl: fake.impl });
        expect(fake.calls.length, `no attempt just before ${t}s`).toBe(attemptOffsets.indexOf(t));
      }
      await dispatchDue(f.env, { now: at(t), fetchImpl: fake.impl });
      expect(fake.calls.length).toBe(attemptOffsets.indexOf(t) + 1);
    }
    // The eighth failure would schedule the next attempt 26h36m after the first: dead-letter, no ninth request.
    expect(deliveries(f)[0]).toMatchObject({ status: "dead_letter", attempts: 8, last_error: "http_500", last_status_code: 500 });
    await dispatchDue(f.env, { now: at(200_000), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(8);
    const rows = f.db.prepare("SELECT attempt_no, attempted_at, status_code, error_code FROM nemail_webhook_attempts ORDER BY attempt_no").all() as Array<Record<string, unknown>>;
    expect(rows.map(r => r.attempt_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.map(r => Date.parse(String(r.attempted_at)) - T0)).toEqual(attemptOffsets.map(s => s * 1000));
    expect(rows.every(r => r.status_code === 500 && r.error_code === "http_500")).toBe(true);
  });

  it("backoff table: 1m, 5m, 30m, 2h, then 6h", () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
    expect([1, 2, 3, 4, 5, 6, 40].map(retryDelayMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000, 21_600_000]);
  });

  it("a timeout is retried as timeout; a later 2xx delivers and clears the error", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    await sendOne(f, key, inbox);
    const fake = fakeFetch((_c: FakeCall, i) => {
      if (i === 0) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      if (i === 1) return new Response("", { status: 503 });
      return new Response(null, { status: 204 });
    });
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    expect(deliveries(f)[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "timeout" });
    await dispatchDue(f.env, { now: at(60), fetchImpl: fake.impl });
    await dispatchDue(f.env, { now: at(360), fetchImpl: fake.impl });
    expect(deliveries(f)[0]).toMatchObject({ status: "delivered", attempts: 3, last_error: null, last_status_code: 204 });
    expect(fake.calls).toHaveLength(3);
  });

  it("a deleted webhook stops delivery: a pending retry is cancelled and nothing more is posted", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    const hook = await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    await sendOne(f, key, inbox);
    const fake = fakeFetch(() => new Response("", { status: 500 }));
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl }); // one failed attempt, retry due at +1m
    expect(deliveries(f)[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect((await call(f, "DELETE", `/v1/webhooks/${hook.id}`, key)).status).toBe(200);
    await dispatchDue(f.env, { now: at(60), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(1);
    expect(deliveries(f)[0]).toMatchObject({ status: "cancelled", attempts: 1 });
    // A webhook deleted before fan-out gets no delivery row at all.
    const hook2 = await webhookWithSecret(f, key, "https://other.partner.example/h", ["email.delivery.sent"]);
    await call(f, "DELETE", `/v1/webhooks/${hook2.id}`, key);
    await sendOne(f, key, inbox);
    await dispatchDue(f.env, { now: at(120), fetchImpl: fake.impl });
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_webhook_deliveries WHERE webhook_id = ?").get(hook2.id)).toEqual({ n: 0 });
  });

  it("a destination that is no longer allowed is refused before any request (dead-letter, no POST)", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    const hook = await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    await sendOne(f, key, inbox);
    f.db.prepare("UPDATE nemail_webhooks SET url = 'https://10.0.0.5/hook' WHERE id = ?").run(hook.id);
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(0);
    expect(deliveries(f)[0]).toMatchObject({ status: "dead_letter", last_error: "destination_refused" });
  });

  it("cross-tenant isolation: an event for tenant B never reaches tenant A's webhook", async () => {
    const f = fixture();
    const a = await seedTenant(f, "ta"), b = await seedTenant(f, "tb");
    await createInbox(f, a, "bot-a");
    const inboxB = await createInbox(f, b, "bot-b");
    await webhookWithSecret(f, a, "https://a.partner.example/h", ["email.delivery.sent"]);
    await webhookWithSecret(f, b, "https://b.partner.example/h", ["email.delivery.sent"]);
    await sendOne(f, b, inboxB);
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    expect(fake.calls.map(c => c.url)).toEqual(["https://b.partner.example/h"]);
    expect(JSON.parse(fake.calls[0]!.body).tenant).toBe("tb");
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_webhook_deliveries WHERE nemail_tenant_id = 'ta'").get()).toEqual({ n: 0 });
  });

  it("bounded batches: at most deliveryBatch attempts per pass, the rest wait for the next pass", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    for (let i = 0; i < 3; i++) await sendOne(f, key, inbox);
    const fake = fakeFetch();
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl, deliveryBatch: 2 });
    expect(fake.calls).toHaveLength(2);
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl, deliveryBatch: 2 });
    expect(fake.calls).toHaveLength(3);
  });

  it("without the signing key nothing is attempted and nothing is dead-lettered", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    await sendOne(f, key, inbox);
    const fake = fakeFetch();
    const result = await dispatchDue({ ...f.env, NEMAIL_WEBHOOK_KEY: undefined }, { now: at(0), fetchImpl: fake.impl });
    expect(result).toEqual({ fannedOut: 1, attempted: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(deliveries(f)[0]).toMatchObject({ status: "pending" });
    await dispatchDue(f.env, { now: at(0), fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(1);
  });

  it("scheduled() is a no-op while the flag is off and dispatches when it is on", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const inbox = await createInbox(f, key, "bot");
    await webhookWithSecret(f, key, HOOK, ["email.delivery.sent"]);
    await sendOne(f, key, inbox);
    const fake = fakeFetch();
    vi.stubGlobal("fetch", fake.impl);
    try {
      const work: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as unknown as ExecutionContext;
      const controller = {} as ScheduledController;
      handler.scheduled!(controller, { ...f.env, NAELAO_EMAIL_ENABLED: "false" } as never, ctx);
      expect(work).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);
      handler.scheduled!(controller, f.env as never, ctx);
      await Promise.all(work);
      expect(fake.calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
