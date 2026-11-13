import { describe, expect, it, vi } from "vitest";
import type { DunningEventMessage } from "@naelao/types";
import { notifyCurrentPaymentFailure } from "./dunning-recovery.js";

function dbFor(first: unknown, rows: unknown[] = []) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        statements.push({ sql, args });
        return { async first() { return first; }, async all() { return { results: rows }; } };
      } };
    },
  } as unknown as D1Database;
  return { db, statements };
}

describe("dunning notification scope", () => {
  it("labels platform subscription notices for owner-visible provider acceptance receipts", async () => {
    const { db, statements } = dbFor(
      { status: "past_due", provider_event_at: "2026-11-12T00:00:00.000Z" },
      [{ id: "owner-1", email: "owner@example.test" }],
    );
    const send = vi.fn(async () => {});
    const event: DunningEventMessage = {
      scope: "platform_subscription", version: 1, type: "dunning", workflow_id: `dunning-${"a".repeat(64)}`,
      orgId: "org-1", provider: "lemon_squeezy", subscriptionId: "subscription-1",
      providerEventId: "payment-failed-1", providerUpdatedAt: "2026-11-12T00:00:00.000Z",
    };
    await expect(notifyCurrentPaymentFailure({ PLATFORM_DB: db, NOTIFICATIONS_QUEUE: { send } } as never, event))
      .resolves.toMatchObject({ notified: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionScope: "platform_subscription",
      notificationId: expect.stringMatching(/^dunning-[a-f0-9]{64}$/),
    }));
    expect(statements[0]?.sql).toContain("FROM subscriptions");
  });

  it("keeps product-user failure notices out of the owner-only platform status view", async () => {
    const { db } = dbFor({
      tenant_id: "org-1", email: "customer@example.test", email_verified_at: "2026-11-01T00:00:00.000Z",
      status: "past_due", provider_event_at: "2026-11-12T00:00:00.000Z",
    });
    const send = vi.fn(async () => {});
    const event: DunningEventMessage = {
      scope: "product_user_subscription", version: 1, type: "dunning", workflow_id: `dunning-${"b".repeat(64)}`,
      productId: "product-1", endUserId: "end-user-1", provider: "lemon_squeezy",
      subscriptionId: "subscription-1", providerEventId: "payment-failed-2", providerUpdatedAt: "2026-11-12T00:00:00.000Z",
    };
    await expect(notifyCurrentPaymentFailure({ PLATFORM_DB: db, NOTIFICATIONS_QUEUE: { send } } as never, event))
      .resolves.toMatchObject({ notified: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subscriptionScope: "product_user_subscription" }));
  });
});
