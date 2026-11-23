import { decodeWorkerCheckpoint } from "./worker-checkpoint.js";

export type GoalWorkspaceLineage = {
  branch: string;
  attempt: number;
  base?: { parentBranch: string; revision: number; manifestHash: string };
  lastCheckpoint?: { attempt?: number; savedAt?: number; revision: number; manifestHash: string; freshness: "recorded_not_rechecked" };
  validationReceipts: Array<{
    status: "passed" | "failed" | "uncertain" | "blocked";
    branch: string;
    revision: number;
    manifestHash: string;
    targetRevision: number;
    targetManifestHash: string;
    commandHash: string;
    durationMs: number;
    completedAt: string;
    candidateBranch: string;
    candidateCommitId: string | null;
    sourceBranch: string;
    sourceCommitId: string | null;
    targetBranch: string;
    targetCommitId: string | null;
    publicationStatus: "published" | "not_published" | "uncertain";
    exitCode?: number;
  }>;
  publicationAttempts: Array<{
    attempt: number;
    targetBranch: string;
    targetRevision: number;
    status: "authorized" | "published" | "not_published" | "uncertain" | "outcome_unknown";
    updatedAt: string;
  }>;
};

const branchName = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  && !value.split("/").includes("..");
const manifestHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commitId = (value: unknown): value is string | null => value === null || typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function projectValidationReceipt(value: unknown): GoalWorkspaceLineage["validationReceipts"][number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!(["passed", "failed", "uncertain", "blocked"] as unknown[]).includes(item.status)
    || !branchName(item.branch) || !positiveInteger(item.revision) || !manifestHash(item.manifestHash)
    || !positiveInteger(item.targetRevision) || !manifestHash(item.targetManifestHash)
    || !manifestHash(item.commandHash) || !Number.isSafeInteger(item.durationMs) || Number(item.durationMs) < 0
    || typeof item.completedAt !== "string" || item.completedAt.length > 40 || !Number.isFinite(Date.parse(item.completedAt))
    || !branchName(item.candidateBranch) || !commitId(item.candidateCommitId)
    || !branchName(item.sourceBranch) || !commitId(item.sourceCommitId)
    || !branchName(item.targetBranch) || !commitId(item.targetCommitId)
    || !(["published", "not_published", "uncertain"] as unknown[]).includes(item.publicationStatus)
    || item.exitCode !== undefined && (!Number.isSafeInteger(item.exitCode) || Number(item.exitCode) < -1_000_000 || Number(item.exitCode) > 1_000_000)) return undefined;
  return {
    status: item.status as GoalWorkspaceLineage["validationReceipts"][number]["status"],
    branch: item.branch, revision: Number(item.revision), manifestHash: item.manifestHash,
    targetRevision: Number(item.targetRevision), targetManifestHash: item.targetManifestHash,
    commandHash: item.commandHash, durationMs: Number(item.durationMs), completedAt: item.completedAt,
    candidateBranch: item.candidateBranch, candidateCommitId: item.candidateCommitId,
    sourceBranch: item.sourceBranch, sourceCommitId: item.sourceCommitId,
    targetBranch: item.targetBranch, targetCommitId: item.targetCommitId,
    publicationStatus: item.publicationStatus as GoalWorkspaceLineage["validationReceipts"][number]["publicationStatus"],
    ...(Number.isSafeInteger(item.exitCode) ? { exitCode: Number(item.exitCode) } : {}),
  };
}

function projectPublicationAttempt(value: unknown): GoalWorkspaceLineage["publicationAttempts"][number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!positiveInteger(item.attempt) || !branchName(item.targetBranch) || !positiveInteger(item.targetRevision)
    || !(["authorized", "published", "not_published", "uncertain", "outcome_unknown"] as unknown[]).includes(item.status)
    || typeof item.updatedAt !== "string" || item.updatedAt.length > 40 || !Number.isFinite(Date.parse(item.updatedAt))) return undefined;
  return { attempt: Number(item.attempt), targetBranch: item.targetBranch, targetRevision: Number(item.targetRevision),
    status: item.status as GoalWorkspaceLineage["publicationAttempts"][number]["status"], updatedAt: item.updatedAt };
}

/** Project only bounded branch/revision and checked-integration metadata; never worker output. */
export function projectGoalWorkspaceLineage(input: {
  branch: unknown;
  attempt: unknown;
  branchOrigin: unknown;
  checkpointJson: string | null;
  validationReceipts: unknown;
  publicationAttempts: unknown;
}): GoalWorkspaceLineage | undefined {
  if (!branchName(input.branch) || !input.branch.startsWith("workers/") || !positiveInteger(input.attempt)) return undefined;
  const view: GoalWorkspaceLineage = { branch: input.branch, attempt: Number(input.attempt), validationReceipts: [], publicationAttempts: [] };

  if (input.branchOrigin && typeof input.branchOrigin === "object" && !Array.isArray(input.branchOrigin)) {
    const origin = input.branchOrigin as Record<string, unknown>;
    if (origin.branch === input.branch && branchName(origin.parentBranch) && positiveInteger(origin.revision) && manifestHash(origin.manifestHash)) {
      view.base = { parentBranch: origin.parentBranch, revision: Number(origin.revision), manifestHash: origin.manifestHash };
    }
  }

  const checkpoint = decodeWorkerCheckpoint(input.checkpointJson);
  const pin = checkpoint?.workspacePin;
  if (pin && pin.branch === input.branch && Number.isSafeInteger(pin.revision) && pin.revision >= 0 && manifestHash(pin.manifestHash)) {
    view.lastCheckpoint = {
      ...(checkpoint.attempt !== undefined ? { attempt: checkpoint.attempt } : {}),
      ...(checkpoint.savedAt !== undefined ? { savedAt: checkpoint.savedAt } : {}),
      revision: pin.revision,
      manifestHash: pin.manifestHash,
      freshness: "recorded_not_rechecked",
    };
  }

  if (Array.isArray(input.validationReceipts)) {
    view.validationReceipts = input.validationReceipts.slice(-10).flatMap(item => {
      const receipt = projectValidationReceipt(item);
      return receipt ? [receipt] : [];
    });
  }
  if (Array.isArray(input.publicationAttempts)) {
    view.publicationAttempts = input.publicationAttempts.slice(-10).flatMap(item => {
      const attempt = projectPublicationAttempt(item);
      return attempt ? [attempt] : [];
    });
  }
  return view;
}
