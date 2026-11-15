import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queue, type NotificationsEnv } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

function database() {
  const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync as new (name: string) => any;
  const sqlite = new DatabaseSync(":memory:");
  const schemaSql = [
    `CREATE TABLE orgs(id TEXT PRIMARY KEY,status TEXT NOT NULL);
     INSERT INTO orgs VALUES ('org-1','active');
     CREATE TABLE products(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL);
     INSERT INTO products VALUES ('product-1','org-1','active');
     CREATE TABLE product_end_users(product_space_id TEXT NOT NULL,end_user_id TEXT NOT NULL,email TEXT,email_verified_at TEXT,deleted_at TEXT,suspended_at TEXT,erasure_started_at TEXT,PRIMARY KEY(product_space_id,end_user_id));
     INSERT INTO product_end_users VALUES ('product-1','user-1','customer@example.test','2026-11-01T00:00:00.000Z',NULL,NULL,NULL);
     CREATE TABLE product_user_subscriptions(product_id TEXT NOT NULL,end_user_id TEXT NOT NULL,provider TEXT NOT NULL,provider_subscription_id TEXT NOT NULL,status TEXT NOT NULL,provider_event_at TEXT,PRIMARY KEY(product_id,end_user_id));
     INSERT INTO product_user_subscriptions VALUES ('product-1','user-1','lemon_squeezy','subscription-1','past_due','2026-11-14T00:00:00.000Z');`,
    readFileSync(fileURLToPath(new URL("../../../infra/migrations/0010_notifications.sql", import.meta.url).href), "utf8"),
    readFileSync(fileURLToPath(new URL("../../../infra/migrations/0233_dunning_notification_attempt_receipts.sql", import.meta.url).href), "utf8"),
    readFileSync(fileURLToPath(new URL("../../../infra/migrations/0252_product_user_dunning_status_scope.sql", import.meta.url).href), "utf8"),
  ];
  for (const sql of schemaSql) sqlite.exec(sql);
  return {
    prepare(sql: string) {
      const makeStatement = (args: unknown[] = []) => ({
        bind: (...nextArgs: unknown[]) => makeStatement(nextArgs),
        async first<T>() { return (sqlite.prepare(sql).get(...args) ?? null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...args) as T[] }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
      });
      return makeStatement();
    },
  } as unknown as D1Database;
}

function notice(notificationId: string, providerUpdatedAt = "2026-11-14T00:00:00.000Z") {
  return {
    type: "email", tenantId: "org-1", email: "customer@example.test", notificationId,
    subscriptionScope: "product_user_subscription", productId: "product-1", endUserId: "user-1",
    subscriptionProvider: "lemon_squeezy", providerSubscriptionId: "subscription-1", providerUpdatedAt,
    subject: "Payment failed", html: "Review your subscription",
  };
}

function inboxNotice(notificationId: string, providerUpdatedAt = "2026-11-14T00:00:00.000Z") {
  return {
    type: "in_app", tenantId: "org-1", notificationId, subscriptionScope: "product_user_subscription",
    productId: "product-1", endUserId: "user-1", subscriptionProvider: "lemon_squeezy",
    providerSubscriptionId: "subscription-1", providerUpdatedAt, subject: "Payment needs attention",
    data: { kind: "billing_payment_failed", body: "A payment for your product subscription failed. Sign in to review your current plan status and payment options." },
  };
}

describe("Product-user dunning provider receipt SQL", () => {
  it("records exact scoped acceptance, skips stale work, and cannot recreate receipts after erasure", async () => {
    const db = database();
    const send = vi.fn(async () => Response.json({ id: "email_provider_receipt" }));
    vi.stubGlobal("fetch", send);
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    const deliver = async (id: string, updatedAt?: string) => {
      const message = { id, body: notice(`dunning-${id.repeat(64).slice(0, 64)}`, updatedAt), attempts: 1, ack: vi.fn(), retry: vi.fn() };
      await queue({ messages: [message] } as never, env);
      return message;
    };

    const accepted = await deliver("a");
    expect(accepted.ack).toHaveBeenCalledOnce();
    let receipt = await db.prepare(`SELECT tenant_id,product_id,end_user_id,subscription_provider,provider_subscription_id,provider_outcome,attempt_count FROM dunning_notification_attempts`).first<Record<string, unknown>>();
    expect(receipt).toMatchObject({ tenant_id: "org-1", product_id: "product-1", end_user_id: "user-1", subscription_provider: "lemon_squeezy", provider_subscription_id: "subscription-1", provider_outcome: "provider_accepted", attempt_count: 1 });

    await db.prepare("UPDATE product_user_subscriptions SET provider_event_at=? WHERE product_id=? AND end_user_id=?")
      .bind("2026-11-15T00:00:00.000Z", "product-1", "user-1").run();
    const stale = await deliver("b", "2026-11-14T00:00:00.000Z");
    expect(stale.ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(1);

    await db.prepare("UPDATE product_end_users SET deleted_at='2026-11-15T00:00:00.000Z' WHERE product_space_id=? AND end_user_id=?")
      .bind("product-1", "user-1").run();
    const deleted = await deliver("c", "2026-11-15T00:00:00.000Z");
    expect(deleted.ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM dunning_notification_attempts").first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("persists current Product-user inbox notices through the scoped Spaces binding and retries failures", async () => {
    const db = database();
    const requests: Request[] = [];
    const env = { PLATFORM_DB: db, PLATFORM_SECRET: "platform-secret", SPACES_WORKER: { fetch: async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true }, { status: 201 });
    } } } as unknown as NotificationsEnv;
    const message = { id: "inbox-1", body: inboxNotice(`dunning-${"a".repeat(64)}`), attempts: 1, ack: vi.fn(), retry: vi.fn() };

    await queue({ messages: [message] } as never, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/internal/product-user-inbox-notifications");
    expect(requests[0]!.headers.get("x-naelao-tenant-id")).toBe("org-1");
    expect(requests[0]!.headers.get("x-naelao-internal-token")).toMatch(/v1=/);
    expect(await requests[0]!.json()).toEqual({ product_id: "product-1", end_user_id: "user-1",
      provider: "lemon_squeezy", provider_subscription_id: "subscription-1", provider_updated_at: "2026-11-14T00:00:00.000Z",
      notification_id: `dunning-${"a".repeat(64)}`, title: "Payment needs attention",
      body: "A payment for your product subscription failed. Sign in to review your current plan status and payment options." });

    await db.prepare("UPDATE product_user_subscriptions SET provider_event_at=? WHERE product_id=? AND end_user_id=?")
      .bind("2026-11-15T00:00:00.000Z", "product-1", "user-1").run();
    const stale = { id: "inbox-stale", body: inboxNotice(`dunning-${"b".repeat(64)}`), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [stale] } as never, env);
    expect(stale.ack).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);

    const retryEnv = { PLATFORM_DB: database(), PLATFORM_SECRET: "platform-secret",
      SPACES_WORKER: { fetch: async () => new Response("unavailable", { status: 503 }) } } as unknown as NotificationsEnv;
    const retryMessage = { id: "inbox-retry", body: inboxNotice(`dunning-${"c".repeat(64)}`), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [retryMessage] } as never, retryEnv);
    expect(retryMessage.retry).toHaveBeenCalledOnce();
    expect(retryMessage.ack).not.toHaveBeenCalled();
  });
});
