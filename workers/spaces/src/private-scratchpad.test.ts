import { describe, expect, it } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";
import { createScratchpadKey, sealScratchpad } from "@naelao/agent-sdk";
function fixture() {
  const writes: unknown[][] = [];
  const session = { id: "private-session", space_id: "space", end_user_id: "owner", metadata: "{}", status: "active" };
  const sql = { exec(query: string, ...args: unknown[]) {
    if (query.startsWith("SELECT created_by FROM threads WHERE session_id")) return { toArray: () => args[0] === session.id ? [{ created_by: "owner" }] : [] };
    if (query.includes("FROM sessions WHERE id")) return { toArray: () => args[0] === session.id ? [session] : [] };
    if (query.includes("INSERT INTO messages")) writes.push(args);
    return { toArray: () => [], rowsWritten: 1 };
  } };
  const object = new SpaceDO({ storage: { sql, transactionSync: (fn: () => unknown) => fn(), setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "test-secret" } as never);
  const request = (path: string, user: string, content?: string) => new Request(`https://space/sessions/private-session${path}`, {
    method: content === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-naelao-user-id": user },
    ...(content === undefined ? {} : { body: JSON.stringify({ role: "user", content }) }),
  });
  return { object, request, writes };
}
describe("private session storage boundary", () => {
  it("hides the session and messages from other members and from unowned worker reads", async () => {
    const f = fixture();
    for (const user of ["other", ""]) {
      expect((await f.object.fetch(f.request("", user))).status).toBe(404);
      expect((await f.object.fetch(f.request("/messages", user))).status).toBe(404);
    }
    const response = await f.object.fetch(f.request("", "owner"));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ private_scratchpad: true });
  });
  it("rejects plaintext and stores only the browser ciphertext", async () => {
    const f = fixture();
    expect((await f.object.fetch(f.request("/messages", "owner", "confidential note"))).status).toBe(400);
    expect(f.writes).toHaveLength(0);
    const ciphertext = await sealScratchpad("confidential note", await createScratchpadKey(), "private-session");
    const response = await f.object.fetch(f.request("/messages", "owner", ciphertext));
    expect(response.status, await response.clone().text()).toBe(201);
    expect(JSON.stringify(f.writes)).toContain("naelao-scratchpad:v1:");
    expect(JSON.stringify(f.writes)).not.toContain("confidential note");
    expect((await f.object.fetch(f.request("/messages", "other", ciphertext))).status).toBe(404);
  });
});
