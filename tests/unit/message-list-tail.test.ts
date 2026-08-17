import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// "sessions with too much messages are now running successful then when reload that added user and
// assistant reply messages are gone it's like the conversation will never continue from there"
//
// Reproduced live against production before this fix: a session with 55 messages returned exactly
// messages 1-50 on reload. Root cause was the no-cursor branch of getMessages —
// `ORDER BY created_at ASC ... LIMIT 50` returns the OLDEST page, so once a conversation passes the
// limit every new turn becomes invisible to a reload. apps/shell's getMessages sends no `limit` and
// no `before`, so that branch is the only one any real client ever takes.
//
// A chat transcript loads from the END. The fix reads the newest page (DESC) and reverses it back to
// chronological order, so the response shape the client renders is unchanged — it is the same
// ascending array, just of the right messages.

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

async function seedMessages(doInstance: SpaceDO, sessionId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await call(doInstance, `/sessions/${sessionId}/messages`, "POST", {
      role: i % 2 === 1 ? "user" : "assistant",
      content: `msg-${i}`,
      client_message_id: `seq-${i}`,
    });
  }
}

function contentsOf(json: any): string[] {
  return (json.data as Array<{ content: string }>).map((m) => m.content);
}

describe("GET /messages returns the TAIL of a long transcript, not the head", () => {
  it("a 55-message session reloads to the NEWEST 50, ending at the latest message", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 55);

    // Exactly what apps/shell sends on mount: no limit, no cursor.
    const list = await call(doInstance, `/sessions/${sessionId}/messages`, "GET");
    const got = contentsOf(list.json);

    expect(got).toHaveLength(50);
    // The bug returned msg-1..msg-50 here; the newest turn must be present or the conversation
    // cannot continue.
    expect(got[got.length - 1]).toBe("msg-55");
    expect(got[0]).toBe("msg-6");
  });

  it("still reads in chronological order, so the client renders it unchanged", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 60);

    const got = contentsOf((await call(doInstance, `/sessions/${sessionId}/messages`, "GET")).json);
    const numbers = got.map((c) => Number(c.replace("msg-", "")));
    const ascending = [...numbers].sort((a, b) => a - b);
    expect(numbers).toEqual(ascending);
  });

  it("a session shorter than the limit is unaffected — every message, oldest first", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 5);

    expect(contentsOf((await call(doInstance, `/sessions/${sessionId}/messages`, "GET")).json)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
      "msg-5",
    ]);
  });

  it("an explicit limit takes the newest N, so a client can ask for a shorter tail", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 20);

    const got = contentsOf((await call(doInstance, `/sessions/${sessionId}/messages?limit=3`, "GET")).json);
    expect(got).toEqual(["msg-18", "msg-19", "msg-20"]);
  });

  it("the `before_id` cursor pages BACKWARDS with no gap, even when messages share a millisecond", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 20);

    const tail = (await call(doInstance, `/sessions/${sessionId}/messages?limit=5`, "GET")).json;
    const oldestShown = tail.data[0] as { id: string; content: string };
    expect(oldestShown.content).toBe("msg-16");

    const older = (
      await call(doInstance, `/sessions/${sessionId}/messages?limit=5&before_id=${oldestShown.id}`, "GET")
    ).json;
    const olderContents = contentsOf(older);

    // Contiguous with the tail page: a client can concatenate [older, ...tail] and get a correct
    // transcript with nothing skipped. A created_at cursor cannot promise this — these 20 messages
    // are written fast enough to share timestamps, and `created_at < cursor` drops every message in
    // the cursor's own millisecond.
    expect(olderContents).toEqual(["msg-11", "msg-12", "msg-13", "msg-14", "msg-15"]);
  });

  it("an unknown `before_id` reads as no cursor rather than silently returning nothing", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 4);

    const got = contentsOf(
      (await call(doInstance, `/sessions/${sessionId}/messages?before_id=not-a-real-id`, "GET")).json
    );
    expect(got).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
  });

  it("the legacy `before` timestamp cursor still pages backwards for any existing caller", async () => {
    const doInstance = makeSpaceDO();
    const sessionId = await seedSession(doInstance);
    await seedMessages(doInstance, sessionId, 20);

    const tail = (await call(doInstance, `/sessions/${sessionId}/messages?limit=5`, "GET")).json;
    const oldestShown = tail.data[0] as { created_at: string };

    const olderContents = contentsOf(
      (
        await call(
          doInstance,
          `/sessions/${sessionId}/messages?limit=5&before=${encodeURIComponent(oldestShown.created_at)}`,
          "GET"
        )
      ).json
    );

    // Everything returned is genuinely older, and still ascending. Exact contiguity is NOT asserted:
    // that is the millisecond-collision weakness `before_id` exists to solve.
    const numbers = olderContents.map((c) => Number(c.replace("msg-", "")));
    expect(numbers.every((n) => n < 16)).toBe(true);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });
});
