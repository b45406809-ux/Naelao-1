import { describe, expect, it } from "vitest";
import { claimFoundryChannelEvent, FOUNDRY_CHANNEL_GOAL_LIMIT, parseFoundryChannelCommand, releaseFoundryChannelEvent } from "./foundry-command.js";

describe("Foundry channel command", () => {
  it("parses a worker request without accepting a bearer token in chat", () => {
    expect(parseFoundryChannelCommand("FOUNDRY RUN source-space worker-7\nSummarize the policy."))
      .toEqual({ sourceSpaceId: "source-space", agentId: "worker-7", goal: "Summarize the policy." });
  });

  it("rejects malformed, empty, multiline-header, and oversized requests", () => {
    expect(parseFoundryChannelCommand("FOUNDRY RUN source worker" )).toBeNull();
    expect(parseFoundryChannelCommand("FOUNDRY RUN source worker\n ")).toBeNull();
    expect(parseFoundryChannelCommand("FOUNDRY RUN source/other worker\nrun")).toBeNull();
    expect(parseFoundryChannelCommand(`FOUNDRY RUN source worker\n${"x".repeat(FOUNDRY_CHANNEL_GOAL_LIMIT + 1)}`)).toBeNull();
  });

  it("claims each provider delivery once and scopes replay protection by sender", () => {
    const events = new Set<string>();
    const store = { exec(query: string, ...values: unknown[]) {
      if (query.startsWith("INSERT OR IGNORE")) {
        const key = values.slice(0, 4).join(":");
        if (events.has(key)) return { rowsWritten: 0 };
        events.add(key); return { rowsWritten: 1 };
      }
      if (query.startsWith("DELETE FROM foundry_channel_events WHERE space_id")) {
        events.delete(values.join(":"));
      }
      return { rowsWritten: 0 };
    } };
    const event = { spaceId: "space-a", channel: "whatsapp" as const, senderId: "contact-a", externalId: "provider-event-1" };
    expect(claimFoundryChannelEvent(store, event, 100)).toBe(true);
    expect(claimFoundryChannelEvent(store, event, 101)).toBe(false);
    expect(claimFoundryChannelEvent(store, { ...event, senderId: "contact-b" }, 102)).toBe(true);
    expect(claimFoundryChannelEvent(store, { ...event, externalId: null }, 103)).toBe(true);
    releaseFoundryChannelEvent(store, event);
    expect(claimFoundryChannelEvent(store, event, 104)).toBe(true);
  });
});
