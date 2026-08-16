import { describe, it, expect } from "vitest";
import { handleAgentTick } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// Phase 3 item 23/24 — "pending background run awareness" for a scheduled/cron wake. Every
// wake for a space (hourly tick, an @mention run, a channel drain) addresses the SAME
// `{spaceId}:agentId` NaelaoAgentDO instance, so a run still going when the NEXT tick fires
// would otherwise dispatch a SECOND, overlapping /script/run into that same instance. This
// drives handleAgentTick (the real dispatcher) against a DO stub that answers GET
// http://agent-do/active-run (the pre-fire check) and POST http://agent-do/script/run (the
// actual dispatch) DIFFERENTLY — the "always parse a JSON body" stubs elsewhere in this suite
// can't tell those apart, which is exactly why this is its own dedicated harness.

interface Update { id: string; last_run_at: number; consecutive_failures?: number; last_error?: string | null }

function makeEnv(opts: {
  assistantBusy?: boolean;
  activeRunThrows?: boolean;
  activeRunStatus?: number;
}): { env: AgentsEnv; calls: Array<{ url: string; method: string }>; updates: Update[] } {
  const jobRow = {
    id: "job-1", space_id: "space-1", tenant_id: "tenant-1", project_id: null,
    cron_expression: "0 13 * * *", script_name: "", params: "{}",
    agent_id: "naelao-agent", goal: "Review revenue and report anything that needs attention.",
    last_run_at: null, created_at: Date.now(), consecutive_failures: 0,
  };
  const calls: Array<{ url: string; method: string }> = [];
  const updates: Update[] = [];

  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (sql.includes("FROM scheduled_jobs")) return jobRow;
          return null;
        },
        async run() {
          if (/consecutive_failures = 0, last_error = NULL/.test(sql)) {
            updates.push({ id: args[1] as string, last_run_at: args[0] as number, consecutive_failures: 0, last_error: null });
          } else if (/consecutive_failures = \?, last_error = \?/.test(sql)) {
            updates.push({ id: args[4] as string, last_run_at: args[0] as number, consecutive_failures: args[1] as number, last_error: args[2] as string | null });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };

  const agentDoStub = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const url = req.url;
      const method = req.method || "GET";
      calls.push({ url, method });
      if (url.endsWith("/active-run")) {
        if (opts.activeRunThrows) throw new Error("DO unreachable");
        return new Response(
          JSON.stringify({ active: opts.assistantBusy ?? false, run_id: opts.assistantBusy ? "run-still-going" : undefined }),
          { status: opts.activeRunStatus ?? 200 }
        );
      }
      if (url.endsWith("/script/run")) {
        return new Response(JSON.stringify({ result: { ok: true, output: "done" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };

  const env = {
    PLATFORM_SECRET: "test-secret",
    PLATFORM_DB: db,
    NAELAO_AGENT_DO: { idFromName: (n: string) => ({ toString: () => n }), get: () => agentDoStub },
    SPACES_WORKER: { async fetch() { return new Response("{}", { status: 200 }); } },
    AGENT_CACHE: { async get() { return null; }, async put() {} },
    ANALYTICS: { writeDataPoint() {} },
  } as unknown as AgentsEnv;

  return { env, calls, updates };
}

describe("scheduled_job dispatch — pending-run awareness", () => {
  it("skips the tick and never dispatches /script/run when the assistant is already running", async () => {
    const { env, calls, updates } = makeEnv({ assistantBusy: true });
    await handleAgentTick(env, { kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1" } as never);

    expect(calls.some((c) => c.url.endsWith("/active-run"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/script/run"))).toBe(false);
    // Neither success nor failure is recorded — the row is left exactly as it was so the next
    // due tick retries against a (hopefully) free instance.
    expect(updates).toHaveLength(0);
  });

  it("dispatches normally when the assistant is free", async () => {
    const { env, calls, updates } = makeEnv({ assistantBusy: false });
    await handleAgentTick(env, { kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1" } as never);

    expect(calls.some((c) => c.url.endsWith("/script/run"))).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.consecutive_failures).toBe(0);
  });

  it("fails OPEN (dispatches normally) when the busy-check itself throws", async () => {
    const { env, calls } = makeEnv({ activeRunThrows: true });
    await handleAgentTick(env, { kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1" } as never);

    // A transient failure to CHECK must never block a wake that would otherwise run fine.
    expect(calls.some((c) => c.url.endsWith("/script/run"))).toBe(true);
  });

  it("fails OPEN when the busy-check returns a non-ok status", async () => {
    const { env, calls } = makeEnv({ activeRunStatus: 500 });
    await handleAgentTick(env, { kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1" } as never);

    expect(calls.some((c) => c.url.endsWith("/script/run"))).toBe(true);
  });
});
