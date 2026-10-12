import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";

describe("pull request review status transitions", () => {
  it("resolves once, replays the same decision idempotently, and rejects a competing decision", async () => {
    let status = "open";
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.startsWith("SELECT status FROM pull_request_cards")) return { toArray: () => [{ status }] };
      if (query.startsWith("UPDATE pull_request_cards")) {
        if (status !== "open") return { toArray: () => [] };
        status = String(args[0]);
        return { toArray: () => [{ status }] };
      }
      return { toArray: () => [], rowsWritten: 1 };
    } };
    const space = new SpaceDO({ storage: { sql, transactionSync: (fn: () => unknown) => fn(), deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, {} as never);
    const decide = (nextStatus: string) => space.fetch(new Request("https://space/pull-request-cards/pr-1/status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space-1", project_id: "project-1", status: nextStatus }),
    }));

    expect(await (await decide("merged")).json()).toEqual({ id: "pr-1", status: "merged" });
    expect(await (await decide("merged")).json()).toEqual({ id: "pr-1", status: "merged" });
    const conflict = await decide("rejected");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error_code: "review_card_already_resolved", status: "merged" });
  });
});
