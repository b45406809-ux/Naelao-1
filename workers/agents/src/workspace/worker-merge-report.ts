export type WorkerMergeConflictDetail = {
  path: string;
  otherPath?: string;
  reason: string;
  baseHash?: string | null;
  targetHash?: string | null;
  sourceHash?: string | null;
};

const validHash = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;

/** Keep a worker's result intact and attach a bounded, content-free merge receipt. */
export function withWorkerMergeConflicts(
  output: unknown,
  conflicts: readonly WorkerMergeConflictDetail[]
): {
  workerOutput: unknown;
  workspaceMerge: {
    status: "unapplied";
    conflicts: Array<{
      path: string;
      otherPath?: string;
      reason: string;
      baseHash: string | null;
      targetHash: string | null;
      sourceHash: string | null;
    }>;
    omitted?: number;
  };
  guidance: string;
} {
  const visible = conflicts.slice(0, 50).map((conflict) => ({
    path:
      typeof conflict.path === "string"
        ? conflict.path.slice(0, 512)
        : "<unknown-path>",
    ...(typeof conflict.otherPath === "string"
      ? { otherPath: conflict.otherPath.slice(0, 512) }
      : {}),
    reason:
      typeof conflict.reason === "string"
        ? conflict.reason.slice(0, 64)
        : "unknown_conflict",
    baseHash: validHash(conflict.baseHash),
    targetHash: validHash(conflict.targetHash),
    sourceHash: validHash(conflict.sourceHash),
  }));
  const omitted = Math.max(0, conflicts.length - visible.length);
  return {
    workerOutput: output ?? null,
    workspaceMerge: {
      status: "unapplied",
      conflicts: visible,
      ...(omitted ? { omitted } : {}),
    },
    guidance:
      "Original worker and target branches are retained. Review the conflicts and integrate only through the checked workspace coordinator.",
  };
}
