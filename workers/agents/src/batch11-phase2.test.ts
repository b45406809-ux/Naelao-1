import { describe, expect, it, vi } from "vitest";
import {
  handleExecutiveInbound,
  EMERGENCY_STOP_CONFIRMATION,
} from "./channels/executive-channel.js";
import { runCustomerAnalyticsScan } from "./workflows/customer-analytics-workflow.js";

describe("Batch 11 private channels and analytics", () => {
  it("does not route an unverified customer into the executive plane", async () => {
    const route = vi.fn();
    const result = await handleExecutiveInbound(
      {
        spaceId: "s",
        tenantId: "t",
        channel: "telegram",
        senderId: "public",
        text: "hello",
      },
      {
        verify: async () => false,
        freeze: vi.fn(),
        routeToRootAssistant: route,
        send: vi.fn(),
      }
    );
    expect(result.handled).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });

  it("atomically requests a freeze and confirms STOP without routing it", async () => {
    const freeze = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const route = vi.fn();
    const started = performance.now();
    const result = await handleExecutiveInbound(
      {
        spaceId: "s",
        tenantId: "t",
        channel: "whatsapp",
        senderId: "+1",
        text: " STOP ",
      },
      {
        verify: async () => true,
        freeze,
        routeToRootAssistant: route,
        send,
      }
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.emergencyStopped).toBe(true);
    expect(freeze).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: EMERGENCY_STOP_CONFIRMATION })
    );
    expect(route).not.toHaveBeenCalled();
  });

  it("alerts on hostile sentiment and unresolved conversations exactly once", async () => {
    const alertOwner = vi.fn(async () => undefined);
    const markAlerted = vi.fn(async () => undefined);
    const result = await runCustomerAnalyticsScan("s", {
      listUnalerted: async () => [
        {
          conversationId: "hostile",
          channel: "web",
          customerId: "a",
          sentimentScore: -0.61,
          unresolved: false,
        },
        {
          conversationId: "open",
          channel: "telegram",
          customerId: "b",
          sentimentScore: 0,
          unresolved: true,
        },
        {
          conversationId: "fine",
          channel: "web",
          customerId: "c",
          sentimentScore: 0.2,
          unresolved: false,
        },
      ],
      alertOwner,
      markAlerted,
    });
    expect(result).toEqual({ scanned: 3, alerted: 2 });
    expect(alertOwner).toHaveBeenCalledTimes(2);
    expect(markAlerted).toHaveBeenCalledWith("s", ["hostile", "open"]);
  });
});
