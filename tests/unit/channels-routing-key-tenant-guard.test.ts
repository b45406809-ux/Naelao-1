import { describe, it, expect } from "vitest";
import channelsWorker from "../../workers/channels/src/index.js";

// WS-7 (audit plan): POST /v1/channels wrote a client-supplied routing_key straight to a global
// KV key with no ownership check — any tenant could overwrite another tenant's routing config
// (hijacking inbound email/Slack/webhook traffic) simply by supplying the same routing_key.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv() {
  const spaces = new Map<string, string>(); // spaceId -> tenantId
  const kv = new Map<string, string>();
  const channelRows: Array<{ tenant_id: string; routing_key: string }> = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (/FROM spaces/.test(sql)) {
                const [spaceId, tenantId] = args as [string, string];
                return spaces.get(spaceId) === tenantId ? { id: spaceId } : null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO channels/.test(sql)) {
                const [, , tenantId, , routingKey] = args as [string, string, string, string, string];
                channelRows.push({ tenant_id: tenantId, routing_key: routingKey });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  spaces.set("space-1", "tenant-1");
  spaces.set("space-2", "tenant-2");

  return {
    env: {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: db,
      CHANNEL_CONFIG: {
        async get(key: string) { return kv.get(key) ?? null; },
        async put(key: string, value: string) { kv.set(key, value); },
      } as unknown as KVNamespace,
      SESSIONS_QUEUE: { async send() {} } as unknown as Queue,
    },
    kv,
  };
}

function req(path: string, tenantId: string, body: unknown): Request {
  return new Request(`https://channels.naelao.com${path}`, {
    method: "POST",
    headers: { "x-naelao-tenant-id": tenantId, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("channels worker — routing_key tenant isolation (WS-7)", () => {
  it("tenant-1 can claim a fresh, explicit routing_key", async () => {
    const { env } = makeEnv();
    const res = await channelsWorker.fetch(
      req("/v1/channels", "tenant-1", { space_id: "space-1", channel_type: "webhook", routing_key: "my-key" }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });

  it("tenant-2 cannot overwrite tenant-1's already-claimed routing_key", async () => {
    const { env } = makeEnv();
    await channelsWorker.fetch(
      req("/v1/channels", "tenant-1", { space_id: "space-1", channel_type: "webhook", routing_key: "shared-key" }),
      env as never, execCtx
    );
    const res = await channelsWorker.fetch(
      req("/v1/channels", "tenant-2", { space_id: "space-2", channel_type: "webhook", routing_key: "shared-key" }),
      env as never, execCtx
    );
    expect(res.status).toBe(409);
  });

  it("the same tenant reusing its own routing_key is not rejected", async () => {
    const { env } = makeEnv();
    await channelsWorker.fetch(
      req("/v1/channels", "tenant-1", { space_id: "space-1", channel_type: "webhook", routing_key: "my-key" }),
      env as never, execCtx
    );
    const res = await channelsWorker.fetch(
      req("/v1/channels", "tenant-1", { space_id: "space-1", channel_type: "email", routing_key: "my-key" }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });
});
