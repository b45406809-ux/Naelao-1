import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// §A1.17 Phase O: agent API keys (nak_...) + the per-agent approval-policy fallback chain, both
// implemented entirely inside SpaceDO (mirrors BuilderAccountDO's api_keys pattern — hash+prefix
// persisted, raw key returned once) — and the messages.author_type/author_id attribution that
// lets a thread bubble say "Agent1" instead of every non-user message collapsing into 'assistant'.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: createDOStorage() };
  return new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret" } as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("Agent API keys", () => {
  it("mints a key, returns the raw key once, and never re-exposes it in the list", async () => {
    const doInstance = makeSpaceDO();
    const minted = await call(doInstance, "/agents/agent-1/api-keys", "POST");
    expect(minted.status).toBe(201);
    expect(minted.json.key).toMatch(/^nak_/);
    expect(minted.json.agent_id).toBe("agent-1");

    const listed = await call(doInstance, "/agents/agent-1/api-keys", "GET");
    expect(listed.json.data).toHaveLength(1);
    expect(listed.json.data[0].key_prefix).toBe(minted.json.key.slice(0, 11));
    expect(listed.json.data[0].key).toBeUndefined();
  });

  it("verifies a freshly minted key and defaults to always_ask/empty policy", async () => {
    const doInstance = makeSpaceDO();
    const minted = await call(doInstance, "/agents/agent-1/api-keys", "POST");
    const verified = await call(doInstance, "/internal/agent-keys/verify", "POST", { space_id: "space-1", key: minted.json.key });
    expect(verified.json).toEqual({
      valid: true, agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: [],
    });
  });

  it("rejects an unknown or malformed key", async () => {
    const doInstance = makeSpaceDO();
    const bogus = await call(doInstance, "/internal/agent-keys/verify", "POST", { space_id: "space-1", key: "nak_doesnotexist" });
    expect(bogus.json).toEqual({ valid: false });
    const malformed = await call(doInstance, "/internal/agent-keys/verify", "POST", { space_id: "space-1", key: "not-a-key" });
    expect(malformed.json).toEqual({ valid: false });
  });

  it("revoking a key makes it fail verification immediately", async () => {
    const doInstance = makeSpaceDO();
    const minted = await call(doInstance, "/agents/agent-1/api-keys", "POST");
    const revoked = await call(doInstance, `/agents/agent-1/api-keys/${minted.json.id}`, "DELETE");
    expect(revoked.status).toBe(200);
    const verified = await call(doInstance, "/internal/agent-keys/verify", "POST", { space_id: "space-1", key: minted.json.key });
    expect(verified.json).toEqual({ valid: false });
  });

  it("keeps keys scoped per agentId — agent-2's list never shows agent-1's key", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/agents/agent-1/api-keys", "POST");
    const agent2List = await call(doInstance, "/agents/agent-2/api-keys", "GET");
    expect(agent2List.json.data).toHaveLength(0);
  });

  it("falls back to the space-wide assistant_policy when no per-agent override exists", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/assistant-policy", "PATCH", { approval_mode: "yolo", auto_approved_actions: ["POST:projects"] }, undefined);
    // assistant-policy PATCH reads space_id from the query string, not the body
    await doInstance.fetch(new Request("http://space-do/assistant-policy?space_id=space-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval_mode: "yolo", auto_approved_actions: ["POST:projects"] }),
    }));
    const policy = await call(doInstance, "/agents/agent-1/policy?space_id=space-1", "GET");
    expect(policy.json).toEqual({ space_id: "space-1", agent_id: "agent-1", approval_mode: "yolo", auto_approved_actions: ["POST:projects"] });
  });

  it("a per-agent override takes precedence over the space-wide assistant_policy", async () => {
    const doInstance = makeSpaceDO();
    await doInstance.fetch(new Request("http://space-do/assistant-policy?space_id=space-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval_mode: "yolo" }),
    }));
    await call(doInstance, "/agents/agent-1/policy?space_id=space-1", "PATCH", { approval_mode: "always_ask", auto_approved_actions: ["GET:threads"] });
    const policy = await call(doInstance, "/agents/agent-1/policy?space_id=space-1", "GET");
    expect(policy.json).toEqual({ space_id: "space-1", agent_id: "agent-1", approval_mode: "always_ask", auto_approved_actions: ["GET:threads"] });

    // A DIFFERENT agent in the same space is unaffected by agent-1's override.
    const other = await call(doInstance, "/agents/agent-2/policy?space_id=space-1", "GET");
    expect(other.json.approval_mode).toBe("yolo");
  });

  it("verify folds the resolved per-agent policy into the same round trip", async () => {
    const doInstance = makeSpaceDO();
    const minted = await call(doInstance, "/agents/agent-1/api-keys", "POST");
    await call(doInstance, "/agents/agent-1/policy?space_id=space-1", "PATCH", { approval_mode: "yolo" });
    const verified = await call(doInstance, "/internal/agent-keys/verify", "POST", { space_id: "space-1", key: minted.json.key });
    expect(verified.json.approval_mode).toBe("yolo");
  });
});

describe("Message attribution (author_type/author_id)", () => {
  async function makeSessionDO(): Promise<{ doInstance: SpaceDO; sessionId: string }> {
    const doInstance = makeSpaceDO();
    const created = await call(doInstance, "/sessions", "POST", { space_id: "space-1", tenant_id: "tenant-1" });
    return { doInstance, sessionId: created.json.id };
  }

  it("a router-proxied agent-role message is attributed to that agent", async () => {
    const { doInstance, sessionId } = await makeSessionDO();
    const posted = await call(doInstance, `/sessions/${sessionId}/messages`, "POST",
      { role: "assistant", content: "Done." },
      { "x-naelao-role": "agent", "x-naelao-user-id": "agent-1" }
    );
    expect(posted.json.author_type).toBe("agent");
    expect(posted.json.author_id).toBe("agent-1");
  });

  it("the Space Assistant's own agentId maps to author_type 'assistant', not 'agent'", async () => {
    const { doInstance, sessionId } = await makeSessionDO();
    const posted = await call(doInstance, `/sessions/${sessionId}/messages`, "POST",
      { role: "assistant", content: "Hi." },
      { "x-naelao-role": "agent", "x-naelao-user-id": "naelao-agent" }
    );
    expect(posted.json.author_type).toBe("assistant");
    expect(posted.json.author_id).toBe("naelao-agent");
  });

  it("a trusted internal write-back (no x-naelao-role header) uses body.agent_id", async () => {
    const { doInstance, sessionId } = await makeSessionDO();
    const posted = await call(doInstance, `/sessions/${sessionId}/messages`, "POST",
      { role: "assistant", content: "Final answer.", agent_id: "agent-7" }
    );
    expect(posted.json.author_type).toBe("agent");
    expect(posted.json.author_id).toBe("agent-7");
  });

  it("an ordinary end-user message is attributed author_type 'user' with their own id", async () => {
    const { doInstance, sessionId } = await makeSessionDO();
    const posted = await call(doInstance, `/sessions/${sessionId}/messages`, "POST",
      { role: "user", content: "Hello" },
      { "x-naelao-user-id": "end-user-42" }
    );
    expect(posted.json.author_type).toBe("user");
    expect(posted.json.author_id).toBe("end-user-42");
  });

  it("GET messages includes author_type/author_id for every stored message", async () => {
    const { doInstance, sessionId } = await makeSessionDO();
    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", { role: "user", content: "hi" }, { "x-naelao-user-id": "u1" });
    const list = await call(doInstance, `/sessions/${sessionId}/messages`, "GET");
    expect(list.json.data[0].author_type).toBe("user");
    expect(list.json.data[0].author_id).toBe("u1");
  });
});
