import { describe, it, expect } from "vitest";
import { getAdapter, isChannelType, sessionKey } from "../../workers/agents/src/launchpad/channels.js";

// One adapter interface across channels (appendix @4211129/@4198622/@4200734/@3190360).

describe("channel adapters — inbound normalization", () => {
  it("normalizes an email payload", () => {
    const n = getAdapter("email")!.normalizeInbound({ from: "User@Example.com", text: "hi", message_id: "m1" });
    expect(n).toEqual({ channel: "email", channel_user_id: "user@example.com", text: "hi", external_id: "m1", timestamp: expect.any(Number) });
  });

  it("normalizes a slack payload and ignores bot echoes", () => {
    const a = getAdapter("slack")!;
    expect(a.normalizeInbound({ user: "U1", text: "hello", ts: "1700000000.0001" })?.channel_user_id).toBe("U1");
    expect(a.normalizeInbound({ bot_id: "B1", user: "U1", text: "x", ts: "1" })).toBeNull(); // bot echo ignored
  });

  it("normalizes a discord payload and ignores bots", () => {
    const a = getAdapter("discord")!;
    expect(a.normalizeInbound({ author: { id: "D1" }, content: "yo", id: "msg1" })?.channel_user_id).toBe("D1");
    expect(a.normalizeInbound({ author: { id: "D1", bot: true }, content: "x", id: "m" })).toBeNull();
  });

  it("returns null for incomplete payloads (no crash)", () => {
    expect(getAdapter("email")!.normalizeInbound({})).toBeNull();
    expect(getAdapter("slack")!.normalizeInbound({ user: "U1" })).toBeNull();
  });
});

describe("channel adapters — outbound formatting", () => {
  it("formats per channel", () => {
    expect(getAdapter("slack")!.formatOutbound({ text: "hi" })).toHaveProperty("blocks");
    expect(getAdapter("discord")!.formatOutbound({ text: "hi" })).toEqual({ content: "hi" });
    expect(getAdapter("email")!.formatOutbound({ text: "hi" })).toMatchObject({ body: "hi" });
  });
});

describe("per-user session keys (appendix @3245389 — no cross-user bleed)", () => {
  it("includes the channel user id, so two Slack users get different sessions", () => {
    expect(sessionKey("slack", "U1")).not.toBe(sessionKey("slack", "U2"));
    expect(sessionKey("slack", "U1")).toBe("slack:U1");
  });
});

describe("channel type guard", () => {
  it("accepts known channels, rejects unknown", () => {
    expect(isChannelType("email")).toBe(true);
    expect(isChannelType("telegram")).toBe(false);
    expect(getAdapter("telegram")).toBeUndefined();
  });
});
