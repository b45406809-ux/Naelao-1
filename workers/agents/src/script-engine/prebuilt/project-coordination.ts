/**
 * project-coordination (§A1.18 thread model) — lets a Space Assistant coordinate with a named
 * project agent without mixing that exchange into the visible user<->agent transcript, and gives
 * it a narrow way to look at a project's OTHER threads on demand.
 *
 * Design (see CLAUDE.md item 75 for the full reasoning): a project thread is the person and
 * whichever agent is working — two visible parties, no addressing ambiguity. When the assistant
 * needs to talk TO that agent (a handoff, a status check, an instruction), that's a real, separate
 * conversation — `agent.consult` runs it in its own subthread (thread_kind='sub_agent',
 * parent_thread_id), hidden by default and expandable in the shell, never appended to the visible
 * thread where nobody could tell who the assistant was actually addressing. "Context is not lost"
 * is mostly already solved without shared transcripts — Memory OS L3/L4/L6 (project-shared) and
 * the Project Journal carry the DISTILLED state across every thread in a project — this script is
 * for the rarer case of needing the RAW exchange itself: consulting an agent directly, or auditing
 * exactly what was said in a specific thread.
 *
 * `thread.list`/`thread.read` are read-only and never gated (same precedent as workspace-admin's
 * `project.list`/`agent.list`). `agent.consult` is left ungated by default too — it dispatches the
 * assistant's own normal operating cost (one run), same posture as @mention dispatch; whatever the
 * consulted agent decides to DO is still gated by its own agent_policy_overrides/assistant_policy
 * exactly as if a human had asked it directly.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function spacesCall(ctx: PrebuiltOpContext, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("project-coordination unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  if (!resp.ok) throw new Error(`project-coordination ${method} ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

export const projectCoordination: PrebuiltScript = {
  name: "project-coordination",
  description:
    "Consult a named project agent directly (a private, separate exchange — not the visible " +
    "thread the person is in), and look at a project's other threads on demand. Use this when " +
    "you need to hand off, check status with, or instruct a specific agent, or when you need to " +
    "see exactly what was said in another thread rather than relying on the Project Journal's " +
    "distilled summary.",
  domain: "orchestration",
  requires_tier: 1,
  operations: {
    "agent.consult": async (a, c) => {
      if (!c.env.orchestration?.consultAgent) {
        return { ok: false, error: "agent.consult not available in this environment" };
      }
      const agentId = String(a["agent_id"] ?? "");
      const message = String(a["message"] ?? "");
      if (!agentId || !message) throw new Error("agent.consult requires agent_id and message");
      const projectId = a["project_id"] ? String(a["project_id"]) : c.env.projectId;
      const parentThreadId = a["parent_thread_id"] ? String(a["parent_thread_id"]) : undefined;
      const threadId = a["thread_id"] ? String(a["thread_id"]) : undefined;
      return c.env.orchestration.consultAgent({
        agentId,
        message,
        spaceId: c.env.spaceId,
        ...(projectId ? { projectId } : {}),
        ...(parentThreadId ? { parentThreadId } : {}),
        ...(threadId ? { threadId } : {}),
      });
    },
    "thread.list": (a, c) => {
      const qs = new URLSearchParams({ space_id: c.env.spaceId });
      const projectId = a["project_id"] ? String(a["project_id"]) : c.env.projectId;
      if (projectId) qs.set("project_id", projectId);
      if (a["parent_thread_id"]) qs.set("parent_thread_id", String(a["parent_thread_id"]));
      if (a["include_sub_threads"]) qs.set("include_sub_threads", "true");
      return spacesCall(c, "GET", `/spaces/${c.env.spaceId}/threads?${qs.toString()}`);
    },
    "thread.read": async (a, c) => {
      const threadId = String(a["thread_id"] ?? "");
      if (!threadId) throw new Error("thread.read requires thread_id");
      const thread = (await spacesCall(c, "GET", `/spaces/${c.env.spaceId}/threads/${encodeURIComponent(threadId)}`)) as {
        id: string;
        session_id?: string | null;
        [key: string]: unknown;
      };
      if (!thread.session_id) return { thread, messages: [] };
      const messages = await spacesCall(c, "GET", `/spaces/${c.env.spaceId}/sessions/${thread.session_id}/messages`);
      return { thread, messages };
    },
  },
};
