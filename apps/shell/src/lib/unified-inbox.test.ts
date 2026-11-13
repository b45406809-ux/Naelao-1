import { describe, expect, it } from "vitest";
import {
  activeAgentMailAccounts,
  agentMailInboxMessages,
  agentMailPageCursor,
  assistantInboxMessages,
  sortUnifiedInboxMessages,
} from "@/lib/unified-inbox";
import type { ManagedServiceDashboard } from "@/lib/api";

describe("unified inbox source boundaries", () => {
  it("namespaces identical message IDs by source and selected scope", () => {
    const assistant = assistantInboxMessages(
      [{
        id: "same-id",
        direction: "inbound",
        channel: "email",
        sender: "a@example.test",
        recipient: "b@example.test",
        subject: "Assistant message",
        status: "received",
        created_at: "2026-11-13T12:00:00Z",
      }],
      "project-a"
    )[0]!;
    const agentMail = agentMailInboxMessages(
      { messages: [{ id: "same-id", subject: "AgentMail message" }] },
      "connection-a"
    )[0]!;

    expect(assistant.key).toBe("assistant:project-a:same-id");
    expect(agentMail.key).toBe("agentmail:connection-a:same-id");
    expect(assistant.key).not.toBe(agentMail.key);
  });

  it("normalizes nested AgentMail result shapes and keeps provider cursor separate", () => {
    expect(
      agentMailInboxMessages(
        { data: { results: [{ message: { messageId: "m-1", from: "sender@example.test" } }] } },
        "connection-a"
      )
    ).toMatchObject([
      {
        source: "agentmail",
        scopeId: "connection-a",
        messageId: "m-1",
        sender: "sender@example.test",
      },
    ]);
    expect(agentMailPageCursor({ next_page_token: "agent-cursor" })).toBe(
      "agent-cursor"
    );
    expect(agentMailPageCursor({ next_cursor: "assistant-cursor" })).toBe(
      "assistant-cursor"
    );
  });

  it("lists only active AgentMail connections and sorts available timestamps", () => {
    const dashboard = {
      accounts: [
        { id: "active", provider: "agentmail", status: "active" },
        { id: "revoked", provider: "agentmail", status: "revoked" },
        { id: "other", provider: "twilio", status: "active" },
      ],
    } as ManagedServiceDashboard;
    expect(activeAgentMailAccounts(dashboard).map((account) => account.id)).toEqual([
      "active",
    ]);
    expect(
      sortUnifiedInboxMessages([
        { key: "old", createdAt: "2026-11-12T00:00:00Z" },
        { key: "new", createdAt: "2026-11-13T00:00:00Z" },
      ] as ReturnType<typeof assistantInboxMessages>).map((item) => item.key)
    ).toEqual(["new", "old"]);
  });
});
