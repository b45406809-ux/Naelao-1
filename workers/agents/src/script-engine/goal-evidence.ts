/** Evidence must be constructed by the host from independently executed checks. */
export interface GoalEvidence {
  criterion: string;
  source: "host_check" | "human_review";
  outcome: "passed" | "failed" | "uncertain";
  reference: string;
}

/** A check names a host-provided operation, never executable code from a worker. */
export interface GoalEvidenceCheck { criterion: string; operation: string }
const CHECK_SPEC = /^(?:artifact\.sha256|workspace\.exists|workspace\.sha256):([^\s]{1,256})$/;
export function validateGoalEvidenceChecks(criteria: readonly string[], checks: readonly GoalEvidenceCheck[]): GoalEvidenceCheck[] {
  if (checks.length > 8 || new Set(checks.map(check => check?.criterion)).size !== checks.length || checks.some(check => !check || !criteria.includes(check.criterion) || typeof check.operation !== "string" || !CHECK_SPEC.test(check.operation))) throw new Error("invalid_goal_evidence_checks");
  return checks.map(check => ({ criterion: check.criterion, operation: check.operation }));
}

export interface WorkerArtifactManifest {
  version: 1;
  tenantId: string;
  spaceId: string;
  projectId: string | null;
  parentRunId: string;
  workerId: string;
  attempt: number;
  branch: string;
  capturedAt: number;
  artifacts: Array<{ path: string; status: "captured" | "missing" | "too_large" | "unavailable"; hash?: string; etag?: string; bytes?: number }>;
}

export interface ArtifactReadPort {
  head(path: string): Promise<{ size: number; etag: string; deleted?: boolean } | null>;
  read(path: string, maximumBytes: number): Promise<{ bytes: Uint8Array; etag: string } | null>;
}

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 32;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** Capture a bounded, immutable view of declared paths. A changing R2 object is uncertain. */
export async function captureWorkerArtifactManifest(input: Omit<WorkerArtifactManifest, "version" | "capturedAt" | "artifacts"> & { paths: readonly string[] }, port: ArtifactReadPort, now = Date.now()): Promise<WorkerArtifactManifest> {
  if (!input.tenantId || !input.spaceId || !input.parentRunId || !input.workerId || !input.branch || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.paths.length > MAX_ARTIFACTS) throw new Error("invalid_worker_artifact_manifest_scope");
  const artifacts: WorkerArtifactManifest["artifacts"] = [];
  for (const path of [...new Set(input.paths)].slice(0, MAX_ARTIFACTS)) {
    if (!path || path.length > 256 || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid_worker_artifact_path");
    try {
      const before = await port.head(path);
      if (!before || before.deleted) { artifacts.push({ path, status: "missing" }); continue; }
      if (!Number.isSafeInteger(before.size) || before.size < 0) { artifacts.push({ path, status: "unavailable" }); continue; }
      if (before.size > MAX_ARTIFACT_BYTES) { artifacts.push({ path, status: "too_large" }); continue; }
      const read = await port.read(path, MAX_ARTIFACT_BYTES);
      if (!read || read.etag !== before.etag || read.bytes.byteLength !== before.size || read.bytes.byteLength > MAX_ARTIFACT_BYTES) { artifacts.push({ path, status: "unavailable" }); continue; }
      const after = await port.head(path);
      if (!after || after.etag !== before.etag || after.size !== before.size) { artifacts.push({ path, status: "unavailable" }); continue; }
      artifacts.push({ path, status: "captured", hash: await sha256(read.bytes), etag: read.etag, bytes: read.bytes.byteLength });
    } catch { artifacts.push({ path, status: "unavailable" }); }
  }
  return { version: 1, tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId, parentRunId: input.parentRunId, workerId: input.workerId, attempt: input.attempt, branch: input.branch, capturedAt: now, artifacts };
}

/** Compare current scoped bytes with the exact captured version; never trust a branch name alone. */
export async function verifyWorkerArtifact(manifest: WorkerArtifactManifest, path: string, port: ArtifactReadPort, expected: Pick<WorkerArtifactManifest, "tenantId" | "spaceId" | "projectId" | "parentRunId" | "workerId" | "attempt" | "branch">): Promise<{ outcome: "passed" | "failed" | "uncertain"; reference: string }> {
  if (manifest.artifacts.length > MAX_ARTIFACTS || manifest.artifacts.some(item => item.path.length > 256 || (item.bytes ?? 0) > MAX_ARTIFACT_BYTES)) return { outcome: "uncertain", reference: "manifest_bounds_invalid" };
  if (["tenantId", "spaceId", "projectId", "parentRunId", "workerId", "attempt", "branch"].some(key => manifest[key as keyof WorkerArtifactManifest] !== expected[key as keyof typeof expected])) return { outcome: "uncertain", reference: "manifest_scope_mismatch" };
  const entry = manifest.artifacts.find(item => item.path === path);
  if (!entry || entry.status !== "captured" || !entry.hash || !HASH.test(entry.hash) || !entry.etag) return { outcome: "uncertain", reference: `artifact:${path}:uncaptured` };
  try {
    const before = await port.head(path);
    if (!before || before.deleted) return { outcome: "uncertain", reference: `artifact:${path}:missing` };
    if (before.etag !== entry.etag || before.size !== entry.bytes) return { outcome: "uncertain", reference: `artifact:${path}:changed` };
    const current = await port.read(path, MAX_ARTIFACT_BYTES);
    const after = await port.head(path);
    if (!current || !after || current.etag !== entry.etag || after.etag !== entry.etag || current.bytes.byteLength !== entry.bytes || await sha256(current.bytes) !== entry.hash) return { outcome: "uncertain", reference: `artifact:${path}:changed` };
    return { outcome: "passed", reference: `artifact:${path}:sha256:${entry.hash}` };
  } catch { return { outcome: "uncertain", reference: `artifact:${path}:unavailable` }; }
}

export async function collectGoalEvidence(
  criteria: readonly string[], checks: readonly GoalEvidenceCheck[],
  runAuthorizedCheck: (operation: string) => Promise<{ outcome: "passed" | "failed" | "uncertain"; reference: string }>,
): Promise<GoalEvidence[]> {
  validateGoalEvidenceChecks(criteria, checks);
  const evidence: GoalEvidence[] = [];
  for (const check of checks) {
    let result: { outcome: "passed" | "failed" | "uncertain"; reference: string };
    try { result = await runAuthorizedCheck(check.operation); } catch { result = { outcome: "uncertain", reference: "host_check:unavailable" }; }
    if (!result || !["passed", "failed", "uncertain"].includes(result.outcome) || typeof result.reference !== "string" || !result.reference.trim() || result.reference.length > 500) result = { outcome: "uncertain", reference: "host_check:invalid_result" };
    evidence.push({ criterion: check.criterion, source: "host_check", outcome: result.outcome, reference: result.reference });
  }
  return evidence;
}

/** Evaluate only host-supplied evidence; worker claims are not evidence. */
export function evaluateGoalEvidence(criteria: readonly string[], evidence: readonly GoalEvidence[]): { outcome: "passed" | "failed" | "uncertain"; reason: string } {
  if (!criteria.length || criteria.length > 8 || criteria.some(c => typeof c !== "string" || !c.trim() || c.length > 500)) return { outcome: "uncertain", reason: "Acceptance criteria are missing or invalid" };
  if (new Set(criteria).size !== criteria.length || evidence.length > 64) return { outcome: "uncertain", reason: "Evidence or criteria are ambiguous" };
  for (const item of evidence) {
    if (!item || !criteria.includes(item.criterion) || !["host_check", "human_review"].includes(item.source) || !["passed", "failed", "uncertain"].includes(item.outcome) || typeof item.reference !== "string" || !item.reference.trim() || item.reference.length > 500) return { outcome: "uncertain", reason: "Invalid evidence" };
  }
  if (evidence.some(item => item.outcome === "failed")) return { outcome: "failed", reason: "An independent check failed" };
  if (criteria.some(criterion => !evidence.some(item => item.criterion === criterion && item.outcome === "passed") || evidence.some(item => item.criterion === criterion && item.outcome === "uncertain"))) return { outcome: "uncertain", reason: "Independent evidence is incomplete or uncertain" };
  return { outcome: "passed", reason: "Every criterion has independent passing evidence" };
}
