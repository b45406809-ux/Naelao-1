import { describe, expect, it, vi } from "vitest";
import { runScheduledWebsiteRefreshes } from "./website-refresh-scheduler.js";

const now = new Date("2026-11-16T12:00:00.000Z");
const candidate = {
  schedule_id: "schedule-1", tenant_id: "tenant-1", space_id: "space-1", project_id: "project-1",
  document_id: "doc-1", connection_ref: "connection-1", owner_user_id: "owner-1", enabled: 1,
  interval_hours: 24 as const, generation: 3, due_at: "2026-11-10T12:00:00.000Z", failure_count: 0,
  lease_expires_at: null, document_status: "indexed", source_adapter: "website", source_state: "current",
  source_revision: 7, source_url: "https://docs.example/current", source_requested_url: "https://docs.example/current",
  source_content_sha256: "a".repeat(64), title: "Current docs", document_connection_ref: "connection-1",
  connection_status: "active", connection_owner_user_id: "owner-1", project_role_rank: 50,
};
const preview = { content: "Updated page text", requested_url: "https://docs.example/current",
  final_url: "https://docs.example/current", preview_sha256: "b".repeat(64), preview_token: "signed-preview",
  refresh_operation_id: "refresh-op-1", expected_source_revision: 7 };

function fixture(options: { claimChanges?: number; failureChanges?: number; connectionStatus?: string } = {}) {
  const sqlCalls: Array<{ sql: string; args: unknown[] }> = [];
  const analytics = { writeDataPoint: vi.fn() };
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => {
        sqlCalls.push({ sql, args });
        return {
          sql,
          all: async () => {
            if (sql.includes("kb_website_refresh_usage_outbox")) return { results: [] };
            return { results: [{ ...candidate, connection_status: options.connectionStatus ?? candidate.connection_status }] };
          },
          run: async () => {
            if (sql.includes("SET lease_token=?")) return { meta: { changes: options.claimChanges ?? 1 } };
            if (sql.includes("SET enabled=0,generation=generation+1")) return { meta: { changes: 1 } };
            return { meta: { changes: options.failureChanges ?? 1 } };
          },
        };
      },
    })),
    batch: vi.fn(async (statements: Array<{ sql: string }>) => statements.map((statement) => ({
      meta: { changes: statement.sql.includes("UPDATE kb_source_refresh_schedules SET lease_token=?")
        ? options.claimChanges ?? 1 : 1 },
    }))),
  };
  return { env: { PLATFORM_DB: db, PLATFORM_SECRET: "secret", KNOWLEDGE_ANALYTICS: analytics,
    KNOWLEDGE_WEBSITE_REFRESH_SCHEDULE_ENABLED: "true" } as never, db, sqlCalls, analytics };
}

describe("scheduled website refresh", () => {
  it("keeps the feature rollout disabled by pausing stored schedules before any fetch", async () => {
    const f = fixture();
    (f.env as { KNOWLEDGE_WEBSITE_REFRESH_SCHEDULE_ENABLED?: string }).KNOWLEDGE_WEBSITE_REFRESH_SCHEDULE_ENABLED = "false";
    const fetchInternal = vi.fn();
    const result = await runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now);
    expect(result.selected).toBe(0);
    expect(fetchInternal).not.toHaveBeenCalled();
    expect(f.sqlCalls.some((call) => call.sql.includes("last_error_code='schedule_rollout_disabled'"))).toBe(true);
    expect(f.analytics.writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      blobs: ["website_refresh", "scheduled", "disabled"], doubles: [0, 0, 0, 0, 0, expect.any(Number)], indexes: [],
    }));
  });

  it("catches up a missed daily tick once and binds publication to its lease", async () => {
    const f = fixture();
    const requests: Request[] = [];
    const fetchInternal = vi.fn(async (request: Request) => {
      requests.push(request);
      return request.method === "POST"
        ? Response.json({ preview })
        : Response.json({ id: "doc-1", status: "indexed" });
    });
    const result = await runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now);
    expect(result).toMatchObject({ selected: 1, claimed: 1, completed: 1, failed: 0 });
    const dueQuery = f.sqlCalls.find((call) => call.sql.includes("rs.next_run_at<=?"));
    expect(dueQuery?.args).toEqual([now.toISOString(), now.toISOString()]);
    expect(requests).toHaveLength(2);
    expect(f.sqlCalls.some((call) => call.sql.includes("kb_website_refresh_usage_outbox"))).toBe(true);
    const payload = await requests[1]!.clone().json() as { scheduled_refresh: { schedule_id: string; generation: number; lease_token: string } };
    expect(payload.scheduled_refresh).toMatchObject({ schedule_id: "schedule-1", generation: 3, lease_token: expect.any(String) });
    expect(payload.scheduled_refresh.lease_token.length).toBeGreaterThan(20);
    const metric = f.analytics.writeDataPoint.mock.calls[0]?.[0] as { blobs: string[]; doubles: number[] };
    expect(metric.blobs).toEqual(["website_refresh", "scheduled", "enabled"]);
    expect(JSON.stringify(metric)).not.toContain("tenant-1");
    expect(metric.doubles.slice(0, 5)).toEqual([1, 1, 1, 0, 0]);
  });

  it("keeps scheduled refresh execution working when Analytics Engine throws", async () => {
    const f = fixture();
    f.analytics.writeDataPoint.mockImplementation(() => { throw new Error("analytics unavailable"); });
    const fetchInternal = vi.fn(async (request: Request) => request.method === "POST"
      ? Response.json({ preview }) : Response.json({ id: "doc-1", status: "indexed" }));
    await expect(runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now))
      .resolves.toMatchObject({ completed: 1, failed: 0 });
  });

  it("does not issue duplicate work when a concurrent scheduler loses the lease claim", async () => {
    const f = fixture({ claimChanges: 0 });
    const fetchInternal = vi.fn();
    const result = await runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now);
    expect(result).toMatchObject({ selected: 1, claimed: 0, completed: 0 });
    expect(fetchInternal).not.toHaveBeenCalled();
  });

  it("pauses a due schedule after website grant revocation without fetching the page", async () => {
    const f = fixture({ connectionStatus: "revoked" });
    const fetchInternal = vi.fn();
    const result = await runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now);
    expect(result).toMatchObject({ selected: 1, paused: 1, claimed: 0 });
    expect(fetchInternal).not.toHaveBeenCalled();
    const pause = f.sqlCalls.find((call) => call.sql.includes("SET enabled=0,generation=generation+1"));
    expect(pause?.sql).toContain("last_error_code=?");
    expect(pause?.args).toContain("website_connection_revoked");
  });

  it("keeps stale or paused scheduled completion from being recorded as success", async () => {
    const f = fixture({ failureChanges: 0 });
    const requests: Request[] = [];
    const fetchInternal = vi.fn(async (request: Request) => {
      requests.push(request);
      return request.method === "POST" ? Response.json({ preview })
        : Response.json({ error_code: "website_refresh_schedule_changed" }, { status: 409 });
    });
    const result = await runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now);
    expect(result.completed).toBe(0);
    expect(requests).toHaveLength(2);
    expect(f.sqlCalls.at(-1)?.sql).toContain("enabled=1 AND generation=? AND lease_token=?");
    expect(f.sqlCalls.at(-1)?.args[1]).toBe("website_refresh_schedule_changed");
  });

  it("uses the exact original due event to derive a stable idempotency key for missed-tick recovery", async () => {
    const keys: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      const f = fixture();
      const fetchInternal = vi.fn(async (request: Request) => {
        if (request.method === "POST") {
          const payload = await request.clone().json() as { idempotency_key: string };
          keys.push(payload.idempotency_key);
          return Response.json({ error_code: "website_refresh_in_progress" }, { status: 409 });
        }
        return Response.json({});
      });
      await runScheduledWebsiteRefreshes(f.env, fetchInternal as never, {} as ExecutionContext, now);
    }
    expect(keys[0]).toBe(keys[1]);
  });
});
