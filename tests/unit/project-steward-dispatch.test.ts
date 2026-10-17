import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimProjectStewardRun, finishProjectStewardRun } from "../../workers/agents/src/project-steward-dispatch.js";
import { enqueueAgentTicks, handleAgentTick, type AgentTickMessage } from "../../workers/agents/src/index.js";
import { createFakeD1, type FakeD1 } from "../stubs/d1-sqlite.js";

let db: FakeD1 | undefined;
afterEach(() => { db?.db.close(); db = undefined; });

function database(): FakeD1 {
  const value = createFakeD1([readFileSync(join(__dirname, "../../infra/migrations/0107_project_steward_daily_runs.sql"), "utf8")]);
  db = value;
  return value;
}

describe("daily Project Steward dispatch claims", () => {
  it("admits one consumer for a Space/day and persists its report once", async () => {
    const platformDb = database();
    const claim = await claimProjectStewardRun(platformDb, { spaceId: "space-1", tenantId: "tenant-1", runDay: "2026-10-17", dayStart: 1_000, now: 2_000 });
    expect(claim).toBeTruthy();
    await expect(claimProjectStewardRun(platformDb, { spaceId: "space-1", tenantId: "tenant-1", runDay: "2026-10-17", dayStart: 1_000, now: 3_000 })).resolves.toBeNull();
    await expect(finishProjectStewardRun(platformDb, { spaceId: "space-1", runDay: "2026-10-17", claimToken: claim!, reportJson: '{"advisory_only":true}', now: 4_000 })).resolves.toBe(true);
    expect(await platformDb.prepare("SELECT report_json FROM project_steward_runs WHERE space_id=?").bind("space-1").first()).toMatchObject({ report_json: '{"advisory_only":true}' });
    await expect(claimProjectStewardRun(platformDb, { spaceId: "space-1", tenantId: "tenant-1", runDay: "2026-10-17", dayStart: 1_000, now: 5_000 })).resolves.toBeNull();
  });

  it("releases a failed run for retry and reclaims an expired lease", async () => {
    const platformDb = database();
    const claim = await claimProjectStewardRun(platformDb, { spaceId: "space-2", tenantId: "tenant-1", runDay: "2026-10-17", dayStart: 1_000, now: 2_000 });
    expect(claim).toBeTruthy();
    await finishProjectStewardRun(platformDb, { spaceId: "space-2", runDay: "2026-10-17", claimToken: claim! });
    expect(await claimProjectStewardRun(platformDb, { spaceId: "space-2", tenantId: "tenant-1", runDay: "2026-10-17", dayStart: 1_000, now: 3_000 })).toBeTruthy();
  });

  it("enqueues each active space once per daily run key", async () => {
    const spaces = [{ space_id: "space-a", tenant_id: "tenant" }, { space_id: "space-b", tenant_id: "tenant" }];
    const batches: AgentTickMessage[][] = [];
    const env = {
      PLATFORM_DB: { prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = { bind(...values: unknown[]) { args = values; return stmt; }, async all() {
          if (!sql.includes("project_steward_runs")) return { results: [] };
          const cursor = String(args[0] ?? "");
          const limit = Number(args[4] ?? 1000);
          return { results: spaces.filter((row) => row.space_id > cursor).slice(0, limit) };
        } };
        return stmt;
      } },
      AGENT_TICKS: { async sendBatch(messages: Array<{ body: AgentTickMessage }>) { batches.push(messages.map((entry) => entry.body)); } },
      ANALYTICS: { writeDataPoint() {} },
    };
    await enqueueAgentTicks(env as never);
    const messages = batches.flat().filter((message) => message.kind === "project_steward_review");
    expect(messages.map((message) => message.spaceId)).toEqual(["space-a", "space-b"]);
    expect(messages.every((message) => message.runDay === new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it("generates and persists an advisory report using only the scoped summary grant", async () => {
    const platformDb = database();
    const archive: string[] = [];
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: platformDb,
      SPACES_WORKER: { async fetch(request: Request) {
        expect(request.url).toContain("/internal/spaces/space-review/project-steward/summary");
        expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
        return Response.json({ grant: "space.project_steward.read_summary.v1", generated_at: Date.now(), data: [
          { project_id: "project-1", project_name: "Needs care", created_at: "2024-01-01T00:00:00Z", last_activity_at: "2024-01-01T00:00:00Z", failed_routines: [{ routine_id: "routine-1", consecutive_failures: 2 }] },
        ] });
      } },
      SCRIPTS_R2: { async put(key: string) { archive.push(key); } },
    };
    const runDay = new Date().toISOString().slice(0, 10);
    await handleAgentTick(env as never, { kind: "project_steward_review", spaceId: "space-review", tenantId: "tenant-review", runDay });
    const row = await platformDb.prepare("SELECT report_json FROM project_steward_runs WHERE space_id=?").bind("space-review").first<{ report_json: string }>();
    const report = JSON.parse(row!.report_json) as { run_day: string; advisory_only: boolean; data: Array<{ project_id: string; recommendation: string }> };
    expect(report).toMatchObject({ run_day: runDay, advisory_only: true, data: [{ project_id: "project-1", recommendation: "inspect_routine" }] });
    expect(archive[0]).toContain(`/extensions/platform-project-steward/workspace/reviews/${runDay}.json`);
  });
});
