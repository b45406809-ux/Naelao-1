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
  workspaceMerge: {
    status: "unapplied";
    conflicts: WorkerMergeConflictView[];
    omitted: number;
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeHash = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;

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
    workspaceMerge.status !== "unapplied" ||
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
  const reportedOmitted =
    Number.isSafeInteger(workspaceMerge.omitted) &&
    Number(workspaceMerge.omitted) > 0
      ? Math.min(Number(workspaceMerge.omitted), 1_000_000)
      : 0;
  return {
    workerOutput: value.workerOutput ?? null,
    workspaceMerge: {
      status: "unapplied",
      conflicts,
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
