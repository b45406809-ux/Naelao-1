import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_MAX_MESSAGES,
  TRANSCRIPT_PAGE_SIZE,
  loadTranscriptPages,
} from "../../workers/agents/src/script-engine/transcript-loader.js";

describe("bounded conversation transcript paging", () => {
  it("loads older messages past SpaceDO's first 500-message page for accurate compaction", async () => {
    const all = Array.from({ length: 675 }, (_, i) => ({
      id: `m-${i}`,
      role: "user",
      content: `message ${i}`,
    }));
    const requests: Array<string | undefined> = [];
    const messages = await loadTranscriptPages<(typeof all)[number]>(
      async (beforeId) => {
        requests.push(beforeId);
        const cursor = beforeId
          ? all.findIndex((message) => message.id === beforeId)
          : all.length;
        return Response.json({
          data: all.slice(Math.max(0, cursor - TRANSCRIPT_PAGE_SIZE), cursor),
        });
      }
    );

    expect(messages).toHaveLength(675);
    expect(messages?.[0]?.content).toBe("message 0");
    expect(messages?.at(-1)?.content).toBe("message 674");
    expect(requests).toHaveLength(14);
    expect(requests).toContain("m-175");
  });

  it("fails closed when a transcript exceeds the compaction safety bound", async () => {
    const all = Array.from({ length: TRANSCRIPT_MAX_MESSAGES + 1 }, (_, i) => ({
      id: `m-${i}`,
      content: `message ${i}`,
    }));
    const result = await loadTranscriptPages<(typeof all)[number]>(
      async (beforeId) => {
        const cursor = beforeId
          ? all.findIndex((message) => message.id === beforeId)
          : all.length;
        return Response.json({
          data: all.slice(Math.max(0, cursor - TRANSCRIPT_PAGE_SIZE), cursor),
        });
      }
    );
    expect(result).toBeUndefined();
  });
});
