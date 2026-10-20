import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("conversation compaction over large threads", () => {
  it("keeps recent context available when a transcript exceeds the safe full-scan ceiling", async () => {
    const all = Array.from({ length: 10_001 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 ? "assistant" : "user",
      content: `Transcript item ${index + 1}`,
      created_at: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      {
        PLATFORM_SECRET: "conversation-compaction-test-secret",
        SPACES_WORKER: {
          async fetch(request: Request) {
            const url = new URL(request.url);
            const beforeId = url.searchParams.get("before_id");
            const beforeIndex = beforeId
              ? Number(beforeId.replace("message-", "")) - 1
              : all.length;
            const page = all.slice(Math.max(0, beforeIndex - 500), beforeIndex);
            return Response.json({ data: page });
          },
        },
      } as never
    );
    await agent.fetch(new Request("http://agent/initialize"));
    const load = (
      agent as unknown as {
        loadConversationContext: (
          spaceId: string,
          projectId: string,
          sessionId: string,
          tenantId: string,
        ) => Promise<{ recent: Array<{ content: string }>; summary: string } | undefined>;
      }
    ).loadConversationContext.bind(agent);

    const result = await load("space-1", "", "session-1", "tenant-1");
    expect(result?.recent.at(-1)?.content).toBe("Transcript item 10001");
    expect(result?.summary).toContain("exceeds the automatic compaction scan limit");
  });

  it("summarizes a transcript beyond 500 messages in bounded batches and checkpoints its last message ID", async () => {
    const all = Array.from({ length: 1_205 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 ? "assistant" : "user",
      content:
        index === 0
          ? "Keep the renewal reference R2-4821."
          : `Message ${index + 1} with a few preserved details.`,
      created_at: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    let summaryCalls = 0;
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      {
        PLATFORM_SECRET: "conversation-compaction-test-secret",
        SPACES_WORKER: {
          async fetch(request: Request) {
            const url = new URL(request.url);
            const beforeId = url.searchParams.get("before_id");
            const beforeIndex = beforeId
              ? Number(beforeId.replace("message-", "")) - 1
              : all.length;
            const page = all.slice(Math.max(0, beforeIndex - 500), beforeIndex);
            return Response.json({ data: page });
          },
        },
      } as never
    );
    await agent.fetch(new Request("http://agent/initialize"));
    const processor = {
      async summarize() {
        summaryCalls++;
        return {
          text: `Compacted summary revision ${summaryCalls}`,
          usage: {},
        };
      },
      async extract() {
        throw new Error("unused");
      },
      async compress() {
        throw new Error("unused");
      },
    };
    const compact = (
      agent as unknown as {
        compactConversationForSession: (
          spaceId: string,
          projectId: string,
          sessionId: string,
          tenantId: string,
          processor: typeof processor
        ) => Promise<
          | {
              summarized_messages: number;
              remaining_messages: number;
              complete: boolean;
              already_current: boolean;
            }
          | undefined
        >;
      }
    ).compactConversationForSession.bind(agent);

    const result = await compact(
      "space-1",
      "",
      "session-1",
      "tenant-1",
      processor
    );
    const stored = storage.sql
      .exec<{
        summary: string;
        covered_messages: number;
        covered_through_id: string;
      }>(
        "SELECT summary,covered_messages,covered_through_id FROM conversation_summaries WHERE session_id=?",
        "session-1"
      )
      .toArray()[0];
    expect(result).toMatchObject({
      complete: true,
      remaining_messages: 0,
      already_current: false,
    });
    expect(result?.summarized_messages).toBeGreaterThan(500);
    expect(summaryCalls).toBeGreaterThan(10);
    expect(stored?.covered_through_id).toBe(
      `message-${result?.summarized_messages}`
    );
    expect(stored?.covered_messages).toBe(result?.summarized_messages);
    expect(stored?.summary).toBe(`Compacted summary revision ${summaryCalls}`);

    const repeated = await compact(
      "space-1",
      "",
      "session-1",
      "tenant-1",
      processor
    );
    expect(repeated?.already_current).toBe(true);
    expect(summaryCalls).toBeGreaterThan(10);
  });
});
