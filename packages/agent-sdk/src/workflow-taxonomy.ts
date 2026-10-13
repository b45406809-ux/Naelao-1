import { assertExtensionId, type ExtensionId } from "./types.js";

export type WorkflowClass =
  | "company_automation"
  | "vertical_extension"
  | "ephemeral_task";
export interface WorkflowClassPolicy {
  executionClass: 1 | 2 | 3;
  minimumDeterministicStepRatio: number;
  owner: "space" | "extension" | "invoker";
  persistence: "durable" | "extension_state" | "until_terminal";
  maxAttempts: number;
  cancellation: "owner_or_admin" | "extension_or_admin" | "invoker_or_admin";
  billing: "space" | "extension_budget" | "invoker";
  reportsTo: "executive_channel_and_founder_telegram" | "project_team_room" | "receipt_card";
  escalationTarget: "space_owner" | "project_lead" | "invoker";
  receiptLines: 2 | null;
}
export const WORKFLOW_CLASS_POLICIES: Readonly<
  Record<WorkflowClass, WorkflowClassPolicy>
> = Object.freeze({
  company_automation: {
    executionClass: 1, minimumDeterministicStepRatio: 0.9,
    owner: "space",
    persistence: "durable",
    maxAttempts: 5,
    cancellation: "owner_or_admin",
    billing: "space",
    reportsTo: "executive_channel_and_founder_telegram", escalationTarget: "space_owner", receiptLines: null,
  },
  vertical_extension: {
    executionClass: 2, minimumDeterministicStepRatio: 0,
    owner: "extension",
    persistence: "extension_state",
    maxAttempts: 3,
    cancellation: "extension_or_admin",
    billing: "extension_budget",
    reportsTo: "project_team_room", escalationTarget: "project_lead", receiptLines: null,
  },
  ephemeral_task: {
    executionClass: 3, minimumDeterministicStepRatio: 0,
    owner: "invoker",
    persistence: "until_terminal",
    maxAttempts: 2,
    cancellation: "invoker_or_admin",
    billing: "invoker",
    reportsTo: "receipt_card", escalationTarget: "invoker", receiptLines: 2,
  },
});

export interface WorkflowDeclaration { workflowClass: WorkflowClass; spaceId: string; projectId?: string; installationId?: string; extensionId?: ExtensionId; invokerId?: string; budgetCredits: number }
export interface RoutedWorkflow extends WorkflowDeclaration { budgetKey: string; reportTarget: WorkflowClassPolicy["reportsTo"]; escalationTarget: WorkflowClassPolicy["escalationTarget"] }
/** Validates scope and returns an isolated accounting/routing envelope. */
export function routeWorkflow(declaration: WorkflowDeclaration): RoutedWorkflow {
  if (!Number.isFinite(declaration.budgetCredits) || declaration.budgetCredits <= 0) throw new Error("workflow budget must be positive");
  const policy = WORKFLOW_CLASS_POLICIES[declaration.workflowClass];
  if (!policy) throw new Error("unknown_workflow_class");
  if (declaration.workflowClass === "company_automation" && (declaration.projectId || declaration.extensionId)) throw new Error("company automation must be rooted at the space");
  if (declaration.workflowClass === "vertical_extension" && (!(declaration.projectId || declaration.installationId) || !declaration.extensionId)) throw new Error("vertical workflow requires a project or verified installation and extensionId");
  if (declaration.extensionId) assertExtensionId(declaration.extensionId);
  if (declaration.workflowClass === "ephemeral_task" && !declaration.invokerId) throw new Error("ephemeral workflow requires invokerId");
  const owner = declaration.workflowClass === "company_automation" ? declaration.spaceId : declaration.workflowClass === "vertical_extension" ? `${declaration.extensionId}:${declaration.projectId ?? declaration.installationId}` : declaration.invokerId!;
  const reportTarget = declaration.workflowClass === "vertical_extension" && !declaration.projectId ? "executive_channel_and_founder_telegram" : policy.reportsTo;
  return { ...declaration, budgetKey: `workflow:${declaration.workflowClass}:${owner}`, reportTarget, escalationTarget: policy.escalationTarget };
}

/** Persisted identities contain references and grant versions, never credentials or bindings. */
export interface DurableWorkflowIdentity {
  schema: 1; runId: string; tenantId: string; spaceId: string; projectId?: string;
  actorId: string; agentId: string; installationId?: string; definitionId?: string; grantVersion: string;
  codeDigest: string; codeKey: string; startKey: string; reservationId?: string;
  expiresAt: number; workflowClass: WorkflowClass; capabilities: readonly string[];
}
export type DurableWorkflowStatus = "queued" | "running" | "sleeping" | "waiting" | "succeeded" | "failed" | "cancelled" | "expired";
export interface WorkflowCheckpointPointer { schema: 1; r2_key: string; sha256: string; bytes: number }
export interface DurableEffectRecord {
  key: string; operation: string; inputDigest: string; status: "prepared" | "committed" | "indeterminate";
  result?: WorkflowCheckpointPointer; providerReceipt?: string;
}
export interface DurableWorkflowRecord {
  identity: DurableWorkflowIdentity; status: DurableWorkflowStatus;
  updatedAt: number; attempt: number; result?: WorkflowCheckpointPointer; error?: string;
}
const IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL_WORKFLOW_STATUSES = new Set<DurableWorkflowStatus>(["succeeded", "failed", "cancelled", "expired"]);
export function isTerminalWorkflow(status: DurableWorkflowStatus): boolean { return TERMINAL_WORKFLOW_STATUSES.has(status); }
export function validateDurableWorkflowIdentity(identity: DurableWorkflowIdentity, now = Date.now()): void {
  if (identity.schema !== 1) throw new Error("workflow_schema_unsupported");
  for (const value of [identity.runId, identity.tenantId, identity.spaceId, identity.actorId, identity.agentId, identity.grantVersion, identity.startKey,
    ...(identity.projectId ? [identity.projectId] : []), ...(identity.installationId ? [identity.installationId] : [])]) {
    if (!IDENTITY_TOKEN.test(value)) throw new Error("workflow_invalid_identity");
  }
  if (!SHA256.test(identity.codeDigest)) throw new Error("workflow_invalid_code_digest");
  if (!identity.codeKey.startsWith("workflow-code/" + identity.tenantId + "/" + identity.spaceId + "/") || identity.codeKey.includes("..")) throw new Error("workflow_code_scope_mismatch");
  if (!Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now) throw new Error("workflow_expired");
  if (!WORKFLOW_CLASS_POLICIES[identity.workflowClass] || !Array.isArray(identity.capabilities) || identity.capabilities.length > 64) throw new Error("workflow_invalid_grant");
  if (identity.capabilities.some((capability) => typeof capability !== "string" || capability.length > 128)) throw new Error("workflow_invalid_capability");
}
export function workflowArtifactPrefix(identity: Pick<DurableWorkflowIdentity, "tenantId" | "spaceId" | "runId">): string {
  return "workflow-artifacts/" + identity.tenantId + "/" + identity.spaceId + "/" + identity.runId + "/";
}
export function validateWorkflowPointer(identity: DurableWorkflowIdentity, value: WorkflowCheckpointPointer): void {
  if (value.schema !== 1 || !SHA256.test(value.sha256) || !value.r2_key.startsWith(workflowArtifactPrefix(identity))
    || value.r2_key.includes("..") || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error("workflow_invalid_checkpoint_pointer");
}
export function serializeWorkflowCheckpoint(value: unknown, maxBytes = 1024): string {
  const visit = (input: unknown, depth: number): void => {
    if (depth > 32) throw new Error("workflow_checkpoint_depth");
    if (input === null || ["string", "boolean"].includes(typeof input)) return;
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error("workflow_checkpoint_nonfinite"); return; }
    if (Array.isArray(input)) { for (const item of input) visit(item, depth + 1); return; }
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      throw new Error("workflow_checkpoint_not_json");
    for (const [key, item] of Object.entries(input)) {
      if (/(?:secret|password|authorization|api[_-]?key|access[_-]?token|private[_-]?key)/i.test(key)) throw new Error("workflow_checkpoint_secret");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength >= maxBytes) throw new Error("workflow_checkpoint_requires_r2_pointer");
  return json;
}
export async function durableWorkflowRunId(scope: Pick<DurableWorkflowIdentity, "tenantId" | "spaceId" | "projectId" | "actorId">, startKey: string): Promise<string> {
  if (!IDENTITY_TOKEN.test(startKey)) throw new Error("workflow_start_key_required");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId ?? "", scope.actorId, startKey])));
  return "wf-" + Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function transitionWorkflow(record: DurableWorkflowRecord, next: DurableWorkflowStatus, now = Date.now()): DurableWorkflowRecord {
  if (isTerminalWorkflow(record.status)) { if (record.status !== next) throw new Error("workflow_already_terminal"); return record; }
  if (!isTerminalWorkflow(next) && record.identity.expiresAt <= now) next = "expired";
  return { ...record, status: next, updatedAt: now };
}
