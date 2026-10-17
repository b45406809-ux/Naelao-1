import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { clearChannelExtensionSessions, initChannelExtensionSessionStore, readChannelExtensionSession, readChannelExtensionSessions, summarizeChannelExtensionSessions, writeChannelExtensionNamedSessions, writeChannelExtensionSession } from "./channel-extension-session.js";

describe("external channel session storage", () => {
  it("isolates state by project, installation and opaque conversation ID", () => {
    const sql = createDOStorage().sql;
    initChannelExtensionSessionStore(sql);
    const now = 1_800_000_000_000;
    const scope = { projectId: "project-a", installationId: "install-a", conversationId: "conversation-a" };
    writeChannelExtensionSession(sql, { ...scope, value: { lesson: 3 }, maxBytes: 100, ttlDays: 7 }, now);
    expect(readChannelExtensionSession(sql, scope, now + 1)).toEqual({ lesson: 3 });
    expect(readChannelExtensionSession(sql, { ...scope, projectId: "project-b" }, now + 1)).toBeNull();
    expect(readChannelExtensionSession(sql, { ...scope, installationId: "install-b" }, now + 1)).toBeNull();
    expect(readChannelExtensionSession(sql, { ...scope, conversationId: "conversation-b" }, now + 1)).toBeNull();
  });

  it("expires state and allows an explicit clear", () => {
    const sql = createDOStorage().sql;
    initChannelExtensionSessionStore(sql);
    const scope = { projectId: "project-a", installationId: "install-a", conversationId: "conversation-a" };
    writeChannelExtensionSession(sql, { ...scope, value: { stage: "intro" }, maxBytes: 100, ttlDays: 1 }, 1_800_000_000_000);
    expect(readChannelExtensionSession(sql, scope, 1_800_086_400_001)).toBeNull();
    writeChannelExtensionSession(sql, { ...scope, value: { stage: "intro" }, maxBytes: 100, ttlDays: 1 }, 1_800_000_000_000);
    writeChannelExtensionSession(sql, { ...scope, value: null, maxBytes: 100, ttlDays: 1 }, 1_800_000_000_010);
    expect(readChannelExtensionSession(sql, scope, 1_800_000_000_011)).toBeNull();
  });

  it("enforces UTF-8 byte and TTL bounds", () => {
    const sql = createDOStorage().sql;
    initChannelExtensionSessionStore(sql);
    const scope = { projectId: "project-a", installationId: "install-a", conversationId: "conversation-a" };
    expect(() => writeChannelExtensionSession(sql, { ...scope, value: { text: "😊" }, maxBytes: 5, ttlDays: 1 })).toThrow("channel_session_size_limit");
    expect(() => writeChannelExtensionSession(sql, { ...scope, value: { ok: true }, maxBytes: 100, ttlDays: 91 })).toThrow("channel_session_ttl_invalid");
    expect(readChannelExtensionSession(sql, scope)).toBeNull();
  });

  it("stores multiple bounded named sessions per external conversation", () => {
    const sql = createDOStorage().sql; initChannelExtensionSessionStore(sql);
    const scope = { projectId: "project-a", installationId: "install-a", conversationId: "conversation-a" }, now = 1_800_000_000_000;
    writeChannelExtensionNamedSessions(sql, { ...scope, updates: [{ sessionId: "live", value: { order: "buy" } }, { sessionId: "paper", value: { order: "sell" } }], maxBytes: 100, ttlDays: 2 }, now);
    expect(readChannelExtensionSessions(sql, scope, now + 1)).toEqual({ live: { order: "buy" }, paper: { order: "sell" } });
    expect(readChannelExtensionSessions(sql, { ...scope, installationId: "install-b" }, now + 1)).toEqual({});
    expect(() => writeChannelExtensionNamedSessions(sql, { ...scope, updates: [{ sessionId: "../other", value: 1 }], maxBytes: 100, ttlDays: 2 }, now)).toThrow("channel_session_id_invalid");
    writeChannelExtensionNamedSessions(sql, { ...scope, updates: [{ sessionId: "live", value: null }], maxBytes: 100, ttlDays: 2 }, now + 2);
    expect(readChannelExtensionSessions(sql, scope, now + 3)).toEqual({ paper: { order: "sell" } });
  });

  it("summarizes retention metadata and clears only one installation", () => {
    const sql = createDOStorage().sql;
    initChannelExtensionSessionStore(sql);
    const now = 1_800_000_000_000;
    writeChannelExtensionSession(sql, { projectId: "project-a", installationId: "install-a", conversationId: "student-secret", value: { private: "answer" }, maxBytes: 100, ttlDays: 2 }, now);
    writeChannelExtensionSession(sql, { projectId: "project-a", installationId: "install-b", conversationId: "other", value: { private: "other" }, maxBytes: 100, ttlDays: 2 }, now);
    expect(summarizeChannelExtensionSessions(sql, "project-a", "install-a", now)).toMatchObject({
      activeConversations: 1,
      storedBytes: new TextEncoder().encode('{"private":"answer"}').byteLength,
      nextExpiryAt: now + 2 * 86_400_000,
    });
    expect(clearChannelExtensionSessions(sql, "project-a", "install-a")).toBe(1);
    expect(summarizeChannelExtensionSessions(sql, "project-a", "install-a", now).activeConversations).toBe(0);
    expect(readChannelExtensionSession(sql, { projectId: "project-a", installationId: "install-b", conversationId: "other" }, now)).toEqual({ private: "other" });
  });
});
