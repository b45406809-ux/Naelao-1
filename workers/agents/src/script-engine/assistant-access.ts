/**
 * F-36 enforcement — the runtime half of the assistant per-user permission clamp.
 *
 * The clamp itself (what role an assistant EFFECTIVELY has in a project when acting on behalf
 * of user U — never more than U's own `project_members` role, further clamped by that row's
 * `assistant_mode`) is defined and computed in exactly one place: SpaceDO's
 * `resolveAssistantEffectiveRole` (workers/spaces/src/do/SpaceDO.ts), exposed over
 * `GET /spaces/:spaceId/projects/:projectId/assistant-access?user_id=U`. This module is the
 * agents-worker side that makes the clamp REAL at runtime — before this pass the clamp existed
 * but nothing in workers/agents ever consulted it, so an assistant acting for a `read_only`
 * or `none`-clamped user ran with full space-scoped authority anyway.
 *
 * Two enforcement pieces live here (both pure — the DO wires them):
 *
 * 1. `isReadSafeOperation` — what "read-only" means at the six-op script surface. A `viewer`
 *    effective role allows script.read / script.find and the prebuilt operations on the
 *    explicit allowlist below; it refuses script.create / update / delete, every stored
 *    (agent-authored) script — arbitrary code is assumed mutating — and any prebuilt op NOT
 *    on the list. Deliberately a small explicit allowlist over Naelao's own op names (the
 *    same posture as wallet.ts's THIRD_PARTY_PAYMENT_CREDENTIAL_NAMES): fail closed, so a new
 *    prebuilt op is write-gated until someone consciously classifies it as read-safe. This is
 *    enforced structurally in ScriptToolSurface (the maxTier precedent), not by prompt text.
 *
 * 2. `resolveAssistantApprovalPlan` — the approval-policy intersection. The space-wide
 *    `assistant_policy` (always_ask / yolo) was previously applied identically no matter WHO
 *    the assistant was acting for, so an owner flipping the space to `yolo` granted un-gated
 *    autonomy even to runs made on behalf of a viewer or a product end user. Now `yolo` only
 *    fully applies when the acting caller could self-authorize everything anyway (the space
 *    owner/admin — the roles that can edit the policy itself) or when there is NO human caller
 *    at all (cron / trigger / webhook wakes, which never set x-naelao-role: the autonomous
 *    operation the owner explicitly configured yolo FOR). Any other verified caller role
 *    (editor/viewer builders, product_end_user, agent API keys) downgrades yolo to the
 *    always_ask posture: everything gated except the policy's own auto_approved_actions.
 *    Fails closed by construction — an unrecognized role string downgrades.
 */

import type { ApprovalMode } from "./loop.js";

export type AssistantEffectiveRole = "owner" | "editor" | "viewer";

/**
 * Prebuilt operations a `viewer`-clamped run may execute: reads with no side effect beyond
 * observation. Everything else — including ops that LOOK read-adjacent but drive an external
 * effect (browser.navigate can submit a GET with side effects, mcp `call` invokes an external
 * tool, local.read_file reads a granting user's machine) — is refused under the clamp.
 */
export const READ_SAFE_PREBUILT_OPS: ReadonlySet<string> = new Set([
  // r2-workspace (bare op names)
  "read_file",
  "list_directory",
  "stat_file",
  // search_file was a pure read the same class as read_file/list_directory but was never added
  // here — found while adding the REPL-primitive reads below.
  "search_file",
  // Claude-Code-shaped REPL primitives (r2-workspace.ts) — Read/Grep/Glob are reads; Edit/Write
  // mutate and Bash executes, so neither is on this list.
  "Read",
  "Grep",
  "Glob",
  // file-manager (diff/history are reads; append/patch mutate)
  "file.diff",
  "file.history",
  // web-search (bare op names — SSRF-guarded reads of the public web via the knowledge worker)
  "search",
  "fetch_page",
  "extract_content",
  // knowledge-base
  "knowledge.search",
  // memory / fabric / wiki recall (remember/forget/record/upsert mutate)
  "memory.recall",
  "fabric.recall",
  "fabric.brief",
  "wiki.lookup",
  "wiki.search",
  // mcp-connector (bare op names — listing is read-safe; register/call are not)
  "list_servers",
  "list_tools",
  // status/list reads across the catalogue
  "lock.status",
  "workspace.list",
  "workflow.status",
  "project.list",
  "agent.list",
  "wallet.balance",
  "wallet.history",
  "wallet.check_bypass",
  "commerce.list_products",
  "commerce.get_order",
  "email.status",
  "storefront.status",
  "local.status",
  // tools.search/tools.describe (ScriptToolSurface, progressive tool disclosure) — pure metadata
  // lookups over whatever is already enabled, no side effect of any kind.
  "tools.search",
  "tools.describe",
  // tasks.ts (AVOS plan step 4) — listing the project's task DAG is a pure read; create/start/
  // complete/block are structural writes and stay off this list.
  "task.list",
  // plan.ts — the run-scoped checklist. Every plan op is safe-by-construction: it only organizes
  // THIS run's own plan state (no external side effect, no money, no outside reach), so even a
  // read-only-clamped run may use it to plan and track its own work.
  "plan.set",
  "plan.add_step",
  "plan.complete_step",
  "plan.status",
  "plan.clear",
]);

export function isReadSafeOperation(name: string): boolean {
  return READ_SAFE_PREBUILT_OPS.has(name);
}

/** Space-level roles that can edit the assistant policy itself — the only callers whose
 *  presence doesn't downgrade `yolo` (they could self-authorize any gated action anyway). */
const YOLO_SELF_AUTHORIZING_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export interface AssistantApprovalPlan {
  requiresApprovalFor: string[];
  approvalMode: ApprovalMode;
}

/**
 * Intersect the space-wide assistant policy with the verified acting caller's role
 * (`x-naelao-role`, set by naelao-router from verified claims; `undefined` for internal/system
 * wakes, which never set it). See the module doc — yolo applies fully only for system wakes
 * and owner/admin callers; everyone else keeps the always_ask posture.
 */
export function resolveAssistantApprovalPlan(
  policy: { approval_mode: "always_ask" | "yolo"; auto_approved_actions: string[] } | null,
  callerRole: string | undefined,
  /**
   * The caller's role in THIS business, when they're a product end user.
   *
   * Without this, an end user always downgraded yolo — which was right when a product_end_user
   * meant "a customer of the business", and wrong once they could be its owner. A business owner
   * who flipped their own business to autonomous still had every action gated, and there was no
   * approver but themself: the same owner-locked-out-of-their-own-business bug items 79 and 90
   * fixed at the route and UI layers, one layer deeper. Resolved server-side from
   * business_memberships, never client-supplied.
   */
  businessRole?: string | undefined
): AssistantApprovalPlan {
  const selfAuthorizing =
    callerRole === undefined ||
    YOLO_SELF_AUTHORIZING_ROLES.has(callerRole) ||
    // A plain member is still downgraded: yolo is the owner's choice about their own business,
    // not a grant to everyone who can talk to it.
    (callerRole === "product_end_user" && businessRole !== undefined && YOLO_SELF_AUTHORIZING_ROLES.has(businessRole));

  const yoloApplies = policy?.approval_mode === "yolo" && selfAuthorizing;
  if (yoloApplies) {
    return { requiresApprovalFor: [], approvalMode: "gate_listed" };
  }
  return {
    requiresApprovalFor: policy?.auto_approved_actions ?? [],
    approvalMode: "gate_unless_listed",
  };
}
