// Conversation context — what the model actually knows about the thread it's replying in.
//
// Before this existed the reasoner payload carried NO conversation history: the agent could not
// resolve "do that again", could not answer "what did we decide", and re-asked things the user
// had already told it. These tests pin both halves of the fix: that recent history is carried,
// and that when it is compacted the model is TOLD so and pointed at a way to look things up —
// rather than being left to answer confidently from a partial record.

import { describe, it, expect } from "vitest";
import {
  buildConversationContext,
  needsSummarization,
  messagesToSummarize,
  buildSummaryPrompt,
  renderConversationForReasoner,
  estimateTokens,
  DEFAULT_CONVERSATION_LIMITS,
  type ConversationMessage,
} from "../../workers/agents/src/script-engine/conversation-context.js";

function convo(n: number, chars = 40): ConversationMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i} ${"x".repeat(Math.max(0, chars - 12))}`,
    created_at: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
}

describe("conversation context — carries the recent past", () => {
  it("keeps a short conversation whole and does not mark it compacted", () => {
    const ctx = buildConversationContext(convo(5));
    expect(ctx.recent).toHaveLength(5);
    expect(ctx.compacted).toBe(false);
    expect(ctx.omittedMessages).toBe(0);
    expect(ctx.totalMessages).toBe(5);
  });

  it("keeps the NEWEST messages when it has to drop some", () => {
    // A conversation where the last thing the user said got evicted would be actively harmful.
    const ctx = buildConversationContext(convo(200));
    expect(ctx.compacted).toBe(true);
    const last = ctx.recent[ctx.recent.length - 1];
    expect(last?.content).toContain("message 199");
    expect(ctx.recent.length).toBeLessThanOrEqual(DEFAULT_CONVERSATION_LIMITS.maxMessages);
  });

  it("stays inside its token budget", () => {
    const ctx = buildConversationContext(convo(500, 400));
    const used = ctx.recent.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
    expect(used).toBeLessThanOrEqual(DEFAULT_CONVERSATION_LIMITS.maxTokens);
  });

  it("truncates one enormous message rather than letting it evict everything else", () => {
    const messages: ConversationMessage[] = [
      ...convo(3),
      { role: "user", content: "y".repeat(50_000) },
    ];
    const ctx = buildConversationContext(messages);
    // The giant message is still present, but cut — and says it was cut, because a silently
    // truncated message reads as a complete one that simply ended oddly.
    const huge = ctx.recent.find((m) => m.content.startsWith("y"));
    expect(huge).toBeDefined();
    expect(huge!.content).toContain("truncated");
    expect(huge!.content.length).toBeLessThan(50_000);
  });

  it("always keeps at least one message even when a single message blows the whole budget", () => {
    const ctx = buildConversationContext([{ role: "user", content: "z".repeat(100_000) }]);
    expect(ctx.recent).toHaveLength(1);
  });

  it("survives malformed input rather than throwing on the hot path", () => {
    const ctx = buildConversationContext([
      { role: "user", content: "fine" },
      null as unknown as ConversationMessage,
      { role: "user", content: 42 as unknown as string },
    ]);
    expect(ctx.recent.length).toBeGreaterThanOrEqual(1);
    expect(() => buildConversationContext(undefined as unknown as ConversationMessage[])).not.toThrow();
  });
});

describe("conversation context — compaction is explicit, never silent", () => {
  it("tells the model the conversation is compacted and how much is missing", () => {
    const rendered = renderConversationForReasoner(buildConversationContext(convo(200)));
    expect(rendered["compacted"]).toBe(true);
    expect(rendered["omitted_messages"]).toBeGreaterThan(0);
    expect(rendered["total_messages"]).toBe(200);
  });

  it("points the model at conversation.search instead of letting it guess", () => {
    // This is the actual fix for the Claude Code compaction failure mode: after a compact the
    // assistant otherwise treats anything absent from the summary as never having happened.
    const rendered = renderConversationForReasoner(buildConversationContext(convo(200)));
    const notice = String(rendered["notice"]);
    expect(notice).toContain("COMPACTED");
    expect(notice).toContain("conversation.search");
    expect(notice.toLowerCase()).toContain("do not guess");
    expect(notice.toLowerCase()).toContain("never happened");
  });

  it("adds no compaction notice when nothing was dropped", () => {
    const rendered = renderConversationForReasoner(buildConversationContext(convo(4)));
    expect(rendered["compacted"]).toBe(false);
    expect(rendered["notice"]).toBeUndefined();
  });

  it("carries the earlier summary when one exists", () => {
    const rendered = renderConversationForReasoner(
      buildConversationContext(convo(200), "The user is setting up a Whop store.")
    );
    expect(rendered["earlier_summary"]).toBe("The user is setting up a Whop store.");
  });
});

describe("conversation context — summarisation targets", () => {
  it("only summarises once history actually exceeds the window", () => {
    expect(needsSummarization(convo(5))).toBe(false);
    expect(needsSummarization(convo(300))).toBe(true);
  });

  it("summarises the OLDEST messages — the ones falling out of the window", () => {
    const messages = convo(200);
    const older = messagesToSummarize(messages);
    expect(older.length).toBeGreaterThan(0);
    expect(older[0]?.content).toContain("message 0");
    // and never includes the newest, which is carried verbatim instead
    expect(older[older.length - 1]?.content).not.toContain("message 199");
  });

  it("the summary prompt protects decisions and concrete facts over chatter", () => {
    const prompt = buildSummaryPrompt(
      [{ role: "user", content: "pay Alice $200 on Friday" }],
      "prior summary"
    );
    expect(prompt).toContain("decisions made");
    expect(prompt).toContain("names, files, amounts");
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("prior summary");
    expect(prompt).toContain("pay Alice $200");
  });
});
