import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fixture,
  scope,
} from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import {
  DEFAULT_DELIVERY_POLICY,
  validateDeliveryPolicy,
  isQuiet,
  deliverAssistantEvent,
  sweepAssistantDelivery,
} from "./delivery-policy.js";
async function setup() {
  const f = fixture(),
    identity = await ensureIdentity(f.env, scope);
  const send = vi.fn(async () => Response.json({ delivered: true }));
  f.env.NOTIFICATIONS_WORKER = { fetch: send } as unknown as Fetcher;
  await f.db
    .prepare("INSERT INTO assistant_delivery_preferences VALUES(?,?,?)")
    .bind(
      identity.id,
      scope.userId,
      JSON.stringify({
        ...DEFAULT_DELIVERY_POLICY,
        channels: ["web_push"],
        quietStart: 0,
        quietEnd: 0,
        dailyLimit: 100,
      })
    )
    .run();
  return { ...f, identity, send };
}
afterEach(() => vi.useRealTimers());
describe("host assistant delivery policy", () => {
  it("validates settings and handles overnight quiet hours in the selected timezone", () => {
    expect(
      isQuiet(
        { ...DEFAULT_DELIVERY_POLICY, timezone: "Africa/Harare" },
        new Date("2026-10-24T21:00:00Z")
      )
    ).toBe(true);
    expect(
      isQuiet(
        { ...DEFAULT_DELIVERY_POLICY, timezone: "Africa/Harare" },
        new Date("2026-10-24T10:00:00Z")
      )
    ).toBe(false);
    for (const policy of [
      { ...DEFAULT_DELIVERY_POLICY, dailyLimit: 0 },
      { ...DEFAULT_DELIVERY_POLICY, channels: ["attacker"] },
      { ...DEFAULT_DELIVERY_POLICY, timezone: "../bad" },
    ])
      expect(() => validateDeliveryPolicy(policy)).toThrow();
  });
  it("claims 100 duplicate events once and never lets an event key change its message", async () => {
    const f = await setup();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        deliverAssistantEvent(f.env, scope, f.identity, {
          event_id: "task:one",
          message: "Finished",
        })
      )
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(results.some((r) => r.status === "delivered")).toBe(true);
    await expect(
      deliverAssistantEvent(f.env, scope, f.identity, {
        event_id: "task:one",
        message: "Different",
      })
    ).rejects.toThrow("notification_event_conflict");
  });
  it("holds an unknown provider outcome instead of retrying it or using another channel", async () => {
    const f = await setup();
    f.send.mockRejectedValue(new Error("timeout"));
    expect(
      await deliverAssistantEvent(f.env, scope, f.identity, {
        event_id: "one",
        message: "Result",
      })
    ).toMatchObject({ status: "held" });
    await deliverAssistantEvent(f.env, scope, f.identity, {
      event_id: "one",
      message: "Result",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("defers encrypted quiet-hour updates and sends them after policy permits", async () => {
    const f = await setup();
    vi.setSystemTime(new Date("2026-10-24T23:00:00Z"));
    await f.db
      .prepare("UPDATE assistant_delivery_preferences SET policy_json=?")
      .bind(
        JSON.stringify({ ...DEFAULT_DELIVERY_POLICY, channels: ["web_push"] })
      )
      .run();
    expect(
      await deliverAssistantEvent(f.env, scope, f.identity, {
        event_id: "quiet",
        message: "Private result",
      })
    ).toMatchObject({ status: "deferred" });
    expect(f.send).not.toHaveBeenCalled();
    expect([...f.objects.values()].join("")).not.toContain("Private result");
    vi.setSystemTime(new Date("2026-10-25T10:00:00Z"));
    await sweepAssistantDelivery(f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("does not accept another user's private assistant identity or an expired membership", async () => {
    const f = await setup();
    await expect(
      deliverAssistantEvent(f.env, { ...scope, userId: "other" }, f.identity, {
        event_id: "one",
        message: "Private",
      })
    ).rejects.toThrow();
    await f.db
      .prepare("DELETE FROM space_members WHERE end_user_id=?")
      .bind(scope.userId)
      .run();
    await expect(
      deliverAssistantEvent(f.env, scope, f.identity, {
        event_id: "one",
        message: "Private",
      })
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("will not call a verified number without the separate proactive-call opt-in", async () => {
    const f = await setup();
    await f.db
      .prepare("UPDATE assistant_delivery_preferences SET policy_json=?")
      .bind(
        JSON.stringify({
          ...DEFAULT_DELIVERY_POLICY,
          channels: ["phone"],
          quietStart: 0,
          quietEnd: 0,
        })
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO assistant_communication_controllers(identity_id,user_id,channel,address,verified_at) VALUES(?,?,'phone','+15555550100','2026-10-24')"
      )
      .bind(f.identity.id, scope.userId)
      .run();
    expect(
      await deliverAssistantEvent(f.env, scope, f.identity, {
        event_id: "one",
        message: "Update",
      })
    ).toMatchObject({ status: "held" });
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("delivery body retention", () => {
  it("erases old encrypted bodies while retaining duplicate suppression", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
    const f = await setup();
    const event = {
      event_id: "old-result",
      message: "Sensitive completed work",
    };
    await deliverAssistantEvent(f.env, scope, f.identity, event);
    expect(f.send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
    await sweepAssistantDelivery(f.env);
    const row = await f.db
      .prepare(
        "SELECT status,message_key FROM assistant_delivery_receipts WHERE event_id=?"
      )
      .bind(event.event_id)
      .first();
    expect(row).toMatchObject({ status: "delivered", message_key: null });
    expect(f.objects.size).toBe(0);
    await deliverAssistantEvent(f.env, scope, f.identity, event);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});

describe("deferred delivery limits", () => {
  it("counts delayed deliveries against the day they are attempted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T23:00:00Z"));
    const f = await setup();
    await f.db
      .prepare("UPDATE assistant_delivery_preferences SET policy_json=?")
      .bind(
        JSON.stringify({
          ...DEFAULT_DELIVERY_POLICY,
          channels: ["web_push"],
          dailyLimit: 1,
        })
      )
      .run();
    await deliverAssistantEvent(f.env, scope, f.identity, {
      event_id: "backlog",
      message: "Old update",
    });
    vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
    await deliverAssistantEvent(f.env, scope, f.identity, {
      event_id: "today",
      message: "Current update",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    await sweepAssistantDelivery(f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(
      await f.db
        .prepare(
          "SELECT status FROM assistant_delivery_receipts WHERE event_id='backlog'"
        )
        .first()
    ).toMatchObject({ status: "held" });
  });
});
