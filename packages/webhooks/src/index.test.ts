import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type WebhookQueueMessage,
  deliverWebhook,
  enqueueWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./index.js";

function databaseStub() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              statements.push({ sql, values });
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db: db as never, statements };
}

const message: WebhookQueueMessage = {
  type: "webhook_delivery",
  delivery_id: "delivery_1",
  subscription_id: "sub_1",
  tenant_id: "tenant_1",
  url: "https://8.8.8.8/webhook",
  secret: "secret",
  event_type: "space.created",
  payload: '{"id":"space_1"}',
  attempt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("outbound webhook signature boundaries", () => {
  it("rejects non-canonical signatures and invalid tolerance values", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = await signWebhookPayload("payload", "secret", timestamp);
    expect(await verifyWebhookSignature("payload", `${valid}=`, "secret")).toBe(
      false
    );
    expect(await verifyWebhookSignature("payload", valid, "secret", -1)).toBe(
      false
    );
    expect(
      await verifyWebhookSignature("payload", valid, "secret", Number.NaN)
    ).toBe(false);
  });

  it("rejects timestamps with numeric prefixes or duplicated fields", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = await signWebhookPayload("payload", "secret", timestamp);
    const signature = valid.split(",v1=")[1];
    expect(
      await verifyWebhookSignature(
        "payload",
        `t=${timestamp}x,v1=${signature}`,
        "secret"
      )
    ).toBe(false);
    expect(
      await verifyWebhookSignature(
        "payload",
        `${valid},t=${timestamp}`,
        "secret"
      )
    ).toBe(false);
  });
});

describe("outbound webhook delivery boundaries", () => {
  it("writes the delivery using the deployed migration column names", async () => {
    const { db, statements } = databaseStub();
    const send = vi.fn();
    const id = await enqueueWebhook(
      { send },
      db,
      {
        id: "sub_1",
        tenant_id: "tenant_1",
        url: "https://8.8.8.8/hook",
        events: ["space.created"],
        secret: "secret",
        enabled: true,
        created_at: "now",
      },
      "space.created",
      { id: "space_1" }
    );
    expect(id).toBeTruthy();
    expect(statements[0]?.sql).toContain("payload_json");
    expect(statements[0]?.sql).not.toMatch(/tenant_id|updated_at|\spayload,/);
    expect(send).toHaveBeenCalledOnce();
  });

  it("rechecks the destination and refuses private targets without network dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { db, statements } = databaseStub();
    const send = vi.fn();
    await deliverWebhook(
      { ...message, url: "http://127.0.0.1/admin" },
      { send },
      db
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(statements[0]?.sql).toContain("status = 'failed'");
  });

  it("checks every redirect destination before making the next request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      })
    );
    vi.stubGlobal("fetch", fetch);
    const { db, statements } = databaseStub();
    await deliverWebhook(message, { send: vi.fn() }, db);
    expect(fetch).toHaveBeenCalledOnce();
    expect(statements[0]?.sql).toContain("status = 'failed'");
  });

  it("schedules the first retry after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    );
    const { db, statements } = databaseStub();
    const send = vi.fn();
    await deliverWebhook(message, { send }, db);
    expect(send).toHaveBeenCalledWith(
      { ...message, attempt: 2 },
      { delaySeconds: 30 }
    );
    expect(statements[0]?.values[1]).toBe("2026-01-01T00:00:30.000Z");
  });

  it.each([
    [2, 60],
    [3, 300],
    [4, 1800],
  ] as const)(
    "uses the configured backoff after attempt %i",
    async (attempt, delaySeconds) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
      );
      const { db } = databaseStub();
      const send = vi.fn();
      await deliverWebhook({ ...message, attempt }, { send }, db);
      expect(send).toHaveBeenCalledWith(
        { ...message, attempt: attempt + 1 },
        { delaySeconds }
      );
    }
  );

  it("stops after the final attempt and marks the delivery failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const { db, statements } = databaseStub();
    const send = vi.fn();
    await deliverWebhook({ ...message, attempt: 5 }, { send }, db);
    expect(send).not.toHaveBeenCalled();
    expect(statements[0]?.sql).toContain("status = 'failed'");
    expect(statements[0]?.values[0]).toBe(6);
  });

  it("marks a successful delivery and records the response status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const { db, statements } = databaseStub();
    await deliverWebhook(message, { send: vi.fn() }, db);
    expect(statements[0]?.sql).toContain("status = 'delivered'");
    expect(statements[0]?.values).toEqual([
      1,
      204,
      expect.any(String),
      "delivery_1",
    ]);
  });
});
