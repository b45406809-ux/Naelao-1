import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { queue, type NotificationsEnv } from "./index.js";

function env(): NotificationsEnv {
  return {
    ENVIRONMENT: "test",
    RESEND_API_KEY: "resend",
    RESEND_API_URL: "https://api.resend.test",
    WEBHOOK_SIGNING_SECRET: "secret",
    PLATFORM_DB: {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => query.includes("FROM orgs")
            ? { status: "active" }
            : { config_json: '{"compliance":{"airGappedOnly":true}}' }),
        })),
      })),
    } as unknown as D1Database,
  };
}

describe("notification air-gap boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("acks a scoped webhook without touching the network", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const ack = vi.fn();
    const retry = vi.fn();
    await queue({ messages: [{ body: { type: "webhook", tenantId: "t", spaceId: "s", webhookUrl: "https://example.com/hook" }, ack, retry }] } as never, env());
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("blocks a synchronous chat reply before credential lookup or fetch", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request("https://notifications/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "t" },
      body: JSON.stringify({ channel: "telegram", space_id: "s", to: "1", message: "hello" }),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ delivered: false, reason: "air_gapped_space_blocks_network_egress" });
    expect(outbound).not.toHaveBeenCalled();
  });
});
