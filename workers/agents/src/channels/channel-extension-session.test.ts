import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { initChannelExtensionSessionStore, readChannelExtensionSession, writeChannelExtensionSession } from "./channel-extension-session.js";

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
});
