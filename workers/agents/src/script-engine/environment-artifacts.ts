import type { ScriptEngineEnv } from "./types.js";
import { workspacePrefix } from "./types.js";
import { assertWorkspaceFileAllowed } from "./workspace-paths.js";
import { publishWorkspaceBytesCas, readBytesWithHash, sha256Bytes } from "./r2-cas.js";

// R2 artifacts are read into a bounded worker buffer before digest/CAS operations.
// 16 MiB supports useful project files without turning transfer into unbounded memory use.
const MAX_BYTES = 16 * 1024 * 1024;
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
  return publishEnvironmentArtifactBytes(env, source.bytes, clean);
}
export async function publishEnvironmentArtifactBytes(env: ScriptEngineEnv, bytes: Uint8Array, sourcePath: string) {
  if (bytes.byteLength > MAX_BYTES) throw new Error("environment_artifact_too_large");
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const digest = await sha256Bytes(bytes);
  const key = artifactKey(env, digest);
  const stored = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: digest, sourcePath } });
  if (!stored) {
    const existing = await readBytesWithHash(bucket, key, MAX_BYTES);
    if (existing?.hash !== digest) throw new Error("environment_artifact_integrity_failed");
  }
  return { digest, bytes: bytes.byteLength, source_path: sourcePath, immutable: true };
}
export async function readEnvironmentArtifact(env: ScriptEngineEnv, digest: string) {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const source = await readBytesWithHash(bucket, artifactKey(env, digest), MAX_BYTES);
  if (!source || source.hash !== digest) throw new Error("environment_artifact_integrity_failed");
  return source;
}
export async function restoreEnvironmentArtifact(env: ScriptEngineEnv, digest: string, path: string, expectedHash: string | null) {
  if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("environment_artifact_expected_revision_required");
  const clean = assertWorkspaceFileAllowed(env.workspaceFileScope, path);
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const source = await readEnvironmentArtifact(env, digest);
  const result = await publishWorkspaceBytesCas(env, bucket, workspacePrefix(env) + clean, source.bytes, expectedHash);
  await env.onWorkspaceChange?.({ path: clean, operation: "write" });
  return { restored: true, path: clean, digest: result.hash, bytes: source.bytes.byteLength };
}
