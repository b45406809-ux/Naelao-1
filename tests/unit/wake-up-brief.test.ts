import { describe, it, expect, vi } from "vitest";
import { handleAgentTick } from "../../workers/agents/src/index.js";

// The brief a scheduled/polled wake-up carries. The assistant CAN call diagnostics.overview
// itself, but on a small model "check your diagnostics first" in a system prompt is a suggestion
// that costs a tool call, and suggestions like that get skipped. Putting the two or three lines
// that matter into the goal makes the situation unmissable.
//
// Driven through the REAL handleAgentTick dispatch rather than by calling the helper directly:
// the thing worth protecting is that a scheduled job actually receives the brief, and that a
// diagnostics failure can never stop the scheduled work from running.

interface Captured { goal: string; context?: Record<string, unknown> }

function makeEnv(opts: {
  diagnostics?: unknown;
  diagnosticsStatus?: number;
  diagnosticsThrows?: boolean;
  captured: Captured[];
  /** Rows POSTed to agent-activity — how a failed background wake-up becomes visible at all. */
  activity?: Array<Record<string, unknown>>;
  /** Make the DO reject the tick, to exercise the failure path. */
  doStatus?: number;
  doBody?: string;
  jobHasGoal?: boolean;
}) {
  const jobRow = {
    id: "job-1", space_id: "space-1", tenant_id: "tenant-1", project_id: null,
    cron_expression: "* * * * *", script_name: "", params: "{}",
    agent_id: "naelao-agent", goal: "Review active work and report anything that needs attention.",
    last_run_at: null, created_at: Date.now() - 86_400_000, consecutive_failures: 0,
  };

  return {
    PLATFORM_SECRET: "test-secret",
    PLATFORM_DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.includes("INSERT INTO scheduled_job_dispatches")) return { claim_token: "claim-1" };
            if (sql.includes("FROM scheduled_jobs")) return jobRow;
            if (sql.includes("FROM spaces")) return { id: "space-1", status: "active" };
            return null;
          },
          all: async () => ({ results: sql.includes("FROM channel_links") ? [{ channel: "whatsapp", model_override: null }] : [] }),
          run: async () => ({ success: true }),
        }),
      }),
    },
    SPACES_WORKER: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/sessions") && req.method === "POST") return Response.json({ id: "heartbeat-1" }, { status: 201 });
          if (path === "/active-run") return Response.json({ active: false });
          if (path === "/memory/maintenance") return Response.json({ ok: true });
          if (path === "/channels/heartbeat") {
            if (opts.doStatus && opts.doStatus >= 400) return new Response(opts.doBody ?? "boom", { status: opts.doStatus });
            return Response.json({ ok: true });
          }
        if (path.includes("/agent-diagnostics")) {
          if (opts.diagnosticsThrows) throw new Error("spaces worker unreachable");
          return new Response(JSON.stringify(opts.diagnostics ?? {}), {
            status: opts.diagnosticsStatus ?? 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (path.includes("/agent-activity")) {
          opts.activity?.push(await req.json<Record<string, unknown>>());
          return new Response(JSON.stringify({ ok: true }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      },
    },
    NAELAO_AGENT_DO: {
      idFromName: () => ({ toString: () => "do-id" }),
      get: () => ({
        fetch: async (req: Request) => {
          const body = await req.json<Captured>();
          opts.captured.push(body);
          if (opts.doStatus && opts.doStatus >= 400) {
            return new Response(opts.doBody ?? "boom", { status: opts.doStatus });
          }
          return new Response(JSON.stringify({ result: { ok: true, output: { done: true } } }), { status: 200 });
        },
      }),
    },
    AGENT_CACHE: { get: async () => null, put: async () => undefined },
  } as never;
}

const CLEAN = {
  runs: { total: 5, completed: 5, failed: 0 },
  failures_by_kind: [],
  approvals: { outstanding: 0 },
  notifications: { unread_critical: 0 },
  recent_stalls: [],
};

const TROUBLE = {
  runs: { total: 6, completed: 2, failed: 4 },
  failures_by_kind: [{ kind: "quota_exhausted", count: 3 }, { kind: "tool_error", count: 1 }],
  approvals: { outstanding: 2 },
  notifications: { unread_critical: 1 },
  recent_stalls: [
    { project_name: "Lead Generation", failure_kind: "quota_exhausted", summary: "4006 neuron allocation exceeded" },
  ],
};

describe("wake-up brief", () => {
  it("gives a healthy Space's background session a useful next step", async () => {
    // Load-bearing: a brief on every hourly tick would spend real tokens saying "everything is
    // fine", on an account whose entire budget is a few dozen runs a day.
    const captured: Captured[] = [];
    await handleAgentTick(makeEnv({ diagnostics: CLEAN, captured }), {
      kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1",
    } as never);

    expect(captured).toHaveLength(1);
    const goal = captured[0]!.goal;
    // The scheduled work itself is untouched.
    expect(goal).toContain("Review active work and report anything that needs attention.");
    expect(goal).toContain("choose one useful next step");
    expect(goal).toContain("configured tools, permissions, budget, and approval policy");
    expect(goal).toContain("concrete proposal");
    expect(goal).not.toContain("business");
    // Nothing was wrong, so it should not claim otherwise.
    expect(goal).not.toContain("Since your last wake-up");
  });

  it("puts what went wrong in front of the goal when there is something to say", async () => {
    const captured: Captured[] = [];
    await handleAgentTick(makeEnv({ diagnostics: TROUBLE, captured }), {
      kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1",
    } as never);

    const goal = captured[0]!.goal;
    expect(goal).toContain("Since your last wake-up");
    expect(goal).toContain("4 of 6 runs failed");
    expect(goal).toContain("quota_exhausted");
    // The interpretation, not just the label — this is what tells it not to rebuild anything.
    expect(goal).toContain("resets on its own");
    expect(goal).toContain("2 approval(s) are still waiting");
    expect(goal).toContain("1 critical notification");
    expect(goal).toContain("Lead Generation");
    // And the original work still has to be there, after the brief.
    expect(goal).toContain("Review active work and report anything that needs attention.");
    expect(goal.indexOf("Since your last wake-up")).toBeLessThan(goal.indexOf("Review active work"));
  });

  it("tells it not to restart work that already partly succeeded", async () => {
    // The failure mode this whole feature exists to prevent: a fresh run gets a fresh ledger key
    // and redoes everything, which is how a retry created a second project.
    const captured: Captured[] = [];
    await handleAgentTick(makeEnv({ diagnostics: TROUBLE, captured }), {
      kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1",
    } as never);
    expect(captured[0]!.goal).toContain("don't restart work that already partly succeeded");
  });

  it("still runs the scheduled work when diagnostics are unavailable", async () => {
    for (const broken of [{ diagnosticsStatus: 500 }, { diagnosticsThrows: true }]) {
      const captured: Captured[] = [];
      await handleAgentTick(makeEnv({ diagnostics: TROUBLE, captured, ...broken }), {
        kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1",
      } as never);
      // Never a skipped job, and never a silently-dropped instruction: the diagnostics half of
      // the brief needs a working lookup, but "advance the business" needs nothing at all, so it
      // survives the lookup failing.
      expect(captured).toHaveLength(1);
      expect(captured[0]!.goal).toContain("Review active work and report anything that needs attention.");
      expect(captured[0]!.goal).toContain("choose one useful next step");
      // With no diagnostics it must not invent a situation report.
      expect(captured[0]!.goal).not.toContain("Since your last wake-up");
    }
  });

  it("carries the trigger through so the failure can be attributed to a background wake-up", async () => {
    const captured: Captured[] = [];
    await handleAgentTick(makeEnv({ diagnostics: CLEAN, captured }), {
      kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1",
    } as never);
    expect(captured[0]!.context?.["trigger"]).toBe("scheduled_job");
  });

  it("records a heartbeat that never got off the ground, classified", async () => {
    // The gap this closes: a heartbeat's response used to be discarded, and the drain runs
    // entirely inside the DO, so a tick that died left no trace anywhere. A background loop could
    // be dead for days with nothing to show for it — to the owner or to the assistant.
    const captured: Captured[] = [];
    const activity: Array<Record<string, unknown>> = [];
    await handleAgentTick(
      makeEnv({ diagnostics: CLEAN, captured, activity, doStatus: 500, doBody: "4006: daily neuron allocation exceeded" }),
      { kind: "heartbeat", spaceId: "space-1", tenantId: "tenant-1" } as never
    );

    const row = activity.find((r) => r["trigger_source"] === "heartbeat");
    expect(row).toBeDefined();
    expect(row!["event_type"]).toBe("run_failed");
    // Classified, not raw — the rollup groups on this, and "quota" vs "tool error" is what
    // decides whether the assistant waits or investigates.
    expect(row!["failure_kind"]).toBe("quota_exhausted");
    expect(String(row!["summary"])).toContain("heartbeat wake-up failed");
  });

  it("records nothing extra when the heartbeat succeeds", async () => {
    const captured: Captured[] = [];
    const activity: Array<Record<string, unknown>> = [];
    await handleAgentTick(makeEnv({ diagnostics: CLEAN, captured, activity }), {
      kind: "heartbeat", spaceId: "space-1", tenantId: "tenant-1",
    } as never);
    expect(activity.filter((r) => r["event_type"] === "run_failed")).toHaveLength(0);
  });

  it("mirrors a failed scheduled job somewhere the assistant can see it", async () => {
    // consecutive_failures lives in D1 and is only ever read by the sweep itself, so a cron
    // failing every day was visible to nobody.
    const captured: Captured[] = [];
    const activity: Array<Record<string, unknown>> = [];
    await handleAgentTick(
      makeEnv({ diagnostics: CLEAN, captured, activity, doStatus: 503, doBody: "429 rate limited" }),
      { kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1" } as never
    );

    const row = activity.find((r) => r["trigger_source"] === "scheduled_job");
    expect(row).toBeDefined();
    expect(row!["failure_kind"]).toBe("rate_limited");
  });

  it("briefs a connector poll too, since it is the other unattended wake-up", async () => {
    const captured: Captured[] = [];
    await handleAgentTick(makeEnv({ diagnostics: TROUBLE, captured }), {
      kind: "connector_poll", spaceId: "space-1", tenantId: "tenant-1", connectorName: "whop",
    } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.goal).toContain("Since your last wake-up");
    expect(captured[0]!.goal).toContain("Poll the whop connector");
  });
});

describe("wake-up brief: generic Space boundary", () => {
  it("does not inject vertical onboarding or commerce assumptions", async () => {
    const captured: Captured[] = [];
    await handleAgentTick(makeEnv({ diagnostics: TROUBLE, captured }), {
      kind: "scheduled_job", spaceId: "space-1", tenantId: "tenant-1", jobId: "job-1",
    } as never);
    const goal = captured[0]!.goal;
    expect(goal).toContain("Since your last wake-up");
    expect(goal).toContain("Review active work and report anything that needs attention.");
    expect(goal).not.toContain("business");
    expect(goal).not.toContain("revenue");
  });
});
