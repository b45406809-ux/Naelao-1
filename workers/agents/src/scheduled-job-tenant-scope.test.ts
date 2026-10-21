import { describe, expect, it } from "vitest";
import { handleAgentTick } from "./index.js";

describe("scheduled job queue tenant scope", () => {
  it("binds a queued job ID to the validated tenant and Space before dispatch", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) { values.push(...args); return statement; },
          async first() {
            statements.push({ sql, values: [...values] });
            if (sql.includes("SELECT s.id FROM spaces s")) return { id: "space-a" };
            if (sql.includes("SELECT name, config_json FROM spaces")) return { name: "Space A", config_json: null };
            return null;
          },
          async all() { statements.push({ sql, values: [...values] }); return { results: [] }; },
          async run() { statements.push({ sql, values: [...values] }); return { success: true }; },
        };
        return statement;
      },
    };
    const env = {
      PLATFORM_SECRET: "scheduled-job-scope-test-secret",
      PLATFORM_DB: db,
    } as never;

    await handleAgentTick(env, {
      kind: "scheduled_job",
      jobId: "job-from-another-scope",
      spaceId: "space-a",
      tenantId: "tenant-a",
    });

    const jobLookup = statements.find(({ sql }) => sql.includes("FROM scheduled_jobs WHERE id = ?"));
    expect(jobLookup?.sql).toContain("space_id = ? AND tenant_id = ?");
    expect(jobLookup?.values).toEqual(["job-from-another-scope", "space-a", "tenant-a"]);
  });
});
