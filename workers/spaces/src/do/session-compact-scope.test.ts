import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";

function fixture() {
  const session = { id: "session-1", space_id: "space-1", tenant_id: "tenant-1", end_user_id: "customer-1",
    status: "active", metadata: "{}", created_at: "now", updated_at: "now" };
  const sql = { exec(query: string, ...args: unknown[]) {
    if (query.includes("FROM sessions WHERE id")) return { toArray: () => args[0] === session.id ? [session] : [] };
    if (query.includes("SELECT project_id, thread_tier, created_by FROM threads WHERE session_id"))
      return { toArray: () => args[0] === session.id ? [{ project_id: "project-1", thread_tier: "tier_2_task", created_by: null }] : [] };
    if (query.includes("SELECT created_by FROM threads WHERE session_id")) return { toArray: () => [] };
    return { toArray: () => [], rowsWritten: 1 };
  } };
  const object = new SpaceDO({ storage: { sql, transactionSync: (fn: () => unknown) => fn(), setAlarm: async () => undefined } } as never,
    { PLATFORM_SECRET: "test-secret" } as never);
  return { object, session };
}

describe("session compaction scope", () => {
  it("returns the canonical linked project without exposing session ownership", async () => {
    const { object } = fixture();
    const response = await object.fetch(new Request("https://space/sessions/session-1/compact-scope", {
      headers: { "x-naelao-user-id": "builder-1" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project_id: "project-1", private_scratchpad: false });
  });

  it("reports ownership only for a matching end-user identity and hides another customer's session", async () => {
    const { object } = fixture();
    const own = await object.fetch(new Request("https://space/sessions/session-1/compact-scope?end_user_id=customer-1", {
      headers: { "x-naelao-user-id": "customer-1" },
    }));
    expect(await own.json()).toMatchObject({ project_id: "project-1", owned_by_caller: true });
    const other = await object.fetch(new Request("https://space/sessions/session-1/compact-scope?end_user_id=customer-2"));
    expect(other.status).toBe(404);
  });
});
