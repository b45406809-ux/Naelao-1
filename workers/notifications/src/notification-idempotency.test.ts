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
          async first() { return sql.includes("SELECT status FROM orgs") ? { status: "active" } : null; },
          async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
        };
      } };
    },
  } as unknown as D1Database;
  return { writes, db };
}

describe("stable notification retry identities", () => {
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
});
