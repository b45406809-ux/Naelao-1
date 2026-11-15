import { isWorkspaceManualValidationCommand } from "./workspace-manual-resolution.js";

export const WORKER_VALIDATION_CONFIG_PATH = "naelao-worker-validation.json";
export const WORKER_VALIDATION_CONFIG_MAX_BYTES = 4 * 1024;

export type WorkerIntegrationHead = {
  branch: string;
  commitId: string | null;
  revision: number;
  manifestHash: string;
  branchBase?: { parentBranch: string; revision: number; manifestHash: string };
};

export type WorkerIntegrationBranchBase = {
  parentBranch: string;
  revision: number;
  manifestHash: string;
};

export type WorkerIntegrationValidationReceipt = {
  path: typeof WORKER_VALIDATION_CONFIG_PATH;
  paths: [typeof WORKER_VALIDATION_CONFIG_PATH];
  status: "passed" | "failed" | "uncertain" | "blocked";
  branch: string;
  revision: number;
  manifestHash: string;
  targetRevision: number;
  targetManifestHash: string;
  commandHash: string;
  executionId: string;
  runId: string;
  durationMs: number;
  completedAt: string;
  exitCode?: number;
  reason?: string;
  candidateBranch: string;
  candidateCommitId: string | null;
  sourceBranch: string;
  sourceCommitId: string | null;
  targetBranch: string;
  targetCommitId: string | null;
  publicationStatus: "published" | "not_published" | "uncertain";
};

export type WorkerIntegrationConflict = { path: string; reason: string };

export type WorkerIntegrationResult = {
  status: "published" | "blocked" | "conflicted" | "uncertain";
  conflicts: WorkerIntegrationConflict[];
  receipt: WorkerIntegrationValidationReceipt;
};

export type WorkerIntegrationValidationRun = {
  status: WorkerIntegrationValidationReceipt["status"];
  exitCode?: number;
  durationMs: number;
  reason?: string;
};

export type WorkerIntegrationHost = {
  readHead(branch: string): Promise<WorkerIntegrationHead | null>;
  readProjectValidationConfig(targetBranch: string, targetCommitId: string): Promise<string | null>;
  createBranch(branch: string, sourceBranch: string, sourceCommitId: string): Promise<void>;
  mergeCandidate(input: { targetBranch: string; sourceBranch: string; expectedTargetCommitId: string; expectedSourceCommitId: string }): Promise<{ conflicts?: WorkerIntegrationConflict[] }>;
  runValidation(input: { command: string; commandHash: string; branch: string; revision: number; manifestHash: string }): Promise<WorkerIntegrationValidationRun>;
  publishCandidate(input: { targetBranch: string; candidateBranch: string; expectedTarget: WorkerIntegrationHead; expectedSourceCommitId: string }): Promise<void>;
  saveReceipt(receipt: WorkerIntegrationValidationReceipt): Promise<void>;
};

const HASH = /^[a-f0-9]{64}$/;
const validHead = (head: WorkerIntegrationHead | null, branch: string): head is WorkerIntegrationHead => Boolean(head &&
  head.branch === branch && (head.commitId === null || /^[a-f0-9]{40}$/.test(head.commitId)) &&
  Number.isSafeInteger(head.revision) && head.revision >= 1 && HASH.test(head.manifestHash) &&
  (!head.branchBase || head.branchBase.parentBranch.length > 0 && Number.isSafeInteger(head.branchBase.revision) &&
    head.branchBase.revision >= 1 && HASH.test(head.branchBase.manifestHash)));

export function parseWorkerValidationConfig(text: string | null): { command: string } | null {
  if (text === null || new TextEncoder().encode(text).byteLength > WORKER_VALIDATION_CONFIG_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "schema_version" && key !== "command") ||
      record.schema_version !== 1 || !isWorkspaceManualValidationCommand(record.command)) return null;
  return { command: record.command };
}

const sameHead = (left: WorkerIntegrationHead | null, right: WorkerIntegrationHead): boolean => Boolean(left &&
  left.branch === right.branch && left.commitId === right.commitId && left.revision === right.revision &&
  left.manifestHash === right.manifestHash && JSON.stringify(left.branchBase ?? null) === JSON.stringify(right.branchBase ?? null));

export async function runCheckedWorkerIntegration(input: {
  targetBranch: string;
  sourceBranch: string;
  candidateBranch: string;
  validationBranch: string;
  executionId: string;
  runId: string;
  pinnedTarget: WorkerIntegrationHead;
  pinnedSource: WorkerIntegrationHead;
  expectedSourceBase: WorkerIntegrationBranchBase;
}, host: WorkerIntegrationHost): Promise<WorkerIntegrationResult> {
  const started = Date.now();
  const target = await host.readHead(input.targetBranch);
  const source = await host.readHead(input.sourceBranch);
  if (!validHead(target, input.targetBranch) || !validHead(source, input.sourceBranch) ||
      !validHead(input.pinnedTarget, input.targetBranch) || !validHead(input.pinnedSource, input.sourceBranch) ||
      !sameHead(target, input.pinnedTarget) || !sameHead(source, input.pinnedSource) || !target.commitId || !source.commitId) {
    throw new Error("worker_integration_pinned_heads_invalid");
  }

  const targetRevision = target.revision;
  const targetManifestHash = target.manifestHash;
  let command = "";
  let commandHash = "";
  let candidate: WorkerIntegrationHead | null = null;
  let validation: WorkerIntegrationHead | null = null;
  let status: WorkerIntegrationValidationReceipt["status"] = "blocked";
  let publicationStatus: WorkerIntegrationValidationReceipt["publicationStatus"] = "not_published";
  let reason: string | undefined;
  let exitCode: number | undefined;
  let validationDurationMs = 0;
  const receipt = (): WorkerIntegrationValidationReceipt => ({
    path: WORKER_VALIDATION_CONFIG_PATH,
    paths: [WORKER_VALIDATION_CONFIG_PATH],
    status,
    branch: validation?.branch ?? input.validationBranch,
    revision: validation?.revision ?? target.revision,
    manifestHash: validation?.manifestHash ?? target.manifestHash,
    targetRevision,
    targetManifestHash,
    commandHash: commandHash || "0".repeat(64),
    executionId: input.executionId,
    runId: input.runId,
    durationMs: Math.max(0, validationDurationMs || Date.now() - started),
    completedAt: new Date().toISOString(),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(reason ? { reason } : {}),
    candidateBranch: input.candidateBranch,
    candidateCommitId: candidate?.commitId ?? null,
    sourceBranch: source.branch,
    sourceCommitId: source.commitId,
    targetBranch: target.branch,
    targetCommitId: target.commitId,
    publicationStatus,
  });
  const finish = async (resultStatus: WorkerIntegrationResult["status"], conflicts: WorkerIntegrationConflict[] = []): Promise<WorkerIntegrationResult> => {
    const value = receipt();
    await host.saveReceipt(value);
    return { status: resultStatus, conflicts: conflicts.slice(0, 50), receipt: value };
  };

  if (!Number.isSafeInteger(input.expectedSourceBase.revision) || input.expectedSourceBase.revision < 1 ||
      !HASH.test(input.expectedSourceBase.manifestHash) || source.branchBase?.parentBranch !== input.expectedSourceBase.parentBranch ||
      source.branchBase.revision !== input.expectedSourceBase.revision || source.branchBase.manifestHash !== input.expectedSourceBase.manifestHash) {
    reason = "worker_source_base_mismatch";
    return finish("blocked", [{ path: "<worker-branch-base>", reason }]);
  }

  const rawConfig = await host.readProjectValidationConfig(input.targetBranch, target.commitId);
  const contract = parseWorkerValidationConfig(rawConfig);
  if (!contract) {
    reason = rawConfig === null ? "project_validation_not_configured" : "project_validation_config_invalid";
    return finish("blocked", [{ path: WORKER_VALIDATION_CONFIG_PATH, reason }]);
  }
  command = contract.command;
  commandHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(command)))].map(byte => byte.toString(16).padStart(2, "0")).join("");

  await host.createBranch(input.candidateBranch, input.targetBranch, target.commitId);
  const candidateBase = await host.readHead(input.candidateBranch);
  if (!validHead(candidateBase, input.candidateBranch) || candidateBase.commitId !== target.commitId ||
      candidateBase.manifestHash !== target.manifestHash || candidateBase.branchBase?.parentBranch !== input.targetBranch ||
      candidateBase.branchBase.revision !== target.revision || candidateBase.branchBase.manifestHash !== target.manifestHash) {
    reason = "candidate_base_mismatch";
    return finish("blocked");
  }
  const merge = await host.mergeCandidate({ targetBranch: input.candidateBranch, sourceBranch: input.sourceBranch,
    expectedTargetCommitId: candidateBase.commitId!, expectedSourceCommitId: source.commitId });
  if (merge.conflicts?.length) {
    reason = "integration_conflict";
    return finish("conflicted", merge.conflicts);
  }
  candidate = await host.readHead(input.candidateBranch);
  if (!validHead(candidate, input.candidateBranch) || !candidate.commitId || candidate.revision < candidateBase.revision ||
      candidate.branchBase?.parentBranch !== target.branch || candidate.branchBase.revision !== target.revision ||
      candidate.branchBase.manifestHash !== target.manifestHash) {
    reason = "candidate_merge_result_mismatch";
    return finish("blocked");
  }
  const candidateConfig = parseWorkerValidationConfig(await host.readProjectValidationConfig(candidate.branch, candidate.commitId));
  if (!candidateConfig || candidateConfig.command !== command) {
    reason = "validation_contract_changed_requires_review";
    return finish("blocked", [{ path: WORKER_VALIDATION_CONFIG_PATH, reason }]);
  }

  await host.createBranch(input.validationBranch, input.candidateBranch, candidate.commitId!);
  validation = await host.readHead(input.validationBranch);
  if (!validHead(validation, input.validationBranch) || validation.commitId !== candidate.commitId || validation.manifestHash !== candidate.manifestHash ||
      validation.branchBase?.parentBranch !== input.candidateBranch || validation.branchBase.revision !== candidate.revision ||
      validation.branchBase.manifestHash !== candidate.manifestHash) {
    reason = "validation_branch_base_mismatch";
    return finish("blocked");
  }

  const validationRun = await host.runValidation({ command, commandHash, branch: validation.branch,
    revision: validation.revision, manifestHash: validation.manifestHash });
  status = validationRun.status;
  exitCode = validationRun.exitCode;
  reason = validationRun.reason;
  validationDurationMs = validationRun.durationMs;

  const [targetAfter, sourceAfter, candidateAfter, validationAfter] = await Promise.all([
    host.readHead(input.targetBranch), host.readHead(input.sourceBranch),
    host.readHead(input.candidateBranch), host.readHead(input.validationBranch),
  ]);
  if (!sameHead(targetAfter, target) || !sameHead(sourceAfter, source) || !sameHead(candidateAfter, candidate) || !sameHead(validationAfter, validation)) {
    status = "blocked";
    reason = "integration_head_changed_or_validation_modified_workspace";
    return finish("blocked");
  }
  if (status !== "passed" || !Number.isSafeInteger(validationRun.durationMs) || validationRun.durationMs < 0 || validationRun.exitCode !== 0) {
    if (status === "passed") { status = "blocked"; reason = "validation_receipt_invalid"; }
    return finish(status === "failed" ? "blocked" : status === "uncertain" ? "uncertain" : "blocked");
  }

  status = "passed";
  // Persist the exact successful candidate receipt before the checked target publication.
  await host.saveReceipt(receipt());
  try {
    await host.publishCandidate({ targetBranch: input.targetBranch, candidateBranch: input.candidateBranch,
      expectedTarget: target, expectedSourceCommitId: candidate.commitId! });
    publicationStatus = "published";
    return finish("published");
  } catch {
    const after = await host.readHead(input.targetBranch).catch(() => null);
    if (validHead(after, input.targetBranch) && after.commitId === candidate.commitId && after.manifestHash === candidate.manifestHash) {
      publicationStatus = "published";
      return finish("published");
    }
    if (sameHead(after, target)) {
      status = "blocked";
      reason = "target_publication_rejected";
      return finish("blocked");
    }
    status = "uncertain";
    publicationStatus = "uncertain";
    reason = "target_publication_outcome_uncertain";
    return finish("uncertain");
  }
}
