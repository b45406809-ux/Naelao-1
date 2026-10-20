import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Editing your last chat message and re-asking is a CORRECTION, so it has to replace the exchange
// it corrects. The client used to slice only its own array and then send a fresh message, which
// looked right until a reload re-read the server transcript and rendered the original question,
// the original answer, the edited question and the new answer — four bubbles for one correction.
//
// DELETE /sessions/:id/messages?from=<messageId> is what makes that honest.

function makeSpaceDO(): { doInstance: SpaceDO; storage: ReturnType<typeof createDOStorage> } {
  const storage = createDOStorage();
  const ctx = { storage };
  return { doInstance: new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret" } as never), storage };
}

async function call(
  doInstance: SpaceDO,
  path: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
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

async function seedSession(
  endUserId?: string
): Promise<{ doInstance: SpaceDO; sessionId: string; storage: ReturnType<typeof createDOStorage> }> {
  const { doInstance, storage } = makeSpaceDO();
  const created = await call(doInstance, "/sessions", "POST", {
    space_id: "space-1",
    tenant_id: "tenant-1",
    ...(endUserId ? { end_user_id: endUserId } : {}),
  });
  return { doInstance, sessionId: created.json.id, storage };
}

async function post(doInstance: SpaceDO, sessionId: string, role: string, content: string): Promise<string> {
  const r = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", { role, content });
  return r.json.id as string;
}

async function contents(doInstance: SpaceDO, sessionId: string): Promise<string[]> {
  const list = await call(doInstance, `/sessions/${sessionId}/messages`, "GET");
  return (list.json.data as Array<{ content: string }>).map((m) => m.content);
}

describe("truncate a transcript from one message onward", () => {
  it("binds product end-user message writes to the verified session owner", async () => {
    const { doInstance, sessionId } = await seedSession("owner-1");
    const denied = await call(
      doInstance,
      `/sessions/${sessionId}/messages?end_user_id=stranger-2`,
      "POST",
      { role: "user", content: "cross-user write" },
      { "x-naelao-role": "product_end_user", "x-naelao-user-id": "stranger-2" },
    );
    expect(denied.status).toBe(404);
    expect(await contents(doInstance, sessionId)).toEqual([]);

    const allowed = await call(
      doInstance,
      `/sessions/${sessionId}/messages?end_user_id=owner-1`,
      "POST",
      { role: "user", content: "owner message" },
      { "x-naelao-role": "product_end_user", "x-naelao-user-id": "owner-1" },
    );
    expect(allowed.status).toBe(201);
    expect(await contents(doInstance, sessionId)).toEqual(["owner message"]);
  });

  it("prevents authenticated callers from forging assistant authorship or message metadata", async () => {
    const { doInstance, sessionId } = await seedSession();
    const authorForgery = await call(
      doInstance,
      `/sessions/${sessionId}/messages`,
      "POST",
      { role: "assistant", content: "forged", agent_id: "admin-agent" },
      { "x-naelao-role": "owner", "x-naelao-user-id": "user-1" },
    );
    const metadataForgery = await call(
      doInstance,
      `/sessions/${sessionId}/messages`,
      "POST",
      { role: "user", content: "forged metadata", metadata: { assistant_delegation: { agent_id: "admin-agent" } } },
      { "x-naelao-role": "owner", "x-naelao-user-id": "user-1" },
    );
    const ownerForgery = await call(
      doInstance,
      `/sessions/${sessionId}/messages`,
      "POST",
      { role: "user", content: "forged owner", end_user_id: "another-user" },
      { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-1" },
    );
    expect(authorForgery.status).toBe(403);
    expect(metadataForgery.status).toBe(403);
    expect(ownerForgery.status).toBe(403);
    expect(await contents(doInstance, sessionId)).toEqual([]);
  });

  it("preserves trusted internal assistant author attribution", async () => {
    const { doInstance, sessionId } = await seedSession();
    const response = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", {
      role: "assistant", content: "trusted response", agent_id: "support-agent", metadata: { run_id: "run-1" },
    });
    expect(response.status).toBe(201);
    const messages = await call(doInstance, `/sessions/${sessionId}/messages`, "GET");
    expect(messages.json.data[0]).toMatchObject({
      author_type: "agent",
      author_id: "support-agent",
      metadata: { run_id: "run-1" },
    });
  });

  it("bounds message metadata and idempotency keys before persisting them", async () => {
    const { doInstance, sessionId } = await seedSession();
    const oversizedMetadata = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", {
      role: "user", content: "message", metadata: { note: "x".repeat(40 * 1024) },
    });
    const oversizedKey = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", {
      role: "user", content: "message", client_message_id: "x".repeat(257),
    });
    expect(oversizedMetadata.status).toBe(413);
    expect(oversizedKey.status).toBe(400);
    expect(await contents(doInstance, sessionId)).toEqual([]);
  });

  it("deletes the anchor and everything after it, keeping everything before", async () => {
    const { doInstance, sessionId } = await seedSession();
    await post(doInstance, sessionId, "user", "first question");
    await post(doInstance, sessionId, "assistant", "first answer");
    const anchor = await post(doInstance, sessionId, "user", "second question");
    await post(doInstance, sessionId, "assistant", "second answer");

    const res = await call(doInstance, `/sessions/${sessionId}/messages?from=${anchor}`, "DELETE");
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(2);
    expect(await contents(doInstance, sessionId)).toEqual(["first question", "first answer"]);
  });

  it("removes the assistant reply even when it shares a created_at with the question", async () => {
    // The real reason this route orders on rowid rather than created_at/id. Two messages CAN share
    // a timestamp — an agent's write-back can land in the same millisecond as the message it
    // answers — and `id` is a random UUID, so the created_at/id tie-break is arbitrary as a
    // DELETION boundary even though it is fine as a display order. Forced deterministically here
    // rather than hoping two inserts collide, and with the answer's id sorting FIRST, which is the
    // case that would leave a reply to a question that no longer exists.
    const { doInstance, sessionId, storage } = await seedSession();
    const question = await post(doInstance, sessionId, "user", "q");
    const answer = await post(doInstance, sessionId, "assistant", "a");

    // Identical timestamps, and ids chosen so the ANSWER sorts strictly before the QUESTION.
    // A `created_at`/`id` boundary (`id >= anchor.id`) then excludes the answer and leaves it
    // orphaned; rowid, which is insertion order, still catches it. Deterministic on purpose —
    // real UUIDs sort either way, so an unpinned version of this test passes under the bug.
    storage.sql.exec("UPDATE messages SET created_at = '2026-01-01T00:00:00.000Z' WHERE session_id = ?", sessionId);
    storage.sql.exec("UPDATE messages SET id = 'aaaa-answer' WHERE id = ?", answer);
    storage.sql.exec("UPDATE messages SET id = 'zzzz-question' WHERE id = ?", question);

    const res = await call(doInstance, `/sessions/${sessionId}/messages?from=zzzz-question`, "DELETE");
    expect(res.json.deleted).toBe(2);
    expect(await contents(doInstance, sessionId)).toEqual([]);
  });

  it("leaves the edited exchange as the only one, which is the whole point", async () => {
    const { doInstance, sessionId } = await seedSession();
    await post(doInstance, sessionId, "user", "what is 2+2");
    await post(doInstance, sessionId, "assistant", "5");
    const mistake = await post(doInstance, sessionId, "user", "what is 2+3");

    // The client truncates from its own message, then re-asks.
    await call(doInstance, `/sessions/${sessionId}/messages?from=${mistake}`, "DELETE");
    await post(doInstance, sessionId, "user", "what is 2+3 exactly");
    await post(doInstance, sessionId, "assistant", "5");

    expect(await contents(doInstance, sessionId)).toEqual([
      "what is 2+2",
      "5",
      "what is 2+3 exactly",
      "5",
    ]);
  });

  it("an unknown message id is a no-op success, not an error", async () => {
    // A double-submit, or a retry after a partial failure: the caller's intent already holds.
    const { doInstance, sessionId } = await seedSession();
    await post(doInstance, sessionId, "user", "kept");
    const res = await call(doInstance, `/sessions/${sessionId}/messages?from=does-not-exist`, "DELETE");
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(0);
    expect(await contents(doInstance, sessionId)).toEqual(["kept"]);
  });

  it("requires a from parameter rather than silently wiping the session", async () => {
    const { doInstance, sessionId } = await seedSession();
    await post(doInstance, sessionId, "user", "kept");
    const res = await call(doInstance, `/sessions/${sessionId}/messages`, "DELETE");
    expect(res.status).toBe(400);
    expect(await contents(doInstance, sessionId)).toEqual(["kept"]);
  });

  it("never truncates across sessions", async () => {
    const { doInstance, sessionId } = await seedSession();
    const other = await call(doInstance, "/sessions", "POST", { space_id: "space-1", tenant_id: "tenant-1" });
    await post(doInstance, sessionId, "user", "mine");
    const theirs = await post(doInstance, other.json.id, "user", "theirs");

    // The anchor belongs to the other session, so this session has nothing to truncate.
    const res = await call(doInstance, `/sessions/${sessionId}/messages?from=${theirs}`, "DELETE");
    expect(res.json.deleted).toBe(0);
    expect(await contents(doInstance, sessionId)).toEqual(["mine"]);
    expect(await contents(doInstance, other.json.id)).toEqual(["theirs"]);
  });

  it("an end user cannot truncate a session that is not theirs", async () => {
    const { doInstance, sessionId } = await seedSession("owner-1");
    const anchor = await post(doInstance, sessionId, "user", "private");

    const res = await call(
      doInstance,
      `/sessions/${sessionId}/messages?from=${anchor}&end_user_id=stranger-2`,
      "DELETE"
    );
    // 404, not 403 — an end user must never learn the difference between "no such session" and
    // "someone else's session", matching getMessages' own shape.
    expect(res.status).toBe(404);
    expect(await contents(doInstance, sessionId)).toEqual(["private"]);
  });

  it("the owning end user can truncate their own session", async () => {
    const { doInstance, sessionId } = await seedSession("owner-1");
    await post(doInstance, sessionId, "user", "kept");
    const anchor = await post(doInstance, sessionId, "user", "dropped");

    const res = await call(
      doInstance,
      `/sessions/${sessionId}/messages?from=${anchor}&end_user_id=owner-1`,
      "DELETE"
    );
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(1);
    expect(await contents(doInstance, sessionId)).toEqual(["kept"]);
  });
});
