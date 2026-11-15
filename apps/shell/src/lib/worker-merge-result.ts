export type WorkerMergeConflictView = {
  path: string;
  otherPath?: string;
  reason: string;
  baseHash: string | null;
  targetHash: string | null;
  sourceHash: string | null;
};

export type WorkerMergeResultView = {
  workerOutput: unknown;
  /** Paths reported by the worker; these are advisory and are not a verified diff. */
  modifiedFiles: string[];
  workspaceMerge: {
    status: "unapplied" | "partially_resolved" | "manually_resolved";
    conflicts: WorkerMergeConflictView[];
    omitted: number;
    manualResolutions: Array<{
      path: string;
      status: "published" | "noop";
      revision: number;
      reviewBranch: string;
      completedAt: string;
      deleted: boolean;
    }>;
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
    !["unapplied", "partially_resolved", "manually_resolved"].includes(
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
  if (!conflicts.length) return null;
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
            return [
              {
                path: item.path.slice(0, 512),
                status: item.status as "published" | "noop",
                revision: Number(item.revision),
                reviewBranch: item.reviewBranch.slice(0, 128),
                completedAt: item.completedAt.slice(0, 64),
                deleted: item.deleted === true,
              },
            ];
          }
        )
    : [];
  return {
    workerOutput: value.workerOutput ?? null,
    modifiedFiles,
    workspaceMerge: {
      status:
        workspaceMerge.status as WorkerMergeResultView["workspaceMerge"]["status"],
      conflicts,
      manualResolutions,
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
