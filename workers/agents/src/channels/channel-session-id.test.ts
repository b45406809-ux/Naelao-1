import { describe, expect, it } from "vitest";
import { stableChannelSessionId } from "./channel-session-id.js";

describe("stable channel session identity", () => {
  const conversation = { spaceId: "space-a", projectId: "project-a", channelType: "agentmail", conversationId: "conn-a:thread-a" };

  it("is stable for retries addressed to the same assistant", async () => {
    const first = await stableChannelSessionId({ ...conversation, agentId: "agent-a" });
    expect(await stableChannelSessionId({ ...conversation, agentId: "agent-a" })).toBe(first);
  });

  it("keeps assistant histories separate for a shared provider conversation", async () => {
    expect(await stableChannelSessionId({ ...conversation, agentId: "agent-a" }))
      .not.toBe(await stableChannelSessionId({ ...conversation, agentId: "agent-b" }));
  });
});
