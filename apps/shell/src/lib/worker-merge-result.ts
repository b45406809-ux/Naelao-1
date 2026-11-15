export type WorkerMergeConflictView = {
  path: string;
  otherPath?: string;
  reason: string;
  baseHash: string | null;
  targetHash: string | null;
  sourceHash: string | null;
};

export type WorkerManualValidationView = {
  path: string;
  paths: string[];
  status: "passed" | "failed" | "uncertain" | "blocked";
  branch: string;
  revision: number;
  manifestHash: string;
  targetRevision: number;
  targetManifestHash: string;
  commandHash: string;
  executionId: string;
  publicationStatus?: "published" | "not_published" | "uncertain";
  durationMs: number;
  completedAt: string;
  exitCode?: number;
  reason?: string;
};

export type WorkerMergeResultView = {
  workerOutput: unknown;
  /** Paths reported by the worker; these are advisory and are not a verified diff. */
  modifiedFiles: string[];
  workspaceMerge: {
    status: "unapplied" | "partially_resolved" | "manually_resolved" | "integrated";
    conflicts: WorkerMergeConflictView[];
    omitted: number;
    manualResolutions: Array<{
      path: string;
      paths: string[];
      deletedPaths: string[];
      copiedVersions: Array<{ path: string; from: "target" | "worker"; hash: string }>;
      status: "published" | "noop";
      revision: number;
      reviewBranch: string;
      completedAt: string;
      deleted: boolean;
      validation: WorkerManualValidationView | null;
    }>;
    validationReceipts: WorkerManualValidationView[];
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeHash = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;

const safeReportedPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith("/") &&
  !value.split(/[\\/]/u).some(part => part === ".." || part === "");

const parseValidationReceipt = (value: unknown): WorkerManualValidationView | null => {
  const paths = record(value) ? (Array.isArray(value.paths) ? value.paths : [value.path]) : [];
  if (!record(value) || !safeReportedPath(value.path) || !["passed", "failed", "uncertain", "blocked"].includes(String(value.status)) ||
      paths.length < 1 || paths.length > 2 || paths.some(path => !safeReportedPath(path)) || new Set(paths).size !== paths.length || !paths.includes(value.path) ||
      typeof value.branch !== "string" || value.branch.length > 128 || !Number.isSafeInteger(value.revision) ||
      typeof value.manifestHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.manifestHash) ||
      !Number.isSafeInteger(value.targetRevision) || Number(value.targetRevision) < 1 ||
      typeof value.targetManifestHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.targetManifestHash) ||
      typeof value.commandHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.commandHash) ||
      value.executionId !== undefined && (typeof value.executionId !== "string" || value.executionId.length < 1 || value.executionId.length > 128) ||
      !Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0 || typeof value.completedAt !== "string") return null;
  return { path: value.path, paths: paths as string[], status: value.status as WorkerManualValidationView["status"], branch: value.branch,
    revision: Number(value.revision), manifestHash: value.manifestHash.toLowerCase(), commandHash: value.commandHash.toLowerCase(),
    targetRevision: Number(value.targetRevision), targetManifestHash: value.targetManifestHash.toLowerCase(),
    executionId: typeof value.executionId === "string" ? value.executionId : `legacy-${value.branch}-${value.revision}`.slice(0, 128),
    ...(value.publicationStatus === "published" || value.publicationStatus === "not_published" || value.publicationStatus === "uncertain"
      ? { publicationStatus: value.publicationStatus } : {}),
    durationMs: Number(value.durationMs), completedAt: value.completedAt.slice(0, 64),
    ...(Number.isSafeInteger(value.exitCode) ? { exitCode: Number(value.exitCode) } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 100) } : {}) };
};

/** Decode the bounded worker result envelope without trusting arbitrary stored JSON fields. */
export function parseWorkerMergeResult(
  serialized: string
): WorkerMergeResultView | null {
  if (serialized.length > 128 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!record(value) || !record(value.workspaceMerge)) return null;
  const workspaceMerge = value.workspaceMerge;
  if (
    !["unapplied", "partially_resolved", "manually_resolved", "integrated"].includes(
      String(workspaceMerge.status)
    ) ||
    !Array.isArray(workspaceMerge.conflicts)
  )
    return null;
  const rawConflicts = workspaceMerge.conflicts.slice(0, 50);
  const conflicts = rawConflicts.flatMap((item): WorkerMergeConflictView[] => {
    if (
      !record(item) ||
      typeof item.path !== "string" ||
      typeof item.reason !== "string"
    )
      return [];
    return [
      {
        path: item.path.slice(0, 512),
        ...(typeof item.otherPath === "string"
          ? { otherPath: item.otherPath.slice(0, 512) }
          : {}),
        reason: item.reason.slice(0, 64),
        baseHash: safeHash(item.baseHash),
        targetHash: safeHash(item.targetHash),
        sourceHash: safeHash(item.sourceHash),
      },
    ];
  });
  const modifiedFiles = Array.isArray(value.modifiedFiles)
    ? [...new Set(value.modifiedFiles.filter(safeReportedPath))].slice(0, 100)
    : [];
  const reportedOmitted =
    Number.isSafeInteger(workspaceMerge.omitted) &&
    Number(workspaceMerge.omitted) > 0
      ? Math.min(Number(workspaceMerge.omitted), 1_000_000)
      : 0;
  const manualResolutions = Array.isArray(workspaceMerge.manualResolutions)
    ? workspaceMerge.manualResolutions
        .slice(-50)
        .flatMap(
          (
            item
          ): WorkerMergeResultView["workspaceMerge"]["manualResolutions"] => {
            if (
              !record(item) ||
              typeof item.path !== "string" ||
              !["published", "noop"].includes(String(item.status)) ||
              !Number.isSafeInteger(item.revision) ||
              typeof item.reviewBranch !== "string" ||
              typeof item.completedAt !== "string"
            )
              return [];
            const paths = Array.isArray(item.paths) ? item.paths : [item.path];
            if (paths.length < 1 || paths.length > 2 || paths.some(path => !safeReportedPath(path)) || new Set(paths).size !== paths.length || !paths.includes(item.path)) return [];
            const deletedPaths = Array.isArray(item.deletedPaths) ? item.deletedPaths : item.deleted === true ? [item.path] : [];
            if (deletedPaths.some(path => !safeReportedPath(path) || !paths.includes(path)) || new Set(deletedPaths).size !== deletedPaths.length) return [];
            let copiedVersions: Array<{ path: string; from: "target" | "worker"; hash: string }> = [];
            if (item.copiedVersions !== undefined) {
              if (!Array.isArray(item.copiedVersions) || item.copiedVersions.length > 2) return [];
              copiedVersions = item.copiedVersions.flatMap((copy): Array<{ path: string; from: "target" | "worker"; hash: string }> =>
                record(copy) && safeReportedPath(copy.path) && paths.includes(copy.path) &&
                  (copy.from === "target" || copy.from === "worker") && safeHash(copy.hash)
                  ? [{ path: copy.path, from: copy.from, hash: safeHash(copy.hash)! }]
                  : []);
              if (copiedVersions.length !== item.copiedVersions.length || new Set(copiedVersions.map(copy => copy.path)).size !== copiedVersions.length) return [];
            }
            const validation = parseValidationReceipt(item.validation);
            return [
              {
                path: item.path.slice(0, 512),
                paths: paths as string[],
                deletedPaths: deletedPaths as string[],
                copiedVersions,
                status: item.status as "published" | "noop",
                revision: Number(item.revision),
                reviewBranch: item.reviewBranch.slice(0, 128),
                completedAt: item.completedAt.slice(0, 64),
                deleted: item.deleted === true,
                validation: validation?.status === "passed" ? validation : null,
              },
            ];
          }
        )
    : [];
  const validationReceipts = Array.isArray(workspaceMerge.validationReceipts)
    ? workspaceMerge.validationReceipts.slice(-50).flatMap(item => {
        const receipt = parseValidationReceipt(item);
        return receipt ? [receipt] : [];
      })
    : [];
  if (!conflicts.length && workspaceMerge.status !== "integrated" && !manualResolutions.length && !validationReceipts.length) return null;
  return {
    workerOutput: value.workerOutput ?? null,
    modifiedFiles,
    workspaceMerge: {
      status:
        workspaceMerge.status as WorkerMergeResultView["workspaceMerge"]["status"],
      conflicts,
      manualResolutions,
      validationReceipts,
      omitted:
        reportedOmitted +
        Math.max(0, workspaceMerge.conflicts.length - rawConflicts.length) +
        (rawConflicts.length - conflicts.length),
    },
  };
}

export function formatWorkerOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output, null, 2) ?? "";
  } catch {
    return "Worker output could not be displayed.";
  }
}
