import { describe, expect, it, vi } from "vitest";
import {
  type ReplayLakeEnv,
  handleReplayRequest,
  replayWebhookEvent,
} from "./replay-lake.js";

const event = {
  type: "webhook_ingress" as const,
  webhookId: "wh_1",
  spaceId: "space_a",
  provider: "github" as const,
  eventId: "evt_1",
  eventType: "push",
  payload: "{}",
  headers: {},
  receivedAt: "2026-01-01T00:00:00.000Z",
};

describe("webhook replay isolation", () => {
  it("requires a space scope and an authorization hook", async () => {
    const missingScope = await handleReplayRequest(
      new Request("https://app.test/webhooks/replay/evt_1", { method: "POST" }),
      {}
    );
    expect(missingScope.status).toBe(400);
    const noAuth = await handleReplayRequest(
      new Request(
        "https://app.test/webhooks/replay/evt_1?spaceId=space_a&provider=github",
        { method: "POST" }
      ),
      {}
    );
    expect(noAuth.status).toBe(403);
  });

  it("does not search or replay another space's event", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const list = vi.fn();
    const env: ReplayLakeEnv = { WEBHOOK_REPLAY_LAKE: { get, list } as never };
    await expect(
      replayWebhookEvent(env, "evt_1", "space_b", "github")
    ).rejects.toThrow("webhook_event_not_found");
    expect(get).toHaveBeenCalledWith("raw-webhooks/space_b/github/evt_1.json");
    expect(list).not.toHaveBeenCalled();
  });

  it("authorizes before loading and dispatching the scoped event", async () => {
    const get = vi.fn().mockResolvedValue({ json: async () => event });
    const send = vi.fn();
    const authorizeWebhookReplay = vi.fn().mockResolvedValue(true);
    const env: ReplayLakeEnv = {
      WEBHOOK_REPLAY_LAKE: { get } as never,
      WEBHOOK_INGRESS_QUEUE: { send } as never,
      authorizeWebhookReplay,
    };
    const response = await handleReplayRequest(
      new Request(
        "https://app.test/webhooks/replay/evt_1?spaceId=space_a&provider=github",
        { method: "POST" }
      ),
      env
    );
    expect(response.status).toBe(202);
    expect(authorizeWebhookReplay).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: event.eventId,
        spaceId: event.spaceId,
        replayed: true,
      })
    );
    expect(get).toHaveBeenCalledWith("raw-webhooks/space_a/github/evt_1.json");
  });

  it("rejects a corrupted object whose embedded scope differs from its key", async () => {
    const get = vi.fn().mockResolvedValue({
      json: async () => ({ ...event, spaceId: "space_other" }),
    });
    const env: ReplayLakeEnv = { WEBHOOK_REPLAY_LAKE: { get } as never };
    await expect(
      replayWebhookEvent(env, "evt_1", "space_a", "github")
    ).rejects.toThrow("webhook_event_not_found");
  });
});
