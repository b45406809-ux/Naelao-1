import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("channel conversation transcript paging", () => {
  it("reads old channel messages past the recent-context window with bounded exact paging", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      { PLATFORM_SECRET: "channel-conversation-test-secret" } as never
    );
    await agent.fetch(
      new Request(
        "http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"
      )
    );
    storage.sql.exec(
      "INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES(?,?,?,?)",
      "channel-thread-a",
      "telegram",
      "customer-a",
      "project-a"
    );
    for (let i = 1; i <= 1_205; i++) {
      storage.sql.exec(
        "INSERT INTO channel_messages(id,session_id,direction,text,created_at) VALUES(?,?,?,?,?)",
        `event-${i}`,
        "channel-thread-a",
        i % 2 ? "inbound" : "outbound",
        i === 1
          ? "The customer mentioned the old renewal reference."
          : `Message ${i}`,
        1_700_000_000_000 + i
      );
    }
    const read = (
      agent as unknown as {
        loadChannelTranscript: (sessionId: string, options?: { beforeId?: string; limit?: number }) => Promise<{
          messages: Array<{ id: string; role: string; content: string }>;
          complete: boolean;
        }>;
      }
    ).loadChannelTranscript.bind(agent);

    const result = await read("channel-thread-a");
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(1_205);
    expect(result.messages[0]).toMatchObject({
      id: "event-1",
      role: "user",
      content: "The customer mentioned the old renewal reference.",
    });
    expect(result.messages.at(-1)?.id).toBe("event-1205");

    const olderPage = await read("channel-thread-a", { beforeId: "event-100", limit: 50 });
    expect(olderPage.complete).toBe(false);
    expect(olderPage.messages).toHaveLength(50);
    expect(olderPage.messages[0]?.id).toBe("event-50");
    expect(olderPage.messages.at(-1)?.id).toBe("event-99");
  });

  it("continues beyond the initial 10,000-message window using an exact message cursor", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      { PLATFORM_SECRET: "channel-conversation-test-secret" } as never
    );
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec(
      "INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES(?,?,?,?)",
      "channel-thread-b", "telegram", "customer-b", "project-a"
    );
    for (let i = 1; i <= 10_005; i++) {
      storage.sql.exec(
        "INSERT INTO channel_messages(id,session_id,direction,text,created_at) VALUES(?,?,?,?,?)",
        `long-event-${i}`, "channel-thread-b", "inbound", `Message ${i}`, 1_700_000_000_000 + i
      );
    }
    const read = (agent as unknown as {
      loadChannelTranscript: (sessionId: string, options?: { beforeId?: string; limit?: number }) => Promise<{
        messages: Array<{ id: string; content: string }>;
        complete: boolean;
      }>;
    }).loadChannelTranscript.bind(agent);

    const newest = await read("channel-thread-b", { limit: 10_000 });
    expect(newest.complete).toBe(false);
    expect(newest.messages).toHaveLength(10_000);
    expect(newest.messages[0]?.id).toBe("long-event-6");
    const older = await read("channel-thread-b", { beforeId: "long-event-6", limit: 10 });
    expect(older).toMatchObject({ complete: true });
    expect(older.messages.map(({ id }) => id)).toEqual([
      "long-event-1", "long-event-2", "long-event-3", "long-event-4", "long-event-5",
    ]);
  });

  it("returns a cursor when the byte budget encounters one oversized message", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      { PLATFORM_SECRET: "channel-conversation-test-secret" } as never
    );
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec(
      "INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES(?,?,?,?)",
      "channel-thread-c", "telegram", "customer-c", "project-a"
    );
    storage.sql.exec(
      "INSERT INTO channel_messages(id,session_id,direction,text,created_at) VALUES(?,?,?,?,?)",
      "older-event", "channel-thread-c", "inbound", "Old launch decision", 1_700_000_000_000
    );
    storage.sql.exec(
      "INSERT INTO channel_messages(id,session_id,direction,text,created_at) VALUES(?,?,?,?,?)",
      "oversized-event", "channel-thread-c", "inbound", "x".repeat(16 * 1024 * 1024 + 1), 1_700_000_000_000
    );
    const read = (agent as unknown as {
      loadChannelTranscript: (sessionId: string, options?: { beforeId?: string }) => Promise<{
        messages: Array<{ id: string; content: string }>;
        complete: boolean;
        nextCursor?: string;
      }>;
    }).loadChannelTranscript.bind(agent);

    await expect(read("channel-thread-c")).resolves.toEqual({
      messages: [], complete: false, nextCursor: "oversized-event",
    });
    await expect(read("channel-thread-c", { beforeId: "oversized-event" })).resolves.toMatchObject({
      complete: true, messages: [{ id: "older-event", content: "Old launch decision" }],
    });
  });
});
