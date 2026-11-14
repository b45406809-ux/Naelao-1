import { afterEach, describe, expect, it, vi } from "vitest";
import { queue, type NotificationsEnv } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        return {
          async first() {
            if (sql.includes("SELECT status FROM orgs")) return { status: "active" };
            if (sql.includes("FROM product_user_subscriptions s")) return {
              email: "customer@example.test", email_verified_at: "2026-11-01T00:00:00.000Z",
              provider_event_at: "2026-11-14T00:00:00.000Z",
            };
            return null;
          },
          async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        };
      } };
    },
  } as unknown as D1Database;
  return { writes, db };
}

describe("stable notification retry identities", () => {
  it("retries an unknown message type so the configured DLQ captures the poison message", async () => {
    const { db } = setup();
    const message = {
      id: "queue-unknown-1", body: { type: "future_notification", tenantId: "org-1", notificationId: "future:1" },
      ack: vi.fn(), retry: vi.fn(),
    };
    await queue({ queue: "naelao-notifications-queue", messages: [message] } as never, { PLATFORM_DB: db } as unknown as NotificationsEnv);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("uses the caller notification ID for in-app D1 dedupe", async () => {
    const { writes, db } = setup();
    const message = {
      id: "queue-1", body: { type: "in_app", tenantId: "org-1", userId: "owner-1", notificationId: "dunning-abc123", subject: "Payment failed", data: { reason: "payment_failed" } },
      ack: vi.fn(), retry: vi.fn(),
    };
    await queue({ messages: [message] } as never, { PLATFORM_DB: db } as unknown as NotificationsEnv);
    expect(writes[0]?.sql).toContain("INSERT OR IGNORE INTO notifications");
    expect(writes[0]?.args[0]).toBe("dunning-abc123");
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("reuses the caller identity as the email-provider idempotency key", async () => {
    const { writes, db } = setup();
    const notificationId = `dunning-${"a".repeat(64)}`;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(notificationId);
      return Response.json({ id: "email_123" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      id: "queue-2", body: { type: "email", tenantId: "org-1", userId: "owner-1", email: "owner@example.test", notificationId, subscriptionScope: "platform_subscription", subject: "Payment failed", html: "Update payment details" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ messages: [message] } as never, env);
    expect(fetchMock).toHaveBeenCalledOnce();
    const receipt = writes.find((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"));
    expect(receipt?.args.slice(0, 6)).toEqual(["org-1", notificationId, "platform_subscription", "provider_accepted", 200, "email_123"]);
    expect(writes.some((write) => write.sql.includes("INSERT OR IGNORE INTO notifications") && write.args[0] === notificationId)).toBe(true);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("stores Product-user provider outcomes against the exact active product account and subscription", async () => {
    const { writes, db } = setup();
    const notificationId = `dunning-${"d".repeat(64)}`;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "email_product_1" })));
    const message = {
      id: "queue-product-dunning-1",
      body: {
        type: "email", tenantId: "org-1", email: "customer@example.test", notificationId,
        subscriptionScope: "product_user_subscription", productId: "product-1", endUserId: "end-user-1",
        subscriptionProvider: "lemon_squeezy", providerSubscriptionId: "subscription-1", providerUpdatedAt: "2026-11-14T00:00:00.000Z",
        subject: "Payment failed", html: "Review subscription",
      },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ messages: [message] } as never, env);
    const receipt = writes.find((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"));
    expect(receipt?.sql).toContain("FROM products p");
    expect(receipt?.sql).toContain("u.deleted_at IS NULL AND u.suspended_at IS NULL");
    expect(receipt?.sql).toContain("s.provider=? AND s.provider_subscription_id=?");
    expect((receipt?.sql.match(/\?/g) ?? []).length).toBe(receipt?.args.length);
    expect(receipt?.args.slice(10, 14)).toEqual(["product-1", "end-user-1", "lemon_squeezy", "subscription-1"]);
    expect(receipt?.args.slice(14)).toEqual(["product-1", "org-1", "end-user-1", "lemon_squeezy", "subscription-1"]);
    expect(JSON.stringify(receipt)).not.toContain("customer@example.test");
    expect(JSON.stringify(receipt)).not.toContain("Review subscription");
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("does not persist an unscoped Product-user provider outcome", async () => {
    const { writes, db } = setup();
    const notificationId = `dunning-${"e".repeat(64)}`;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "email_product_2" })));
    const message = {
      id: "queue-product-dunning-unscoped",
      body: { type: "email", tenantId: "org-1", email: "customer@example.test", notificationId, subscriptionScope: "product_user_subscription", subject: "Payment failed", html: "Review subscription" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ messages: [message] } as never, env);
    expect(writes.some((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"))).toBe(false);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("acknowledges Product-user dunning work after the subscription advances to a newer event", async () => {
    const { writes, db } = setup();
    const fetchMock = vi.fn(async () => Response.json({ id: "must_not_send" }));
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      id: "queue-product-dunning-stale",
      body: {
        type: "email", tenantId: "org-1", email: "customer@example.test", notificationId: `dunning-${"f".repeat(64)}`,
        subscriptionScope: "product_user_subscription", productId: "product-1", endUserId: "end-user-1",
        subscriptionProvider: "lemon_squeezy", providerSubscriptionId: "subscription-1", providerUpdatedAt: "2026-11-13T00:00:00.000Z",
        subject: "Payment failed", html: "Review subscription",
      },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ messages: [message] } as never, env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes.some((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"))).toBe(false);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("records provider rejection before retrying the queue message", async () => {
    const { writes, db } = setup();
    const notificationId = `dunning-${"b".repeat(64)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const message = {
      id: "queue-3", body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId, subscriptionScope: "platform_subscription", subject: "Payment failed", html: "Update payment details" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ messages: [message] } as never, env);
    const receipt = writes.find((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"));
    expect(receipt?.args.slice(0, 6)).toEqual(["org-1", notificationId, "platform_subscription", "provider_rejected", 429, null]);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("records an ambiguous network attempt and retries with the same provider idempotency key", async () => {
    const { writes, db } = setup();
    const notificationId = `dunning-${"c".repeat(64)}`;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network timeout"); }));
    const message = {
      id: "queue-4", body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId, subscriptionScope: "platform_subscription", subject: "Payment failed", html: "Update payment details" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ messages: [message] } as never, env);
    const receipt = writes.find((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"));
    expect(receipt?.args.slice(0, 6)).toEqual(["org-1", notificationId, "platform_subscription", "attempt_ambiguous", null, null]);
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it("persists non-PII provider acceptance for general email queue messages", async () => {
    const { writes, db } = setup();
    const notificationId = "account-alert:operation-42";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "email_general_42" })));
    const message = {
      id: "queue-general-1", attempts: 1,
      body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId, subject: "Notice", html: "Body" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ queue: "naelao-notifications-queue", messages: [message] } as never, env);
    const outcome = writes.find((write) => write.sql.includes("INSERT INTO notification_delivery_attempts"));
    expect((outcome?.sql.match(/\?/g) ?? []).length).toBe(outcome?.args.length);
    expect(outcome?.args).toEqual([
      "org-1", notificationId, "email", "resend", "provider_accepted", 1, 200, "email_general_42", null,
      expect.any(String), expect.any(String), expect.any(String), expect.any(String),
    ]);
    expect(JSON.stringify(outcome)).not.toContain("owner@example.test");
    expect(JSON.stringify(outcome)).not.toContain("Body");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("persists a general provider rejection before asking the queue to retry", async () => {
    const { writes, db } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const message = {
      id: "queue-general-rejected", attempts: 2,
      body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId: "account-alert:rejected", subject: "Notice", html: "Body" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ queue: "naelao-notifications-queue", messages: [message] } as never, env);
    const outcome = writes.find((write) => write.sql.includes("INSERT INTO notification_delivery_attempts"));
    expect(outcome?.args).toContain("provider_rejected");
    expect(outcome?.args).toContain(2);
    expect(outcome?.args).toContain(429);
    expect(outcome?.args).toContain("provider_rejected");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("records an ambiguous general provider request and retains its stable retry identity", async () => {
    const { writes, db } = setup();
    const notificationId = "account-alert:ambiguous";
    const outbound = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(notificationId);
      throw new Error("network timeout");
    });
    vi.stubGlobal("fetch", outbound);
    const message = {
      id: "queue-general-ambiguous", attempts: 3,
      body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId, subject: "Notice", html: "Body" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const env = { PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test" } as unknown as NotificationsEnv;
    await queue({ queue: "naelao-notifications-queue", messages: [message] } as never, env);
    const outcome = writes.find((write) => write.sql.includes("INSERT INTO notification_delivery_attempts"));
    expect(outcome?.args).toContain("attempt_ambiguous");
    expect(outcome?.args).toContain("provider_request_ambiguous");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("records dead-letter status without sending the message again", async () => {
    const { writes, db } = setup();
    const message = {
      id: "queue-dead-1", attempts: 4,
      body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId: "account-alert:operation-dead", subject: "Notice", html: "Body" },
      ack: vi.fn(), retry: vi.fn(),
    };
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    await queue({ queue: "naelao-notifications-dlq", messages: [message] } as never, { PLATFORM_DB: db } as unknown as NotificationsEnv);
    const outcome = writes.find((write) => write.sql.includes("INSERT INTO notification_delivery_attempts"));
    expect(outcome?.args).toContain("dead_lettered");
    expect(outcome?.args).toContain("queue_dead_lettered");
    expect(outbound).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("records terminal billing-notice dead letters without replacing the dunning attempt ledger", async () => {
    const { writes, db } = setup();
    const message = {
      id: "queue-dunning-dead", attempts: 4,
      body: { type: "email", tenantId: "org-1", email: "owner@example.test", notificationId: `dunning-${"d".repeat(64)}`,
        subscriptionScope: "platform_subscription", subject: "Payment failed", html: "Body" },
      ack: vi.fn(), retry: vi.fn(),
    };
    await queue({ queue: "naelao-notifications-dlq", messages: [message] } as never, { PLATFORM_DB: db } as unknown as NotificationsEnv);
    expect(writes.some((write) => write.sql.includes("INSERT INTO notification_delivery_attempts") && write.args.includes("dead_lettered"))).toBe(true);
    expect(writes.some((write) => write.sql.includes("INSERT INTO dunning_notification_attempts"))).toBe(false);
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
