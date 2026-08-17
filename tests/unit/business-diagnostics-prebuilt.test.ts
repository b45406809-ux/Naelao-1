import { describe, it, expect } from "vitest";
import { businessDiagnostics } from "../../workers/agents/src/script-engine/prebuilt/business-diagnostics.js";

// The assistant's own view of the business. The rollup route is tested separately against real
// migrations; what matters here is the layer on top: turning numbers into the two or three
// sentences that change what the agent does next, and refusing to invent an answer when the
// data isn't there.

const OVERVIEW = {
  window_hours: 24,
  runs: { total: 6, completed: 2, failed: 4, error_rate: 0.667 },
  spend: { tokens_used: 9000, credits: 12 },
  approvals: { requested: 3, resolved: 1, outstanding: 2 },
  failures_by_kind: [{ kind: "quota_exhausted", count: 3 }, { kind: "tool_error", count: 1 }],
  wake_failures: [{ trigger: "heartbeat", failed_runs: 3 }],
  projects: [
    { project_id: "p1", name: "Lead Generation", completed: 0, failed: 3, tokens_used: 7000 },
    { project_id: "p2", name: "Development", completed: 2, failed: 1, tokens_used: 2000 },
  ],
  recent_stalls: [
    { project_name: "Lead Generation", failure_kind: "quota_exhausted", summary: "4006 neuron allocation", run_id: "r1", session_id: "s1" },
  ],
  notifications: { unread: 4, unread_critical: 1 },
};

function makeCtx(responses: Record<string, unknown>, calls: string[] = []) {
  return {
    env: {
      spaceId: "space-1",
      tenantId: "tenant-1",
      platformSecret: "test-secret",
      spacesWorker: {
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          calls.push(url.pathname + url.search);
          const key = Object.keys(responses).find((k) => url.pathname.includes(k));
          if (!key) return new Response("not found", { status: 404 });
          return new Response(JSON.stringify(responses[key]), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      },
    },
  } as never;
}

const ops = businessDiagnostics.operations;

describe("business-diagnostics prebuilt", () => {
  it("reads the situation rather than handing back a blob of numbers", async () => {
    const out = (await ops["diagnostics.overview"]!({}, makeCtx({ "/agent-diagnostics": OVERVIEW }))) as any;

    expect(out.assessment).toContain("2 of 6 runs finished");
    expect(out.assessment).toContain("quota_exhausted");

    const focus = out.suggested_focus.join(" | ");
    // The dominant failure clears by itself — so the guidance must be "resume later", never
    // "rebuild". Getting this backwards is what makes an agent burn the next quota window too.
    expect(focus).toContain("clears on its own");
    expect(focus).toContain("2 approval(s) still waiting");
    expect(focus).toContain("1 critical notification");
    // A project failing every run and completing none is the single most useful pointer here.
    expect(focus).toContain("Lead Generation");
    expect(focus).toContain("3 'heartbeat' wake-up(s) failed");
  });

  it("gives different guidance for a failure the agent can actually fix", async () => {
    const ctx = makeCtx({
      "/agent-diagnostics": { ...OVERVIEW, failures_by_kind: [{ kind: "context_overflow", count: 4 }] },
    });
    const out = (await ops["diagnostics.overview"]!({}, ctx)) as any;
    expect(out.suggested_focus.join(" | ")).toContain("you can fix yourself");
  });

  it("points at the owner for a failure that is genuinely theirs", async () => {
    const ctx = makeCtx({
      "/agent-diagnostics": { ...OVERVIEW, failures_by_kind: [{ kind: "budget_ceiling", count: 4 }] },
    });
    const out = (await ops["diagnostics.overview"]!({}, ctx)) as any;
    const focus = out.suggested_focus.join(" | ");
    expect(focus).toContain("needs the owner");
    expect(focus).toContain("rather than retrying");
  });

  it("says plainly that nothing ran, instead of implying success", async () => {
    const quiet = {
      ...OVERVIEW,
      runs: { total: 0, completed: 0, failed: 0, error_rate: 0 },
      failures_by_kind: [], wake_failures: [], recent_stalls: [], projects: [],
      approvals: { requested: 0, resolved: 0, outstanding: 0 },
      notifications: { unread: 2, unread_critical: 0 },
    };
    const out = (await ops["diagnostics.overview"]!({}, makeCtx({ "/agent-diagnostics": quiet }))) as any;
    expect(out.assessment).toContain("Nothing has run");
    expect(out.suggested_focus.join(" ")).toContain("unread notifications");
  });

  it("drills into one failure kind through the real filter the summary points at", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      "/agent-activity": {
        data: [{
          created_at: "2026-08-05 10:00:00", agent_id: "naelao-agent", project_id: "p1",
          session_id: "s1", run_id: "r1", trigger_source: "heartbeat",
          failure_kind: "quota_exhausted", summary: "4006", tokens_used: 900,
        }],
      },
    }, calls);

    const out = (await ops["diagnostics.failures"]!({ kind: "quota_exhausted" }, ctx)) as any;
    expect(calls[0]).toContain("failure_kind=quota_exhausted");
    expect(calls[0]).toContain("event_type=run_failed");

    const f = out.failures[0];
    // The ids are the point — without them "go and continue that work" isn't actionable.
    expect(f).toMatchObject({ session_id: "s1", run_id: "r1", woken_by: "heartbeat" });
    expect(f.clears_on_its_own).toBe(true);
    expect(f.you_can_fix_this).toBe(false);
    expect(f.what_it_means).toContain("resets on its own");
  });

  it("refuses an unknown failure kind and names the real ones", async () => {
    // Silently returning everything for a typo'd filter would read as "no failures of that kind",
    // which is the wrong answer to act on.
    await expect(
      ops["diagnostics.failures"]!({ kind: "made_up" }, makeCtx({ "/agent-activity": { data: [] } }))
    ).rejects.toThrow(/unknown failure kind.*quota_exhausted/s);
  });

  it("tells the agent to continue stalled work in its own thread, not start it again", async () => {
    const out = (await ops["diagnostics.stalled_work"]!({}, makeCtx({ "/agent-diagnostics": OVERVIEW }))) as any;
    expect(out.stalled[0].clears_on_its_own).toBe(true);
    expect(out.note).toContain("Don't start the same goal in a fresh thread");
  });

  it("separates hitting the model allowance from hitting a spend cap", async () => {
    const allowance = (await ops["diagnostics.limits"]!({}, makeCtx({ "/agent-diagnostics": OVERVIEW }))) as any;
    expect(allowance.hit_model_allowance).toBe(true);
    expect(allowance.hit_spend_cap).toBe(false);
    expect(allowance.guidance.join(" ")).toContain("resets on its own");

    const capped = (await ops["diagnostics.limits"]!({}, makeCtx({
      "/agent-diagnostics": { ...OVERVIEW, failures_by_kind: [{ kind: "budget_ceiling", count: 2 }] },
    }))) as any;
    expect(capped.hit_spend_cap).toBe(true);
    expect(capped.hit_model_allowance).toBe(false);
    expect(capped.guidance.join(" ")).toContain("owner's setting");
  });

  it("says stop and diagnose when more runs fail than succeed", async () => {
    const out = (await ops["diagnostics.limits"]!({}, makeCtx({ "/agent-diagnostics": OVERVIEW }))) as any;
    expect(out.guidance.join(" ")).toContain("Diagnose before doing more work");
  });

  it("clamps the window to something sane rather than trusting the model's number", async () => {
    const calls: string[] = [];
    await ops["diagnostics.overview"]!({ window_hours: 99999 }, makeCtx({ "/agent-diagnostics": OVERVIEW }, calls));
    expect(calls[0]).toContain("window_hours=720");

    calls.length = 0;
    await ops["diagnostics.overview"]!({ window_hours: "not a number" }, makeCtx({ "/agent-diagnostics": OVERVIEW }, calls));
    expect(calls[0]).toContain("window_hours=24");
  });

  it("is entirely read-only — every op only ever issues a GET", async () => {
    // Every op here is auto-approved under guided mode precisely because none of them can change
    // anything. If a write ever appears it should be a deliberate decision that fails this test
    // loudly, not a drift that silently widens what runs unapproved.
    const methods: string[] = [];
    const ctx = {
      env: {
        spaceId: "space-1", tenantId: "tenant-1", platformSecret: "test-secret",
        spacesWorker: {
          fetch: async (req: Request) => {
            methods.push(req.method);
            const body = new URL(req.url).pathname.includes("/agent-activity")
              ? { data: [] }
              : OVERVIEW;
            return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
          },
        },
      },
    } as never;

    for (const name of Object.keys(ops)) {
      await ops[name]!({}, ctx).catch(() => undefined);
    }
    expect(methods.length).toBe(Object.keys(ops).length);
    expect(methods.every((m) => m === "GET")).toBe(true);
  });
});
