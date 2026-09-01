/**
 * schedule (step 12) — lets an agent wake ITSELF later with a follow-up goal, and list/cancel its
 * scheduled wakes. This is the "cron tool to set a trigger that wakes it after ~X" primitive from
 * the ask: the pattern is "kick off a long/background job (a sub-agent, a workflow, an external
 * task), do whatever else there is, and if there's nothing left to do but wait, schedule a wake to
 * come back and check on it" — the way Claude Code checks back on a background task.
 *
 * Implemented on the EXISTING goal-based scheduled_jobs dispatcher (migration 0043), NOT a second
 * scheduler: a due wake calls wakeAgentGoal against this same agent's own DO with the follow-up
 * goal, exactly as the seeded revenue-review cron does. A delay-based wake is one-shot — it fires
 * once (params._one_shot, which the dispatcher disables after firing) rather than recurring. A
 * `cron`-based wake is a real recurring schedule.
 *
 * Granularity: the platform sweeps scheduled jobs on an HOURLY heartbeat, so a wake scheduled
 * sooner than the next heartbeat fires on that next heartbeat (the dispatcher's isCronDue scans
 * the window since last_run_at, so it still fires — just no finer than ~hourly). wake_me says this.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function spacesCall(
  ctx: PrebuiltOpContext,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; json: unknown }> {
  if (!ctx.env.spacesWorker) throw new Error("schedule unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
        ...(ctx.env.userId ? { "x-naelao-user-id": ctx.env.userId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}

function numArg(a: Record<string, unknown>, name: string): number | undefined {
  const v = a[name];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** A one-shot cron for a specific UTC minute ~delayMinutes from now: minute/hour/day-of-month/
 *  month pinned (fires at that date+time), day-of-week wildcard. Combined with params._one_shot,
 *  the dispatcher disables it after the first fire so it never recurs. */
export function cronForDelay(delayMinutes: number, now: Date = new Date()): string {
  const target = new Date(now.getTime() + Math.max(0, delayMinutes) * 60_000);
  return `${target.getUTCMinutes()} ${target.getUTCHours()} ${target.getUTCDate()} ${target.getUTCMonth() + 1} *`;
}

export const schedule: PrebuiltScript = {
  name: "schedule",
  description:
    "Wake yourself later with a follow-up goal (a cron trigger you set), and list or cancel your " +
    "scheduled wakes. Use this to check back on a long/background task (a sub-agent, a workflow, " +
    "an external job) after doing everything else: schedule a wake for roughly when you expect it " +
    "to be ready, then end this run; the wake re-runs you with the follow-up goal so you can check.",
  domain: "orchestration",
  requires_tier: 1,
  paramHints: {
    "schedule.wake_me":
      "goal (string, REQUIRED — the follow-up instruction to run when you wake, e.g. \"check " +
      "whether the research sub-agent finished and summarize it\"). ONE of: delay_minutes " +
      "(number) / delay_hours (number) for a one-shot wake, OR cron (5-field string) for a " +
      "recurring schedule. name (string, optional). Note: wakes fire on the platform's hourly " +
      "heartbeat, so anything sooner than ~1 hour fires on the next heartbeat.",
    "schedule.list": "no parameters. Lists your scheduled wakes/jobs in this project (or space-wide).",
    "schedule.cancel": "id (string, REQUIRED — a job id from schedule.list).",
  },
  operations: {
    "schedule.wake_me": async (a, c) => {
      const goal = String(a["goal"] ?? "").trim();
      if (!goal) throw new Error("schedule.wake_me requires a goal (what to do when you wake)");
      const explicitCron = typeof a["cron"] === "string" ? (a["cron"] as string).trim() : "";
      const delayMinutes = numArg(a, "delay_minutes") ?? numArg(a, "delayMinutes");
      const delayHours = numArg(a, "delay_hours") ?? numArg(a, "delayHours");
      const delayDays = numArg(a, "delay_days") ?? numArg(a, "delayDays");
      const wakeAtRaw = typeof a["wake_at"] === "string" ? a["wake_at"] : typeof a["wakeAt"] === "string" ? a["wakeAt"] : undefined;

      let cron: string;
      let oneShot = false;
      if (explicitCron) {
        cron = explicitCron;
      } else if (wakeAtRaw) {
        const targetMs = new Date(wakeAtRaw).getTime();
        const diffMins = Math.round((targetMs - Date.now()) / 60_000);
        if (isNaN(diffMins) || diffMins <= 0) throw new Error("wake_at must be a valid future date/timestamp");
        cron = cronForDelay(diffMins);
        oneShot = true;
      } else if (delayDays !== undefined || delayHours !== undefined || delayMinutes !== undefined) {
        const mins = (delayDays ?? 0) * 1440 + (delayHours ?? 0) * 60 + (delayMinutes ?? 0);
        if (mins <= 0) throw new Error("delay must be positive");
        cron = cronForDelay(mins);
        oneShot = true;
      } else {
        throw new Error("schedule.wake_me requires delay_minutes/delay_hours/delay_days, wake_at, or a cron expression");
      }
      const name = typeof a["name"] === "string" && a["name"] ? (a["name"] as string) : `wake: ${goal.slice(0, 40)}`;
      const res = await spacesCall(c, "POST", `/spaces/${c.env.spaceId}/scheduled-jobs`, {
        name,
        cron_expression: cron,
        goal,
        agent_id: c.env.agentId,
        ...(c.env.projectId ? { project_id: c.env.projectId } : {}),
        ...(oneShot ? { params: { _one_shot: true } } : {}),
      });
      if (!res.ok) return { ok: false, error: `failed to schedule wake: HTTP ${res.status}` };
      const created = res.json as { id?: string };
      return {
        ok: true,
        id: created.id ?? null,
        cron_expression: cron,
        one_shot: oneShot,
        note: oneShot
          ? "Scheduled a one-shot wake. It fires on the next hourly heartbeat at or after the target time, then disables itself."
          : "Scheduled a recurring wake. Use schedule.cancel with the id when it's no longer needed.",
      };
    },
    "schedule.list": async (_a, c) => {
      const qs = c.env.projectId ? `?project_id=${encodeURIComponent(c.env.projectId)}` : "";
      const res = await spacesCall(c, "GET", `/spaces/${c.env.spaceId}/scheduled-jobs${qs}`);
      if (!res.ok) return { ok: false, error: `failed to list wakes: HTTP ${res.status}` };
      return res.json;
    },
    "schedule.cancel": async (a, c) => {
      const id = String(a["id"] ?? "").trim();
      if (!id) throw new Error("schedule.cancel requires an id");
      const res = await spacesCall(c, "DELETE", `/spaces/${c.env.spaceId}/scheduled-jobs/${encodeURIComponent(id)}`);
      if (!res.ok) return { ok: false, error: `failed to cancel wake ${id}: HTTP ${res.status}` };
      return { ok: true, cancelled: id };
    },
  },
};
