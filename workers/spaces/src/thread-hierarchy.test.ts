import { describe, expect, it } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";

type ThreadRow = Record<string, unknown>;

function makeThreadJourney() {
  const project = { id: "project-1", space_id: "space-1", status: "active", visibility: "public", show_sub_threads: 0, max_threads: 0 };
  const threads = new Map<string, ThreadRow>();
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const lower = query.toLowerCase();
      const byId = (id: unknown) => {
        const row = threads.get(String(id));
        return { toArray: () => (row ? [row] : []) };
      };
      if (lower.includes("from projects where id = ?")) return { toArray: () => [project] };
      if (lower.includes("select id from threads where id = ?")) return byId(args[0]);
      if (lower.includes("select space_id, project_id, status from threads where id = ?")) return byId(args[0]);
      if (lower.includes("select * from threads where id = ?")) return byId(args[0]);
      if (lower.includes("select max_threads from projects")) return { toArray: () => [{ max_threads: 0 }] };
      if (lower.includes("select count(*) as n from threads")) return { toArray: () => [{ n: [...threads.values()].filter((row) => row.status === "active").length }] };
      if (lower.includes("select id from threads where project_id = ? and thread_tier = 'tier_1_team'")) {
        const row = [...threads.values()].find((item) => item.project_id === args[0] && item.thread_tier === "tier_1_team" && item.status === "active");
        return { toArray: () => (row ? [{ id: row.id }] : []) };
      }
      if (lower.includes("insert into threads")) {
        const [id, space_id, user_id, project_id, title, parent_thread_id, thread_kind, channel, channel_session_id, session_id, created_at, updated_at, thread_tier, created_by, system_internal] = args;
        threads.set(String(id), { id, space_id, user_id, project_id, title, status: "active", parent_thread_id, thread_kind, channel, channel_session_id, session_id, created_at, updated_at, thread_tier, created_by, system_internal });
        return { rowsWritten: 1, toArray: () => [] };
      }
      if (lower.includes("select * from threads where")) {
        const rows = [...threads.values()].filter((row) => {
          if (row.space_id !== args[0]) return false;
          if (lower.includes("project_id = ?") && row.project_id !== args[1]) return false;
          if (lower.includes("thread_kind = 'primary'") && row.thread_kind !== "primary") return false;
          if (lower.includes("system_internal = 0") && row.system_internal !== 0) return false;
          if (lower.includes("thread_tier != 'tier_4_scratchpad'") && row.thread_tier === "tier_4_scratchpad" && row.created_by !== args[args.length - 1]) return false;
          return true;
        });
        return { toArray: () => rows };
      }
      return { rowsWritten: 1, toArray: () => [] };
    },
  };
  const instance = new SpaceDO({
    storage: { sql, transactionSync: (fn: () => unknown) => fn(), deleteAlarm: async () => undefined, setAlarm: async () => undefined },
  } as never, { PLATFORM_SECRET: "secret" } as never);
  return { instance, threads };
}

describe("four-tier thread persistence and visibility", () => {
  it("keeps consult lanes hidden by default while preserving all four tiers in the project tree", async () => {
    const h = makeThreadJourney();
    const create = async (body: Record<string, unknown>) => {
      const response = await h.instance.fetch(new Request("https://space/threads", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: "space-1", project_id: "project-1", ...body }),
      }));
      expect(response.status).toBe(201);
      return response.json() as Promise<ThreadRow>;
    };
    const team = await create({ id: "team", title: "Team room", thread_tier: "tier_1_team" });
    await create({ id: "task", title: "Task workstation", thread_tier: "tier_2_task" });
    await create({ id: "consult", title: "Consult lane", thread_kind: "sub_agent", thread_tier: "tier_3_consult", parent_thread_id: "task" });
    await create({ id: "scratch", title: "Private scratchpad", thread_tier: "tier_4_scratchpad", created_by: "user-1" });

    const normal = await h.instance.fetch(new Request("https://space/threads?space_id=space-1&project_id=project-1&viewer_id=user-1"));
    const normalIds = ((await normal.json()) as { data: ThreadRow[] }).data.map((row) => row.id);
    expect(normalIds).toEqual(expect.arrayContaining(["team", "task", "scratch"]));
    expect(normalIds).not.toContain("consult");

    const expanded = await h.instance.fetch(new Request("https://space/threads?space_id=space-1&project_id=project-1&viewer_id=user-1&include_sub_threads=true&include_system=true"));
    const expandedRows = ((await expanded.json()) as { data: ThreadRow[] }).data;
    expect(expandedRows.map((row) => row.id)).toEqual(expect.arrayContaining(["team", "task", "consult", "scratch"]));
    expect(expandedRows.find((row) => row.id === "consult")).toMatchObject({ parent_thread_id: "task", thread_tier: "tier_3_consult", system_internal: 1 });
    expect(team).toMatchObject({ thread_tier: "tier_1_team" });
  });
});
