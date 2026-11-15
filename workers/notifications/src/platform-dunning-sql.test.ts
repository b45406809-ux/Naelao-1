import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queue, type NotificationsEnv } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

function database(role: "owner" | "admin" = "admin") {
  const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync as new (name: string) => any;
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE orgs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL);
    INSERT INTO orgs VALUES ('org-1','owner-1','active');
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,status TEXT NOT NULL);
    INSERT INTO users VALUES ('owner-1','owner@example.test','active');
    INSERT INTO users VALUES ('admin-1','admin@example.test','active');
    CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,joined_at TEXT,
      PRIMARY KEY(org_id,user_id));
    INSERT INTO org_members VALUES ('org-1','admin-1','${role}','2026-11-01T00:00:00.000Z');
    CREATE TABLE subscriptions(org_id TEXT PRIMARY KEY,billing_provider TEXT,ls_subscription_id TEXT,whop_subscription_id TEXT,
      status TEXT NOT NULL,provider_event_at TEXT);
    INSERT INTO subscriptions VALUES ('org-1','lemon_squeezy','subscription-1',NULL,'past_due','2026-11-14T00:00:00.000Z');
  `);
  for (const file of ["0010_notifications.sql", "0233_dunning_notification_attempt_receipts.sql", "0252_product_user_dunning_status_scope.sql"])
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../../infra/migrations/${file}`, import.meta.url).href), "utf8"));
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

function notice(notificationId: string) {
  return {
    type: "email", tenantId: "org-1", userId: "admin-1", email: "admin@example.test", notificationId,
    subscriptionScope: "platform_subscription", subscriptionProvider: "lemon_squeezy",
    providerSubscriptionId: "subscription-1", providerUpdatedAt: "2026-11-14T00:00:00.000Z",
    subject: "Payment failed", html: "Review billing settings",
  };
}

describe("platform dunning final send authorization", () => {
  it("sends only to a current active organization owner or joined admin for the exact past-due subscription event", async () => {
    const db = database();
    const send = vi.fn(async () => Response.json({ id: "email_provider_receipt" }));
    vi.stubGlobal("fetch", send);
    const message = { id: "dunning-valid", body: notice(`dunning-${"a".repeat(64)}`), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [message] } as never, {
      PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test", WEBHOOK_SIGNING_SECRET: "test",
    } as unknown as NotificationsEnv);

    expect(send).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    const receipt = await db.prepare("SELECT subscription_scope,provider_outcome FROM dunning_notification_attempts").first<Record<string, unknown>>();
    expect(receipt).toMatchObject({ subscription_scope: "platform_subscription", provider_outcome: "provider_accepted" });
  });

  it.each([
    ["membership was revoked", (db: D1Database) => db.prepare("UPDATE org_members SET joined_at=NULL WHERE org_id='org-1' AND user_id='admin-1'").run()],
    ["the subscription recovered", (db: D1Database) => db.prepare("UPDATE subscriptions SET status='active' WHERE org_id='org-1'").run()],
    ["a newer provider event replaced the notice", (db: D1Database) => db.prepare("UPDATE subscriptions SET provider_event_at='2026-11-15T00:00:00.000Z' WHERE org_id='org-1'").run()],
    ["the recipient email changed", (db: D1Database) => db.prepare("UPDATE users SET email='new-admin@example.test' WHERE id='admin-1'").run()],
    ["the owner changed and the former admin was demoted", async (db: D1Database) => {
      await db.prepare("UPDATE orgs SET owner_id='new-owner' WHERE id='org-1'").run();
      await db.prepare("UPDATE org_members SET role='viewer' WHERE org_id='org-1' AND user_id='admin-1'").run();
    }],
  ])("does not send when %s before queued delivery", async (_label, update) => {
    const db = database();
    await update(db);
    const send = vi.fn(async () => Response.json({ id: "must_not_send" }));
    vi.stubGlobal("fetch", send);
    const message = { id: "dunning-stale", body: notice(`dunning-${"b".repeat(64)}`), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [message] } as never, {
      PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test", WEBHOOK_SIGNING_SECRET: "test",
    } as unknown as NotificationsEnv);

    expect(send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM dunning_notification_attempts").first<{ count: number }>())
      .toEqual({ count: 0 });
  });

  it("rechecks an owner through ownership even without a membership row", async () => {
    const db = database();
    await db.prepare("DELETE FROM org_members WHERE user_id='admin-1'").run();
    const ownerMessage = { ...notice(`dunning-${"c".repeat(64)}`), userId: "owner-1", email: "owner@example.test" };
    const send = vi.fn(async () => Response.json({ id: "owner_receipt" }));
    vi.stubGlobal("fetch", send);
    const message = { id: "dunning-owner", body: ownerMessage, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [message] } as never, {
      PLATFORM_DB: db, RESEND_API_KEY: "test", RESEND_API_URL: "https://mail.test", WEBHOOK_SIGNING_SECRET: "test",
    } as unknown as NotificationsEnv);
    expect(send).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
