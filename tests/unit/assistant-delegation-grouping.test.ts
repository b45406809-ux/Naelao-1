import { describe, it, expect } from "vitest";
import { groupDelegations } from "../../apps/shell/src/components/AssistantDelegationCard.js";
import type { Message } from "../../apps/shell/src/lib/api.js";

// thread.send_message writes the assistant's turn, and the target agent writes its reply into the
// same transcript. Rendered as two adjacent left-aligned bubbles that reads as one speaker asking
// and then answering its own question — the reported symptom. These pin the pairing rule, and
// especially the cases where a card must NOT swallow a turn that isn't its reply.

function msg(over: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "…",
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Message;
}

const delegated = (id: string, agentId: string | null, awaiting = true): Message =>
  msg({ id, metadata: { assistant_delegation: { agent_id: agentId, on_behalf_of_user: true, awaiting_reply: awaiting } } });

describe("groupDelegations", () => {
  it("leaves an ordinary transcript completely untouched", () => {
    const items = groupDelegations([msg({ id: "a", role: "user" }), msg({ id: "b" })]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("pairs the assistant's delegated message with the agent reply that follows it", () => {
    const items = groupDelegations([
      delegated("d1", "support-agent"),
      msg({ id: "r1", author_type: "agent", author_id: "support-agent", content: "on it" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("delegation");
    const d = items[0] as { request: Message; reply?: Message };
    expect(d.request.id).toBe("d1");
    expect(d.reply?.id).toBe("r1");
  });

  it("does NOT swallow a user message that follows the delegation", () => {
    const items = groupDelegations([
      delegated("d1", "support-agent"),
      msg({ id: "u1", role: "user", content: "wait" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("delegation");
    expect((items[0] as { reply?: Message }).reply).toBeUndefined();
    expect(items[1]!.kind).toBe("message");
  });

  it("does NOT swallow a reply authored by a DIFFERENT agent", () => {
    const items = groupDelegations([
      delegated("d1", "support-agent"),
      msg({ id: "r1", author_type: "agent", author_id: "content-agent" }),
    ]);
    expect(items).toHaveLength(2);
    expect((items[0] as { reply?: Message }).reply).toBeUndefined();
  });

  it("does NOT chain two delegations into one card", () => {
    const items = groupDelegations([delegated("d1", "a1"), delegated("d2", "a2")]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "delegation")).toBe(true);
    expect((items[0] as { reply?: Message }).reply).toBeUndefined();
  });

  it("leaves a respond:false delegation with no reply", () => {
    const items = groupDelegations([delegated("d1", "a1", false)]);
    expect(items).toHaveLength(1);
    expect((items[0] as { reply?: Message }).reply).toBeUndefined();
  });

  it("keeps ordinary messages around a delegation in order", () => {
    const items = groupDelegations([
      msg({ id: "u0", role: "user" }),
      delegated("d1", "support-agent"),
      msg({ id: "r1", author_type: "agent", author_id: "support-agent" }),
      msg({ id: "u2", role: "user" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "delegation", "message"]);
  });
});
