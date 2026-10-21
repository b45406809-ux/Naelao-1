import { describe, expect, it, vi } from "vitest";
import worker from "./index";

function environment(active = true) {
  const send = vi.fn(async () => undefined);
  const env = {
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare: (sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => sql.includes("JOIN orgs") && active ? { id: "space" } : null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    },
    CHANNEL_CONFIG: {
      get: vi.fn(async () => JSON.stringify({ space_id: "space", tenant_id: "tenant", channel_type: "email", routing_key: "key", enabled: 1 })),
      put: vi.fn(), delete: vi.fn(),
    },
    SESSIONS_QUEUE: { send },
  } as never;
  return { env, send };
}

describe("channel ingress bounds and tenant state", () => {
  it("rejects inbound messages for suspended Spaces before queueing", async () => {
    const fixture = environment(false);
    const response = await worker.fetch(new Request("https://channels/inbound/email/key", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }),
    }), fixture.env, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("bounds email JSON bodies and aligns queued content with the consumer limit", async () => {
    const fixture = environment();
    const oversizedBody = await worker.fetch(new Request("https://channels/inbound/email/key", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(1_000_001) }),
    }), fixture.env, {} as ExecutionContext);
    expect(oversizedBody.status).toBe(413);

    const oversizedQueueMessage = await worker.fetch(new Request("https://channels/inbound/email/key", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(100_001) }),
    }), fixture.env, {} as ExecutionContext);
    expect(oversizedQueueMessage.status).toBe(413);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
