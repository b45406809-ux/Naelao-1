/**
 * business-diagnostics — how the Space Assistant finds out what has been happening while it
 * wasn't looking, and what to do about it.
 *
 * The assistant is woken by a heartbeat, a cron, a channel message, a trigger. Each of those used
 * to arrive with no situational awareness at all: it knew its goal and nothing about the business
 * it was supposedly running. So a project could stall for a week and the assistant would cheerfully
 * report that everything was fine, because nothing had told it otherwise.
 *
 * The shape is deliberately summary-first. `overview` is one bounded rollup — counts, why runs
 * failed, which projects are burning tokens without finishing, which threads are stalled and can be
 * resumed. It is small enough to put in a wake-up brief on a cheap model. Everything else here is a
 * DRILL-DOWN the assistant calls only where the summary showed something worth looking at:
 * `failures` for the actual rows behind a count, `stalled_work` for what can be picked up again,
 * `limits` for whether it is about to run out of budget. That split is the whole point — an
 * assistant aware of everything at summary depth, able to go deeper anywhere, without paying for
 * the depth it doesn't need.
 *
 * All read-only. Everything here is already visible to the owner in the dashboard; this is the same
 * information reaching the agent that is meant to act on it.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";
import { classifyFailure, FAILURE_KINDS } from "@naelao/events";

async function spacesCall(ctx: PrebuiltOpContext, path: string): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("business-diagnostics unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
        // Deliberately NOT forwarding x-naelao-user-id here, unlike workspace-admin's spacesCall.
        // These routes refuse a product_end_user caller because they span every thread in the
        // business including other people's; the assistant reads them as the business's own agent,
        // which is exactly the posture agent-activity's writer already uses.
      },
    })
  );
  if (!resp.ok) throw new Error(`business-diagnostics GET ${path} failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

function windowHours(a: Record<string, unknown>, fallback = 24): number {
  const raw = Number(a["window_hours"] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.round(raw), 1), 24 * 30);
}

interface DiagnosticsOverview {
  window_hours: number;
  runs: { total: number; completed: number; failed: number; error_rate: number };
  spend: { tokens_used: number; credits: number };
  approvals: { requested: number; resolved: number; outstanding: number };
  failures_by_kind: Array<{ kind: string; count: number }>;
  wake_failures: Array<{ trigger: string; failed_runs: number }>;
  projects: Array<{ project_id: string | null; name: string | null; completed: number; failed: number; tokens_used: number }>;
  recent_stalls: Array<{ failure_kind: string; project_name: string | null; summary: string }>;
  notifications: { unread: number; unread_critical: number };
}

/**
 * Turn the rollup into the two or three sentences that actually change what the assistant does
 * next. A model handed a JSON blob will often summarise it back at the user instead of acting on
 * it; a model handed "your last 4 runs all hit the model allowance, which resets on its own" tends
 * to do the right thing.
 */
function readTheRoom(d: DiagnosticsOverview): { headline: string; suggested_focus: string[] } {
  const focus: string[] = [];
  const topFailure = d.failures_by_kind[0];

  if (d.runs.total === 0) {
    return {
      headline: `Nothing has run in the last ${d.window_hours} hours.`,
      suggested_focus: d.notifications.unread > 0 ? ["Read the unread notifications — something may be waiting."] : [],
    };
  }

  const parts = [`${d.runs.completed} of ${d.runs.total} runs finished in the last ${d.window_hours}h.`];

  if (topFailure && d.runs.failed > 0) {
    const c = classifyFailure(topFailure.kind);
    parts.push(`${d.runs.failed} failed, most often: ${topFailure.kind}.`);
    if (c.clears_on_its_own) {
      focus.push("The main failure clears on its own — don't rebuild anything, just resume the stalled work when it does.");
    } else if (c.agent_actionable) {
      focus.push("The main failure is something you can fix yourself — read the failing runs before retrying them.");
    } else {
      focus.push("The main failure needs the owner (settings, budget, or an approval) — tell them plainly rather than retrying.");
    }
  }

  if (d.approvals.outstanding > 0) {
    focus.push(`${d.approvals.outstanding} approval(s) still waiting on the owner — that work is parked, not broken.`);
  }
  if (d.notifications.unread_critical > 0) {
    focus.push(`${d.notifications.unread_critical} critical notification(s) unread — read those first.`);
  }
  const stalledProject = d.projects.find((p) => p.failed > 0 && p.completed === 0);
  if (stalledProject) {
    focus.push(`'${stalledProject.name ?? stalledProject.project_id}' has failed every run and completed none — look there first.`);
  }
  if (d.wake_failures.length > 0) {
    const w = d.wake_failures[0]!;
    focus.push(`${w.failed_runs} '${w.trigger}' wake-up(s) failed — recurring background work isn't getting through.`);
  }

  return { headline: parts.join(" "), suggested_focus: focus };
}

export const businessDiagnostics: PrebuiltScript = {
  name: "business-diagnostics",
  description:
    "See what has actually been happening in this business: how runs went, why they failed, which " +
    "projects are stuck, what is waiting on the owner, and how much budget is left. Start with " +
    "diagnostics.overview on any wake-up, then drill into failures/stalled_work/limits only where " +
    "the overview shows something wrong.",
  domain: "observability",
  requires_tier: 1,
  operations: {
    /**
     * The wake-up brief. One call, bounded, safe to run on every heartbeat.
     */
    "diagnostics.overview": async (a, c) => {
      const hours = windowHours(a);
      const data = (await spacesCall(c, `/spaces/${c.env.spaceId}/agent-diagnostics?window_hours=${hours}`)) as DiagnosticsOverview;
      const read = readTheRoom(data);
      return {
        ...data,
        // Put the interpretation next to the numbers rather than leaving the model to derive it —
        // on a small model that derivation is exactly where things go wrong.
        assessment: read.headline,
        suggested_focus: read.suggested_focus,
        how_to_go_deeper:
          "diagnostics.failures({kind}) for the rows behind a failure count · " +
          "diagnostics.stalled_work() for threads you can continue · " +
          "diagnostics.limits() for budget · " +
          "project_journal.read({project_id}) for a project's own state · " +
          "thread.read({thread_id}) for exactly what was said.",
      };
    },

    /**
     * The rows behind a count. `kind` filters to one classification — the usual next step after the
     * overview names a dominant failure.
     */
    "diagnostics.failures": async (a, c) => {
      const limit = Math.min(Math.max(Number(a["limit"] ?? 20) || 20, 1), 100);
      const qs = new URLSearchParams({ event_type: "run_failed", limit: String(limit) });
      const kind = a["kind"] ? String(a["kind"]) : "";
      if (kind) {
        if (!FAILURE_KINDS.includes(kind as never)) {
          throw new Error(`unknown failure kind '${kind}'. Known kinds: ${FAILURE_KINDS.join(", ")}`);
        }
        qs.set("failure_kind", kind);
      }
      if (a["project_id"]) qs.set("project_id", String(a["project_id"]));
      const res = (await spacesCall(c, `/spaces/${c.env.spaceId}/agent-activity?${qs.toString()}`)) as {
        data: Array<Record<string, unknown>>;
      };
      return {
        failures: res.data.map((row) => {
          const cls = classifyFailure(String(row["failure_kind"] ?? row["summary"] ?? ""));
          return {
            at: row["created_at"],
            agent_id: row["agent_id"],
            project_id: row["project_id"],
            session_id: row["session_id"],
            run_id: row["run_id"],
            woken_by: row["trigger_source"],
            kind: row["failure_kind"] ?? "unknown",
            error: row["summary"],
            tokens_used: row["tokens_used"],
            clears_on_its_own: cls.clears_on_its_own,
            you_can_fix_this: cls.agent_actionable,
            what_it_means: cls.summary,
          };
        }),
        count: res.data.length,
      };
    },

    /**
     * Work that stopped part-way and can be picked up. The session/run ids here are what a
     * continuation needs — resuming under the original run id is what stops already-completed
     * actions being redone (the action ledger keys on it).
     */
    "diagnostics.stalled_work": async (a, c) => {
      const hours = windowHours(a, 72);
      const data = (await spacesCall(c, `/spaces/${c.env.spaceId}/agent-diagnostics?window_hours=${hours}`)) as DiagnosticsOverview & {
        recent_stalls: Array<Record<string, unknown>>;
      };
      return {
        window_hours: hours,
        stalled: data.recent_stalls.map((s) => {
          const cls = classifyFailure(String(s["failure_kind"] ?? ""));
          return {
            ...s,
            clears_on_its_own: cls.clears_on_its_own,
            you_can_fix_this: cls.agent_actionable,
            what_it_means: cls.summary,
          };
        }),
        note:
          "To pick one up, work in its own thread (thread.read for context, then continue there). " +
          "Don't start the same goal in a fresh thread — that redoes work that already succeeded.",
      };
    },

    /**
     * Budget and headroom. Separate from the overview because it's the question worth asking
     * BEFORE starting something expensive, not only after something failed.
     */
    "diagnostics.limits": async (a, c) => {
      const hours = windowHours(a);
      const data = (await spacesCall(c, `/spaces/${c.env.spaceId}/agent-diagnostics?window_hours=${hours}`)) as DiagnosticsOverview;
      const limitFailures = data.failures_by_kind.filter(
        (f) => f.kind === "quota_exhausted" || f.kind === "budget_ceiling" || f.kind === "rate_limited" || f.kind === "context_overflow"
      );
      const hitAllowance = limitFailures.some((f) => f.kind === "quota_exhausted");
      const hitSpendCap = limitFailures.some((f) => f.kind === "budget_ceiling");
      const hitContext = limitFailures.some((f) => f.kind === "context_overflow");
      return {
        window_hours: hours,
        tokens_used: data.spend.tokens_used,
        credits_used: data.spend.credits,
        limit_failures: limitFailures,
        hit_model_allowance: hitAllowance,
        hit_spend_cap: hitSpendCap,
        hit_context_window: hitContext,
        guidance: [
          hitAllowance
            ? "The account's model allowance ran out. It resets on its own — pick the highest-value stalled work to do first when it does, rather than restarting everything at once."
            : null,
          hitSpendCap
            ? "A spend cap on this space stopped work. That's the owner's setting, not something to route around — tell them which project it's blocking."
            : null,
          hitContext
            ? "A request was too large for the model's context window. Break the work into smaller goals and lean on the Project Journal and memory instead of carrying everything in one prompt."
            : null,
          data.runs.failed > data.runs.completed && data.runs.total > 3
            ? "More runs are failing than succeeding. Diagnose before doing more work — repeating a failing approach just spends the remaining budget faster."
            : null,
        ].filter(Boolean),
      };
    },
  },
};
