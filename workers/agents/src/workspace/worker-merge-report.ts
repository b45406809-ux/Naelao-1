export type WorkerMergeConflictDetail = {
  path: string;
  otherPath?: string;
  reason: string;
  baseHash?: string | null;
  targetHash?: string | null;
  sourceHash?: string | null;
};

export type WorkerMergeReportValidationReceipt = {
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
  runId: string;
  durationMs: number;
  completedAt: string;
  exitCode?: number;
  reason?: string;
  publicationStatus?: "published" | "not_published" | "uncertain";
};

const validHash = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;

/** Keep worker output intact and attach a bounded, content-free integration receipt. */
export function withWorkerMergeConflicts(
  output: unknown,
  conflicts: readonly WorkerMergeConflictDetail[],
  options: { validationReceipts?: readonly WorkerMergeReportValidationReceipt[]; published?: boolean } = {},
): {
  workerOutput: unknown;
  workspaceMerge: {
    status: "unapplied" | "integrated";
    conflicts: Array<{
      path: string;
      otherPath?: string;
      reason: string;
      baseHash: string | null;
      targetHash: string | null;
      sourceHash: string | null;
    }>;
    omitted?: number;
    validationReceipts: WorkerMergeReportValidationReceipt[];
  };
  guidance: string;
} {
  const visible = conflicts.slice(0, 50).map((conflict) => ({
    path: typeof conflict.path === "string" ? conflict.path.slice(0, 512) : "<unknown-path>",
    ...(typeof conflict.otherPath === "string" ? { otherPath: conflict.otherPath.slice(0, 512) } : {}),
    reason: typeof conflict.reason === "string" ? conflict.reason.slice(0, 96) : "unknown_conflict",
    baseHash: validHash(conflict.baseHash),
    targetHash: validHash(conflict.targetHash),
    sourceHash: validHash(conflict.sourceHash),
  }));
  const omitted = Math.max(0, conflicts.length - visible.length);
  const integrated = options.published === true && conflicts.length === 0;
  return {
    workerOutput: output ?? null,
    workspaceMerge: {
      status: integrated ? "integrated" : "unapplied",
      conflicts: visible,
      ...(omitted ? { omitted } : {}),
      validationReceipts: [...(options.validationReceipts ?? [])].slice(-50),
    },
    guidance: integrated
      ? "Worker changes were published only after the project-owned check passed on the pinned integration candidate. The original worker branch is retained."
      : "Original worker and target branches are retained. Review the conflicts and integrate only through the checked workspace coordinator.",
  };
}
