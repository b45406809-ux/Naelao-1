import { issueScopedCapabilityToken, verifyScopedCapabilityToken } from "@naelao/security";
import { normalizeWorkspacePath } from "./workspace-paths.js";

/** Host-signed execution identity. No conversational history is part of this contract. */
export interface DelegationContract {
  tenantId: string; spaceId: string; projectId?: string; actorId: string; agentId: string;
  rootRunId: string; parentRunId: string; parentDoId: string; workerId: string;
  depth: 2 | 3; planner: boolean; maxTokens: number; maxSteps: number;
  model: string; role: string; callerRole: string; workspaceBranch?: string;
  /** Exact project files a task worker may access through the host VFS. [] means none. */
  filePaths?: string[];
  maxTier: number; localOnly: boolean; localModelMachine?: string;
}
function resource(contract: DelegationContract): string {
  for (const value of [contract.actorId, contract.agentId, contract.rootRunId, contract.parentRunId, contract.parentDoId, contract.workerId, contract.model, contract.role, contract.callerRole]) {
    if (typeof value !== "string" || !value || value.length > 192) throw new Error("delegation_identity_invalid");
  }
  if (!Number.isInteger(contract.maxTier) || contract.maxTier < 1 || contract.maxTier > 6 || typeof contract.localOnly !== "boolean" || (contract.localModelMachine !== undefined && (typeof contract.localModelMachine !== "string" || !contract.localModelMachine))
    || ![2, 3].includes(contract.depth) || typeof contract.planner !== "boolean" || (contract.depth === 3 && contract.planner)
    || !Number.isSafeInteger(contract.maxTokens) || contract.maxTokens < 1 || contract.maxTokens > 2000
    || !Number.isSafeInteger(contract.maxSteps) || contract.maxSteps < 1 || contract.maxSteps > 100) throw new Error("delegation_budget_or_depth_invalid");
  if (contract.filePaths !== undefined) {
    if (!Array.isArray(contract.filePaths) || contract.filePaths.length > 128) throw new Error("delegation_file_scope_invalid");
    const paths = contract.filePaths.map(path => {
      if (typeof path !== "string" || path.length > 512) throw new Error("delegation_file_scope_invalid");
      return normalizeWorkspacePath(path);
    });
    if (new Set(paths).size !== paths.length) throw new Error("delegation_file_scope_invalid");
  }
  // Fixed order includes every field used to grant child execution permissions.
  return JSON.stringify([contract.agentId, contract.rootRunId, contract.parentRunId, contract.parentDoId, contract.workerId,
    contract.depth, contract.planner, contract.maxTokens, contract.maxSteps, contract.model, contract.role, contract.callerRole, contract.workspaceBranch ?? null, contract.maxTier, contract.localOnly, contract.localModelMachine ?? null, contract.filePaths === undefined ? null : [...contract.filePaths].sort()]);
}
const context = (contract: DelegationContract) => ({ tenantId: contract.tenantId, spaceId: contract.spaceId,
  ...(contract.projectId ? { projectId: contract.projectId } : {}), actorId: contract.actorId,
  issuer: "naelao-agent-host", audience: "naelao-child-agent", operation: "worker.execute", resource: resource(contract), revocationEpoch: 0 });
export async function issueDelegationContract(contract: DelegationContract, secret: string): Promise<string> {
  return issueScopedCapabilityToken({ ...context(contract), ttlSeconds: 900 }, secret);
}
export async function verifyDelegationContract(contract: DelegationContract, token: string, secret: string): Promise<void> {
  await verifyScopedCapabilityToken(token, secret, context(contract));
}
export function childFanout(depth: 1 | 2 | 3, planner: boolean): number {
  return planner ? depth === 1 ? 4 : depth === 2 ? 3 : 0 : 0;
}
