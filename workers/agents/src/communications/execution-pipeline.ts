// MS-45 / V-spec MR-EXE-1..3, MD-7: one host function that runs every external action on a managed resource in the same order.
//
//   1 authenticate  -> 2 AgentPort authorize (writes the `allowed` receipt) -> 3 policy (grant conditions, limits, idempotency claim)
//   -> 4 approval, if policy requires it (bound to sha256 of the canonical payload) -> 5 reserve -> 6 execute through the adapter
//   -> 7 settle | release | uncertain -> 8 append the outcome receipt (`succeeded`, `failed`, `uncertain`) to AgentPort.
//
// Provider specifics live in the step's hooks; the order, the approval binding and the receipt chain live here. Behind
// MANAGED_EXECUTION_PIPELINE_ENABLED; callers keep their previous code path when the flag is off.
//
// MR-EXE-2: approval is decided only through `decideExecutionApproval` by an authenticated human who is not the proposer. Nothing in the
// payload, in model output or in external content can mark an approval granted: the pipeline reads only the stored row.
import type { AgentsEnv } from "../index.js";
import { AgentPortServiceClient } from "@agentport/sdk";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AuthorizedExecution, ExecutionResult, OperationCtx, ProviderAdapterV1 } from "./providers/contract.js";

export const executionPipelineEnabled = (env: { MANAGED_EXECUTION_PIPELINE_ENABLED?: string }) => env.MANAGED_EXECUTION_PIPELINE_ENABLED === "true";

export class ExecutionPipelineError extends Error {
  constructor(readonly code: string, readonly details: { approvalId?: string; payloadSha256?: string } = {}) { super(code); this.name = "ExecutionPipelineError"; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
async function sha256Hex(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export const executionPayloadSha256 = (payload: unknown) => sha256Hex(canonicalJson(payload));

// ---- approvals (MR-EXE-1 step 4) -------------------------------------------------------------------------------------------------
const APPROVAL_TTL_MS = 24 * 60 * 60_000;
type ApprovalRow = {
  id: string; tenant_id: string; space_id: string; provider: string; resource_ref: string; operation: string; payload_sha256: string; principal_id: string;
  proposer_kind: string; proposer_id: string; status: string; approver_kind: string | null; approver_id: string | null; expires_at: string; consumed_operation_id: string | null;
};
export interface ApprovalBinding {
  tenantId: string; spaceId: string; projectId?: string | null; provider: string; resourceRef: string; operation: string; principalId: string;
  proposer: { kind: "agent" | "user" | "system"; id: string };
}

/** Records a pending approval bound to the payload hash. Reuses an unexpired pending request for the same binding. */
export async function proposeExecutionApproval(env: AgentsEnv, binding: ApprovalBinding, payload: unknown, now = new Date()) {
  const payloadSha256 = await executionPayloadSha256(payload);
  const prior = await env.PLATFORM_DB.prepare(`SELECT id FROM managed_execution_approvals WHERE tenant_id=? AND space_id=? AND provider=? AND resource_ref=? AND operation=?
    AND payload_sha256=? AND principal_id=? AND proposer_id=? AND status='pending' AND expires_at>? LIMIT 1`)
    .bind(binding.tenantId, binding.spaceId, binding.provider, binding.resourceRef, binding.operation, payloadSha256, binding.principalId, binding.proposer.id, now.toISOString()).first<{ id: string }>();
  if (prior) return { approvalId: prior.id, payloadSha256 };
  const approvalId = `mea_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.PLATFORM_DB.prepare(`INSERT INTO managed_execution_approvals(id,tenant_id,space_id,project_id,provider,resource_ref,operation,payload_sha256,principal_id,
    proposer_kind,proposer_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .bind(approvalId, binding.tenantId, binding.spaceId, binding.projectId ?? null, binding.provider, binding.resourceRef, binding.operation, payloadSha256, binding.principalId,
      binding.proposer.kind, binding.proposer.id, new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(), now.toISOString()).run();
  return { approvalId, payloadSha256 };
}

/** Decides a pending approval. The approver must be an authenticated human (`user`) and never the proposer. */
export async function decideExecutionApproval(env: AgentsEnv, input: { tenantId: string; spaceId: string; approvalId: string; decision: "approve" | "reject"; approver: { kind: string; id: string } }, now = new Date()) {
  if (input.approver.kind !== "user" || !input.approver.id) throw new ExecutionPipelineError("approval_approver_must_be_human");
  const row = await env.PLATFORM_DB.prepare("SELECT * FROM managed_execution_approvals WHERE id=? AND tenant_id=? AND space_id=?")
    .bind(input.approvalId, input.tenantId, input.spaceId).first<ApprovalRow>();
  if (!row) throw new ExecutionPipelineError("approval_not_found");
  if (row.proposer_id === input.approver.id) throw new ExecutionPipelineError("approval_approver_is_proposer");
  if (row.status !== "pending") throw new ExecutionPipelineError("approval_already_decided");
  if (row.expires_at <= now.toISOString()) throw new ExecutionPipelineError("approval_expired");
  const changed = await env.PLATFORM_DB.prepare(`UPDATE managed_execution_approvals SET status=?,approver_kind='user',approver_id=?,decided_at=?
    WHERE id=? AND tenant_id=? AND status='pending'`).bind(input.decision === "approve" ? "approved" : "rejected", input.approver.id, now.toISOString(), input.approvalId, input.tenantId).run();
  if (!changed.meta.changes) throw new ExecutionPipelineError("approval_already_decided");
  return { approvalId: input.approvalId, status: input.decision === "approve" ? "approved" as const : "rejected" as const, payloadSha256: row.payload_sha256 };
}

async function claimApproval(env: AgentsEnv, step: ExecutionStep<unknown, unknown>, payloadSha256: string, now: Date) {
  const row = await env.PLATFORM_DB.prepare("SELECT * FROM managed_execution_approvals WHERE id=? AND tenant_id=?").bind(step.approvalId!, step.tenantId).first<ApprovalRow>();
  if (!row) throw new ExecutionPipelineError("approval_not_found");
  if (row.space_id !== step.spaceId || row.provider !== step.provider || row.resource_ref !== step.resourceRef || row.operation !== step.operation || row.principal_id !== step.principalId)
    throw new ExecutionPipelineError("approval_invalidated");
  if (row.payload_sha256 !== payloadSha256) throw new ExecutionPipelineError("approval_invalidated");
  if (row.status === "rejected") throw new ExecutionPipelineError("approval_rejected");
  if (row.status !== "approved") throw new ExecutionPipelineError("communication_approval_required", { approvalId: row.id, payloadSha256 });
  if (row.expires_at <= now.toISOString()) throw new ExecutionPipelineError("approval_expired");
  if (row.approver_kind !== "user" || !row.approver_id || row.approver_id === row.proposer_id) throw new ExecutionPipelineError("approval_approver_invalid");
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_execution_approvals SET consumed_operation_id=?,consumed_at=? WHERE id=? AND tenant_id=? AND status='approved'
    AND (consumed_operation_id IS NULL OR consumed_operation_id=?)`).bind(step.operationId, now.toISOString(), row.id, step.tenantId, step.operationId).run();
  if (!claimed.meta.changes) throw new ExecutionPipelineError("approval_already_used");
}
async function unclaimApproval(env: AgentsEnv, step: ExecutionStep<unknown, unknown>) {
  await env.PLATFORM_DB.prepare("UPDATE managed_execution_approvals SET consumed_operation_id=NULL,consumed_at=NULL WHERE id=? AND tenant_id=? AND consumed_operation_id=?")
    .bind(step.approvalId!, step.tenantId, step.operationId).run().catch(() => undefined);
}

// ---- outcome receipts (step 8) ---------------------------------------------------------------------------------------------------
export type OutcomeKind = "succeeded" | "failed" | "uncertain";
export type AgentPortCall = (path: string, method: string, body?: unknown) => Promise<{ result: Record<string, unknown> }>;

/** The host's own AgentPort caller (HMAC internal token, client_system role). Adapters never receive it. */
export function agentPortCaller(env: AgentsEnv, tenantId: string): AgentPortCall {
  return async (path, method, body) => {
    const client = new AgentPortServiceClient({ baseUrl: "https://agentport.internal/internal/agentport",
      headers: { "content-type": "application/json", "x-agentport-tenant-id": tenantId, "x-agentport-actor-role": "client_system", "x-agentport-actor-id": tenantId,
        "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
      fetch: (input, init) => env.AGENTPORT_WORKER.fetch(new Request(input, init)) });
    const response = await client.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await readBoundedResponseJson<Record<string, unknown>>(response, 64 * 1024);
    if (!response.ok && response.status !== 409) throw new Error(`agentport_${String(result.error_code ?? "request_failed")}`);
    return { result };
  };
}

// ---- the pipeline ----------------------------------------------------------------------------------------------------------------
export interface ExecutionStep<R, H = unknown> {
  tenantId: string; spaceId: string; projectId?: string | null;
  provider: string;
  /** Idempotency anchor: also the outcome receipt's operation id. */
  operationId: string;
  /** Step 1: who is calling. A missing tenant or actor is refused before anything else runs. */
  actor: { kind: "agent" | "user"; id: string };
  /** The principal on whose behalf the action runs; an approval is bound to it. */
  principalId: string;
  agentId: string; agentPortAccountId: string;
  /** AgentPort capability (e.g. `messages.send`), resource and idempotency key of the authorization receipt. */
  capability: string; resourceRef: string; authorizationKey: string;
  operation: string;
  /** The exact payload that will be sent. Its canonical sha256 is what an approval binds. */
  payload: Record<string, unknown>;
  /** A reference to an approval decided out of band. Never part of `payload`. */
  approvalId?: string;
  agentPort: AgentPortCall;
  /** Step 3. May claim idempotency or limit slots. Returning `replay` ends the run with that result and no further side effects. */
  policy(): Promise<{ approvalRequired: boolean; replay?: R }>;
  /** Step 3b, after approval: claims limit and idempotency slots so a refused approval never consumes one. May also end the run with a `replay`. */
  claim?(): Promise<{ replay?: R } | void>;
  /** Step 5. `null` when the operation is not billed per call. */
  reserve(): Promise<H | null>;
  /** Called immediately before the first provider contact (e.g. moves a hold to uncertain). The pipeline then treats a failure as unknown. */
  beforeDispatch?(handle: H | null): Promise<void>;
  /** Step 6. Must call `dispatch()` right before it contacts the provider. */
  execute(handle: H | null, dispatch: () => Promise<void>): Promise<R>;
  onSuccess?(result: R): Promise<void>;
  settle?(handle: H): Promise<boolean>;
  release?(handle: H, error: unknown): Promise<void>;
  closeUncertain?(handle: H): Promise<void>;
  /** Failure cleanup for provider state (e.g. delete an unused claim before dispatch, mark indeterminate after). */
  onFailure?(error: unknown, dispatchStarted: boolean): Promise<void>;
  now?: () => Date;
}

const safeCode = (error: unknown, fallback: string) => error instanceof Error && /^[a-z][a-z0-9_:-]{0,99}$/.test(error.message) ? error.message : fallback;

export async function runManagedExecution<R, H>(env: AgentsEnv, step: ExecutionStep<R, H>): Promise<R> {
  const now = step.now ?? (() => new Date());
  // 1. authenticate
  if (!step.tenantId || !step.spaceId || !step.actor?.id || !step.operationId) throw new ExecutionPipelineError("execution_unauthenticated");
  let authorizationId = "";
  let handle: H | null = null, dispatchStarted = false, claimedApproval = false;
  const payloadSha256 = await executionPayloadSha256(step.payload);
  const receipt = async (outcome: OutcomeKind, reasonCode?: string) => {
    // A receipt failure never turns a delivered action into an error; AgentPort replays are idempotent so a later reconcile can append it.
    await step.agentPort(`/accounts/${encodeURIComponent(step.agentPortAccountId)}/actions/outcome`, "POST",
      { agentId: step.agentId, authorizationId, operationId: step.operationId, outcome, ...(reasonCode ? { reasonCode } : {}) }).catch(() => undefined);
  };
  try {
    // 2. AgentPort authorize
    const authorization = await step.agentPort(`/accounts/${encodeURIComponent(step.agentPortAccountId)}/actions/authorize`, "POST",
      { agentId: step.agentId, action: step.capability, idempotencyKey: step.authorizationKey, resourceRef: step.resourceRef });
    if (authorization.result.decision !== "allow") throw new ExecutionPipelineError("agentmail_action_not_authorized");
    authorizationId = typeof authorization.result.authorizationId === "string" ? authorization.result.authorizationId : "";
    // 3. policy (and budget limits)
    const policy = await step.policy();
    if (policy.replay !== undefined) return policy.replay;
    // 4. approval, bound to the payload hash
    if (policy.approvalRequired) {
      if (!step.approvalId) {
        const proposed = await proposeExecutionApproval(env, { tenantId: step.tenantId, spaceId: step.spaceId, projectId: step.projectId ?? null, provider: step.provider,
          resourceRef: step.resourceRef, operation: step.operation, principalId: step.principalId, proposer: { kind: step.actor.kind, id: step.actor.id } }, step.payload, now());
        throw new ExecutionPipelineError("communication_approval_required", proposed);
      }
      await claimApproval(env, step as ExecutionStep<unknown, unknown>, payloadSha256, now());
      claimedApproval = true;
    }
    const claim = await step.claim?.();
    if (claim && claim.replay !== undefined) return claim.replay;
    // 5. reserve
    handle = await step.reserve();
    // 6. execute
    const result = await step.execute(handle, async () => { await step.beforeDispatch?.(handle); dispatchStarted = true; });
    await step.onSuccess?.(result);
    // 7. settle (a settlement failure leaves the hold for reconciliation and does not fail a delivered action; the hook records it)
    if (handle !== null && step.settle) await step.settle(handle).catch(() => false);
    // 8. outcome receipt
    await receipt("succeeded");
    return result;
  } catch (error) {
    if (claimedApproval && !dispatchStarted) await unclaimApproval(env, step as ExecutionStep<unknown, unknown>);
    if (dispatchStarted) {
      if (handle !== null) await step.closeUncertain?.(handle);
      await step.onFailure?.(error, true);
      await receipt("uncertain", "outcome_unknown");
    } else {
      if (handle !== null) await step.release?.(handle, error);
      await step.onFailure?.(error, false);
      // Only refusals after authorization have a receipt to chain to; an approval request is not a failed action.
      if (authorizationId && !(error instanceof ExecutionPipelineError && error.code === "communication_approval_required")) await receipt("failed", safeCode(error, "execution_failed"));
    }
    throw error;
  }
}

// ---- generic adapter execution (Naelao Email send, any ProviderAdapterV1) ----------------------------------------------------------
export interface AdapterExecutionInput {
  tenantId: string; spaceId: string; projectId?: string | null; userId: string;
  /** The AgentPort agent and account that the adapter operation is authorized against. */
  agentId: string; agentPortAccountId: string;
  adapter: ProviderAdapterV1;
  operation: AuthorizedExecution["operation"];
  providerResourceRef: string;
  params: Record<string, unknown>;
  operationId: string;
  approvalId?: string;
  /** Whether an owner approval is required for this action (policy output; a model risk score may only turn this on). */
  approvalRequired?: boolean;
  /** Grant conditions checked at step 3, e.g. recipients and rate. Throw to refuse. */
  checkPolicy?: () => Promise<void>;
  /** Billing hooks; omitted when the operation is covered by a subscription (Naelao Email send is billed through period usage). */
  billing?: { reserve(): Promise<unknown>; settle(handle: unknown): Promise<boolean>; release(handle: unknown, error: unknown): Promise<void>; markUncertain(handle: unknown): Promise<void> };
}

/** Runs one adapter operation (`ProviderAdapterV1.execute`) through the shared pipeline. */
export async function executeAdapterOperation(env: AgentsEnv, input: AdapterExecutionInput): Promise<ExecutionResult> {
  const capability = input.operation === "send" ? "messages.send" : input.operation === "read" ? "messages.read" : input.operation;
  const op: OperationCtx = { operation_id: input.operationId, idempotency_key: input.operationId };
  return runManagedExecution<ExecutionResult, unknown>(env, {
    tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId ?? null, provider: input.adapter.provider, operationId: input.operationId,
    actor: { kind: "agent", id: input.agentId }, principalId: input.userId, agentId: input.agentId, agentPortAccountId: input.agentPortAccountId,
    capability, resourceRef: input.providerResourceRef, authorizationKey: `adapter:${input.operationId}`, operation: input.operation,
    payload: input.params, ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    agentPort: agentPortCaller(env, input.tenantId),
    policy: async () => { await input.checkPolicy?.(); return { approvalRequired: input.approvalRequired === true }; },
    reserve: async () => input.billing ? input.billing.reserve() : null,
    beforeDispatch: async handle => { if (handle !== null && input.billing) await input.billing.markUncertain(handle); },
    execute: async (_handle, dispatch) => {
      await dispatch();
      return input.adapter.execute({ tenantId: input.tenantId, operation: input.operation, provider_resource_ref: input.providerResourceRef, params: input.params }, op);
    },
    ...(input.billing ? {
      settle: (handle: unknown) => input.billing!.settle(handle),
      release: (handle: unknown, error: unknown) => input.billing!.release(handle, error),
      closeUncertain: async (_handle: unknown) => undefined,
    } : {}),
  });
}
