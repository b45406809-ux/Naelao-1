/**
 * approvals — lets the Space Assistant see and act on pending approvals ANOTHER agent in this
 * business opened, not just its own.
 *
 * The existing HITL machinery (HITLApprovalDO, item 73/74's durable-suspend-and-resume) is
 * already space-wide by construction — a request opened by any project agent's own run is
 * visible from the SAME `GET /requests` list, addressed by space id alone. What was missing was a
 * caller: only a human clicking through `apps/shell`'s Approvals inbox page could ever act on one.
 * An autonomous business owner delegating day-to-day operation to its assistant reasonably expects
 * the assistant to be able to clear a routine, pre-understood approval on their behalf rather than
 * every single one waiting for them personally — the SAME judgment call the assistant already
 * makes for its own actions via assistant_policy, just now extended to another agent's.
 *
 * Reuses the exact HTTP routes `apps/shell`'s own Approvals page calls (GET .../sessions/inbox/
 * approvals, PUT .../approve, PUT .../reject) rather than reaching into HITLApprovalDO directly —
 * one gate (requireOwnedSpace), not two that could drift. `sessionId="inbox"` is not a real
 * session: the underlying DO's own `GET /requests` ignores session_id entirely when no run_id is
 * given (returns every pending approval for the space) — the same mechanism the shell's own
 * dedicated inbox page already depends on, confirmed by reading HITLApprovalDO's handler.
 *
 * `approvals.list` is read-only and safe by construction — auto-approved in guided mode, like
 * every other pure read in this codebase. `approvals.approve`/`approvals.decline` are real,
 * consequential actions (the approved action itself may move money or reach outside the
 * business) and stay gated like any other mutation.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";

async function agentsCall(ctx: PrebuiltOpContext, path: string, method: "GET" | "PUT", body?: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.agentsWorker) throw new Error("approvals unavailable: agents worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.agentsWorker.fetch(
    new Request(`http://agents-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  if (!resp.ok) throw new Error(`approvals ${method} ${path} failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

function requireApprovalId(a: Record<string, unknown>): string {
  const id = a["approval_id"];
  if (typeof id !== "string" || !id) throw new Error("approval_id is required");
  return id;
}

export const approvals: PrebuiltScript = {
  name: "approvals",
  description:
    "See and act on approvals waiting in this business — including ones a DIFFERENT project agent " +
    "opened, not just this conversation's own. approvals.list first; approve/decline only an " +
    "approval you actually understand (name, arguments) — never blind.",
  domain: "governance",
  requires_tier: 1,
  paramHints: {
    "approvals.approve": "approval_id (string, required) — from approvals.list's own 'id' field.",
    "approvals.decline": "approval_id (string, required); reason (string, optional) — why, for the audit trail.",
  },
  operations: {
    "approvals.list": async (_a, c) => {
      const data = (await agentsCall(c, `/spaces/${c.env.spaceId}/sessions/inbox/approvals`, "GET")) as { approvals?: unknown[] };
      return { pending: data.approvals ?? [], count: (data.approvals ?? []).length };
    },
    "approvals.approve": async (a, c) => {
      const approvalId = requireApprovalId(a);
      return agentsCall(c, `/spaces/${c.env.spaceId}/sessions/inbox/approvals/${encodeURIComponent(approvalId)}/approve`, "PUT");
    },
    "approvals.decline": async (a, c) => {
      const approvalId = requireApprovalId(a);
      const reason = typeof a["reason"] === "string" ? (a["reason"] as string) : undefined;
      return agentsCall(
        c,
        `/spaces/${c.env.spaceId}/sessions/inbox/approvals/${encodeURIComponent(approvalId)}/reject`,
        "PUT",
        reason ? { reason } : {}
      );
    },
  },
};
