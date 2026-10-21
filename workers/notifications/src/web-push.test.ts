import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSubscription, encryptSubscription, validatePushSubscription } from "./web-push.js";
import { queue, type NotificationsEnv } from "./index.js";
import worker from "./index.js";
import { mintInternalToken } from "@naelao/http";

const webPushMock = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ default: webPushMock }));

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
  expirationTime: null,
  keys: { p256dh: "p256dh-public-key", auth: "auth-secret" },
};

describe("browser Web Push", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("accepts known browser push endpoints and rejects arbitrary/private endpoints", () => {
    expect(validatePushSubscription(subscription)).toMatchObject({ endpoint: subscription.endpoint });
    expect(validatePushSubscription({ ...subscription, endpoint: "http://fcm.googleapis.com/send" })).toBeNull();
    expect(validatePushSubscription({ ...subscription, endpoint: "https://127.0.0.1/send" })).toBeNull();
    expect(validatePushSubscription({ ...subscription, endpoint: "https://attacker.example/send" })).toBeNull();
  });

  it("encrypts subscription capabilities and rejects ciphertext tampering", async () => {
    const ciphertext = await encryptSubscription(subscription, "platform-secret");
    expect(ciphertext).not.toContain(subscription.endpoint);
    expect(await decryptSubscription(ciphertext, "platform-secret")).toEqual(subscription);
    await expect(decryptSubscription(ciphertext, "wrong-secret")).rejects.toThrow();
  });

  it("delivers to the user's tenant-scoped subscriptions and prunes expired endpoints", async () => {
    const encrypted = await encryptSubscription(subscription, "platform-secret");
    const deleted: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              all: async () => ({ results: [{ endpoint_hash: "hash-1", encrypted_subscription: encrypted }] }),
              first: async () => sql.includes("FROM orgs") ? { status: "active" } : { config_json: "{}" },
              run: async () => { deleted.push(args); return { meta: { changes: 1 } }; },
            };
          },
        };
      },
    };
    const env = {
      ENVIRONMENT: "test", RESEND_API_KEY: "test", WEBHOOK_SIGNING_SECRET: "secret", PLATFORM_SECRET: "platform-secret",
      WEB_PUSH_VAPID_PUBLIC_KEY: "public", WEB_PUSH_VAPID_PRIVATE_KEY: "private", PLATFORM_DB: db,
    } as unknown as NotificationsEnv;
    webPushMock.sendNotification.mockRejectedValueOnce({ statusCode: 410 });
    const delivery = { body: { type: "web_push" as const, tenantId: "tenant-a", userId: "user-a", spaceId: "space-a" }, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [delivery] } as unknown as MessageBatch<never>, env);
    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([["hash-1", "tenant-a", "user-a"]]);
    expect(delivery.ack).toHaveBeenCalledOnce();
    expect(delivery.retry).not.toHaveBeenCalled();
  });

  it("requires a tenant-bound internal token and encrypts subscriptions before D1 storage", async () => {
    const writes: unknown[][] = [];
    const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => sql.includes("FROM orgs") ? { status: "active" } : { count: 0 }, run: async () => { writes.push([sql, ...args]); return { meta: { changes: 1 } }; } }) }) };
    const env = {
      ENVIRONMENT: "test", RESEND_API_KEY: "test", WEBHOOK_SIGNING_SECRET: "secret", PLATFORM_SECRET: "platform-secret",
      WEB_PUSH_VAPID_PUBLIC_KEY: "public", PLATFORM_DB: db,
    } as unknown as NotificationsEnv;
    const token = await mintInternalToken("platform-secret", "tenant-a");
    const response = await worker.fetch!(new Request("https://notifications/internal/push/subscription", {
      method: "PUT", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ subscription }),
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[4])).not.toContain(subscription.endpoint);
    const mismatch = await worker.fetch!(new Request("https://notifications/internal/push/subscription", {
      method: "PUT", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-b", "x-naelao-user-id": "user-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ subscription }),
    }), env, {} as ExecutionContext);
    expect(mismatch.status).toBe(403);
    expect(writes).toHaveLength(1);
  });
});
