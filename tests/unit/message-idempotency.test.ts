import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Two reported symptoms, one root cause each, both about the SERVER transcript — a reload discards
// every scrap of client state, so anything wrong after a reload is wrong in the database:
//
//  • "the reload duplicate is still there" — POST /messages was not idempotent, and apps/shell's
//    apiFetch retries a POST on a network-level throw or a 5xx/429. Neither proves the server
//    didn't already commit the row: a reset connection, or a response lost on the way back, both
//    throw client-side while the write succeeded. The retry then wrote a SECOND identical message.
//    Invisible live (the client renders only the one response it eventually got) and obvious the
//    moment you reload.
//
//  • "I got a reply but when I reload it's gone" — the agent's own write-back was fire-and-forget
//    (`void`), so it raced the DO handler returning. That one is fixed in NaelaoAgentDO (await);
//    what this file pins is the idempotency half, plus the fact that the assistant write-back's
//    own key (run:<runId>) makes a replayed Workflow step resolve to the answer already written.

function makeSpaceDO(): SpaceDO {
  return new SpaceDO({ storage: createDOStorage() } as never, { PLATFORM_SECRET: "test-secret" } as never);
}

async function call(
  doInstance: SpaceDO,
  path: string,
  method: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  return { status: resp.status, json: await resp.json().catch(() => null) };
}

async function seedSession(doInstance: SpaceDO): Promise<string> {
  const created = await call(doInstance, "/sessions", "POST", { space_id: "space-1", tenant_id: "tenant-1" });
  return created.json.id as string;
}

async function contents(doInstance: SpaceDO, sessionId: string): Promise<string[]> {
  const list = await call(doInstance, `/sessions/${sessionId}/messages`, "GET");
  return (list.json.data as Array<{ content: string }>).map((m) => m.content);
}

describe("POST /messages idempotency (migration v38)", () => {
  it("a retried send with the same client_message_id writes ONE message, not two", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);

    // Exactly what apiFetch does when its first attempt throws after the server already committed:
    // the same body, including the same key minted once outside the retry loop.
    const body = { role: "user", content: "what should I charge?", client_message_id: "cmid-1" };
    const first = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", body);
    const retry = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", body);

    expect(first.status).toBe(201);
    // The retry succeeds rather than erroring — the caller gets the same 2xx it would have seen
    // had the first response reached it — and resolves to the SAME message.
    expect(retry.status).toBe(200);
    expect(retry.json.deduplicated).toBe(true);
    expect(retry.json.id).toBe(first.json.id);

    expect(await contents(doInstance, sessionId)).toEqual(["what should I charge?"]);
  });

  it("survives many retries of the same send", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    const body = { role: "user", content: "hello", client_message_id: "cmid-flaky" };

    for (let i = 0; i < 5; i++) await call(doInstance, `/sessions/${sessionId}/messages`, "POST", body);

    expect(await contents(doInstance, sessionId)).toEqual(["hello"]);
  });

  it("does NOT collapse two genuinely separate sends of identical text", async () => {
    // The whole reason this needs a real key rather than deduping on content: a person saying
    // "yes" twice means it twice. Each send mints its own key.
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);

    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", { role: "user", content: "yes", client_message_id: "cmid-a" });
    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", { role: "user", content: "yes", client_message_id: "cmid-b" });

    expect(await contents(doInstance, sessionId)).toEqual(["yes", "yes"]);
  });

  it("keys are scoped per session — the same key in another session is a different message", async () => {
    const doInstance = makeSpaceDO();
    const sessionA = await seedSession(doInstance);
    const sessionB = await seedSession(doInstance);

    await call(doInstance, `/sessions/${sessionA}/messages`, "POST", { role: "user", content: "in A", client_message_id: "same-key" });
    await call(doInstance, `/sessions/${sessionB}/messages`, "POST", { role: "user", content: "in B", client_message_id: "same-key" });

    expect(await contents(doInstance, sessionA)).toEqual(["in A"]);
    expect(await contents(doInstance, sessionB)).toEqual(["in B"]);
  });

  it("a message with no key behaves exactly as before (every historical row is unkeyed)", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);

    // Two unkeyed writes must both land — the partial unique index must not treat NULL == NULL,
    // or every pre-migration row would collide with every other one.
    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", { role: "user", content: "one" });
    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", { role: "user", content: "two" });

    expect(await contents(doInstance, sessionId)).toEqual(["one", "two"]);
  });

  it("an assistant answer keyed by its run can't be written twice by a replayed run", async () => {
    // NaelaoAgentDO.writeAgentAnswerToSession passes `run:<runId>`. A CF Workflow step that
    // replays (or a retried /internal/tasks/:taskId/run dispatch, which reuses the taskId as the
    // run id) hits this path a second time with the identical key.
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    const answer = {
      role: "assistant",
      content: "I've set that up.",
      agent_id: "naelao-agent",
      client_message_id: "run:task-abc",
    };

    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", answer);
    const replay = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", answer);

    expect(replay.json.deduplicated).toBe(true);
    expect(await contents(doInstance, sessionId)).toEqual(["I've set that up."]);
  });

  it("the deduplicated response still carries the fields the client renders a bubble from", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    const answer = { role: "assistant", content: "done", agent_id: "support-agent", client_message_id: "run:r1" };

    const first = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", answer);
    const retry = await call(doInstance, `/sessions/${sessionId}/messages`, "POST", answer);

    // A retry that resolved to an existing row must not hand back a half-populated message, or
    // the client renders an anonymous bubble for a reply that has a real author.
    expect(retry.json.author_type).toBe(first.json.author_type);
    expect(retry.json.author_id).toBe("support-agent");
    expect(retry.json.created_at).toBe(first.json.created_at);
    expect(retry.json.role).toBe("assistant");
  });
});
