import { describe, expect, it, vi } from "vitest";
import worker from "./index";

function triggerDb() {
  const statements: string[] = [];
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql);
      return {
        all: async () => ({ results: [{
          id: "trigger-1", tenant_id: "tenant-1", space_id: "space-1", project_id: "project-1",
          name: "daily", trigger_type: "schedule", cron_expr: "* * * * *", message_template: "run",
        }] }),
        bind: (..._values: unknown[]) => ({
          all: async () => ({ results: [{
            id: "trigger-1", tenant_id: "tenant-1", space_id: "space-1", project_id: "project-1",
            name: "daily", trigger_type: "schedule", cron_expr: "* * * * *", message_template: "run",
          }] }),
          run,
        }),
      };
    }),
  };
  return { db, statements, run };
}

describe("scheduled triggers", () => {
  it("selects only active tenant Spaces and leaves failed runs due for retry", async () => {
    const { db, statements, run } = triggerDb();
    const fetch = vi.fn(async () => new Response("suspended", { status: 403 }));
    let scheduledWork: Promise<unknown> | undefined;
    const ctx = { waitUntil: (work: Promise<unknown>) => { scheduledWork = work; } } as ExecutionContext;

    await worker.scheduled?.({} as ScheduledController, {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: db as unknown as D1Database,
      AGENTS_WORKER: { fetch } as unknown as Fetcher,
      SESSIONS_QUEUE: { send: vi.fn() } as unknown as Queue,
    } as never, ctx);
    await scheduledWork;

    expect(statements[0]).toContain("JOIN spaces s");
    expect(statements[0]).toContain("s.status = 'active'");
    expect(statements[0]).toContain("o.status = 'active'");
    expect(fetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});
