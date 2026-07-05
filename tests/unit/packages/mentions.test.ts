import { describe, it, expect } from "vitest";
import { parseMentions } from "@naelao/events";
import type { MentionableAgent } from "@naelao/events";

// §A1.17 Phase T2: @mention parsing — a simple token scan against a project's allowed-agent
// roster (no NLP), deduped so mentioning the same agent twice dispatches exactly once. The
// mentioned agent's own reasoning loop handles everything it was asked; this function's only job
// is figuring out WHICH agent ids a message names.

const roster: MentionableAgent[] = [
  { id: "agent-1", name: "Support Agent" },
  { id: "agent-2", name: "Fulfillment" },
];

describe("parseMentions", () => {
  it("resolves a single mention by (case/punctuation-insensitive) name", () => {
    expect(parseMentions("@SupportAgent can you help?", roster)).toEqual(["agent-1"]);
    expect(parseMentions("@support-agent can you help?", roster)).toEqual(["agent-1"]);
  });

  it("resolves multiple distinct mentions in dispatch order", () => {
    expect(parseMentions("@Fulfillment ship it, then @SupportAgent reply to the customer", roster)).toEqual(["agent-2", "agent-1"]);
  });

  it("dedupes a repeated mention of the same agent to exactly one dispatch", () => {
    expect(parseMentions("@SupportAgent do X and @SupportAgent also do Y", roster)).toEqual(["agent-1"]);
  });

  it("silently skips a mention that doesn't match anyone in the roster (typo/removed agent)", () => {
    expect(parseMentions("@NotARealAgent please help", roster)).toEqual([]);
  });

  it("returns an empty list for a message with no mentions", () => {
    expect(parseMentions("just a normal message", roster)).toEqual([]);
  });

  it("returns an empty list against an empty roster regardless of the text", () => {
    expect(parseMentions("@SupportAgent hello", [])).toEqual([]);
  });

  it("does not match an email-address-shaped @ (no valid token boundary issue) as a false positive beyond the roster", () => {
    expect(parseMentions("contact me at foo@bar.com", roster)).toEqual([]);
  });
});
