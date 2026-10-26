import type { ScriptEngineEnv } from "./types.js";
import { workspacePrefix } from "./types.js";
import { assertWorkspaceFileAllowed } from "./workspace-paths.js";
import { publishWorkspaceBytesCas, readBytesWithHash } from "./r2-cas.js";

const MAX_BYTES = 1024 * 1024;
function artifactKey(env: ScriptEngineEnv, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("environment_artifact_digest_invalid");
  // Workspace prefix contains the host's tenant/Space/project/assistant/branch boundary.
  // Caller supplies a digest, never an arbitrary bucket key or destination scope.
  return workspacePrefix(env) + ".environment-artifacts/" + digest;
}
export async function publishEnvironmentArtifact(env: ScriptEngineEnv, path: string) {
  const clean = assertWorkspaceFileAllowed(env.workspaceFileScope, path);
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const source = await readBytesWithHash(bucket, workspacePrefix(env) + clean, MAX_BYTES);
  if (!source) throw new Error("environment_artifact_source_missing");
  const key = artifactKey(env, source.hash);
  const stored = await bucket.put(key, source.bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: source.hash, sourcePath: clean } });
  if (!stored) {
    const existing = await readBytesWithHash(bucket, key, MAX_BYTES);
    if (existing?.hash !== source.hash) throw new Error("environment_artifact_integrity_failed");
  }
  return { digest: source.hash, bytes: source.bytes.byteLength, source_path: clean, immutable: true };
}
export async function restoreEnvironmentArtifact(env: ScriptEngineEnv, digest: string, path: string, expectedHash: string | null) {
  if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("environment_artifact_expected_revision_required");
  const clean = assertWorkspaceFileAllowed(env.workspaceFileScope, path);
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const source = await readBytesWithHash(bucket, artifactKey(env, digest), MAX_BYTES);
  if (!source || source.hash !== digest) throw new Error("environment_artifact_integrity_failed");
  const result = await publishWorkspaceBytesCas(env, bucket, workspacePrefix(env) + clean, source.bytes, expectedHash);
  await env.onWorkspaceChange?.({ path: clean, operation: "write" });
  return { restored: true, path: clean, digest: result.hash, bytes: source.bytes.byteLength };
}
