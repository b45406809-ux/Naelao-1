import { describe, expect, it, vi } from "vitest";
import { notifyCurrentPlatformPaymentFailure, notifyCurrentProductPaymentFailure, type PlatformDunningEvent, type ProductUserDunningEvent } from "../../workers/workflows/src/workflows/dunning-recovery.js";
import { queue as dispatchWorkflowQueue } from "../../workers/workflows/src/queue-consumer.js";

const event: PlatformDunningEvent = {
  orgId: "org-1", provider: "lemon_squeezy", subscriptionId: "subscription-1",
  providerEventId: "payment-1", providerUpdatedAt: "2026-11-12T14:00:00.000Z",
};

function env(input: { status: string; providerEventAt?: string | null; recipients?: Array<{ id: string; email: string }> }) {
  const sent: unknown[] = [];
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() { return { status: input.status, provider_event_at: input.providerEventAt ?? event.providerUpdatedAt }; },
            async all() { return { results: input.recipients ?? [{ id: "owner-1", email: "owner@example.test" }] }; },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    env: { PLATFORM_DB: db, NOTIFICATIONS_QUEUE: { send: async (message: unknown) => { sent.push(message); } } },
    sent,
  };
}

describe("platform subscription dunning notification", () => {
  it.each(["active", "cancelled", "expired"])("does not notify after recovery or subscription closure (%s)", async (status) => {
    const context = env({ status });
    await expect(notifyCurrentPlatformPaymentFailure(context.env, event)).resolves.toMatchObject({ notified: 0, skipped: "payment_recovered_or_subscription_replaced" });
    expect(context.sent).toHaveLength(0);
  });

  it("does not notify for an older failure after a newer provider event", async () => {
    const context = env({ status: "past_due", providerEventAt: "2026-11-13T14:00:00.000Z" });
    await expect(notifyCurrentPlatformPaymentFailure(context.env, event)).resolves.toMatchObject({ notified: 0, skipped: "stale_provider_event" });
    expect(context.sent).toHaveLength(0);
  });

  it("emails current org owners/admins with a stable retry identity", async () => {
    const context = env({ status: "past_due", recipients: [
      { id: "owner-1", email: "owner@example.test" }, { id: "admin-1", email: "admin@example.test" },
    ] });
    const first = await notifyCurrentPlatformPaymentFailure(context.env, event);
    const second = await notifyCurrentPlatformPaymentFailure(context.env, event);
    expect(first).toEqual({ notified: 2 });
    expect(second).toEqual({ notified: 2 });
    expect(context.sent).toHaveLength(4);
    expect(context.sent[0]).toMatchObject({
      type: "email", tenantId: "org-1", userId: "owner-1", email: "owner@example.test",
      notificationId: expect.stringMatching(/^dunning-[a-f0-9]{64}$/),
    });
    expect((context.sent[0] as { notificationId: string }).notificationId).toBe((context.sent[2] as { notificationId: string }).notificationId);
  });

  it("creates the Cloudflare workflow with the event-bound stable ID", async () => {
    const message = {
      id: "queue-delivery-1",
      body: { type: "dunning", workflow_id: `dunning-${"a".repeat(64)}`, scope: "platform_subscription", ...event },
      ack: vi.fn(), retry: vi.fn(),
    };
    const create = vi.fn(async () => undefined);
    await dispatchWorkflowQueue({ messages: [message] } as never, { DUNNING: { create } } as never);
    expect(create).toHaveBeenCalledWith({ id: `dunning-${"a".repeat(64)}`, params: message.body });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("accepts the versioned Product user subscription contract", async () => {
    const workflowId = `dunning-${"b".repeat(64)}`;
    const message = {
      id: "queue-product-1",
      body: {
        type: "dunning", workflow_id: workflowId, scope: "product_user_subscription",
        productId: "product-1", endUserId: "end-user-1", provider: "whop",
        subscriptionId: "subscription-1", providerEventId: null, providerUpdatedAt: null,
      },
      ack: vi.fn(), retry: vi.fn(),
    };
    const create = vi.fn(async () => undefined);
    await dispatchWorkflowQueue({ messages: [message] } as never, { DUNNING: { create } } as never);
    expect(create).toHaveBeenCalledWith({ id: workflowId, params: message.body });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe("Product user subscription dunning notification", () => {
  const productEvent: ProductUserDunningEvent = {
    productId: "product-1", endUserId: "end-user-1", provider: "whop", subscriptionId: "subscription-1",
    providerEventId: "payment-1", providerUpdatedAt: "2026-11-12T14:00:00.000Z",
  };

  it("sends only to the verified current Product account email under its owning tenant", async () => {
    const sent: unknown[] = [];
    const db = {
      prepare() {
        return { bind() { return { first: async () => ({
          tenant_id: "owner-org", email: "customer@example.test", email_verified_at: "2026-11-01T00:00:00.000Z",
          status: "past_due", provider_event_at: productEvent.providerUpdatedAt,
        }) }; } };
      },
    } as unknown as D1Database;
    const result = await notifyCurrentProductPaymentFailure({
      PLATFORM_DB: db,
      NOTIFICATIONS_QUEUE: { send: async (message: unknown) => { sent.push(message); } },
    }, productEvent);
    expect(result).toEqual({ notified: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "email", tenantId: "owner-org", email: "customer@example.test",
      notificationId: expect.stringMatching(/^dunning-[a-f0-9]{64}$/),
    });
    expect(sent[0]).not.toHaveProperty("userId");
  });

  it("does not notify after payment recovery", async () => {
    const send = vi.fn(async () => undefined);
    const db = {
      prepare() { return { bind() { return { first: async () => ({
        tenant_id: "owner-org", email: "customer@example.test", email_verified_at: null,
        status: "active", provider_event_at: productEvent.providerUpdatedAt,
      }) }; } }; },
    } as unknown as D1Database;
    await expect(notifyCurrentProductPaymentFailure({ PLATFORM_DB: db, NOTIFICATIONS_QUEUE: { send } }, productEvent))
      .resolves.toMatchObject({ skipped: "payment_recovered_or_subscription_replaced", notified: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send an unverified or stale Product account failure notice", async () => {
    const send = vi.fn(async () => undefined);
    const account = { tenant_id: "owner-org", email: "customer@example.test", email_verified_at: null,
      status: "past_due", provider_event_at: "2026-11-13T14:00:00.000Z" };
    const db = { prepare() { return { bind() { return { first: async () => account }; } }; } } as unknown as D1Database;
    await expect(notifyCurrentProductPaymentFailure({ PLATFORM_DB: db, NOTIFICATIONS_QUEUE: { send } }, productEvent))
      .resolves.toMatchObject({ skipped: "stale_provider_event", notified: 0 });
    account.provider_event_at = productEvent.providerUpdatedAt!;
    await expect(notifyCurrentProductPaymentFailure({ PLATFORM_DB: db, NOTIFICATIONS_QUEUE: { send } }, productEvent))
      .resolves.toMatchObject({ skipped: "no_verified_account_email", notified: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
