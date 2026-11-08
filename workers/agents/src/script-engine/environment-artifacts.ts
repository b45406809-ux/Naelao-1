import type { ScriptEngineEnv } from "./types.js";
import { workspacePrefix } from "./types.js";
import { assertWorkspaceFileAllowed } from "./workspace-paths.js";
import { publishWorkspaceBytesCas, readBytesWithHash, sha256Bytes } from "./r2-cas.js";

// Handoff blobs are immutable and stored outside the canonical project workspace namespace.
// Restore into an isolated workspace branch still goes through the coordinator checked publisher.
// R2 artifacts are read into a bounded worker buffer before digest/CAS operations.
// 16 MiB supports useful project files without turning transfer into unbounded memory use.
const MAX_BYTES = 16 * 1024 * 1024;
function artifactKey(env: ScriptEngineEnv, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("environment_artifact_digest_invalid");
  const ids = [env.tenantId, env.spaceId, env.projectId ?? "space"];
  if (ids.some((id) => !id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id))) throw new Error("environment_artifact_scope_invalid");
  return `workspace-artifacts/${ids[0]}/${ids[1]}/${ids[2]}/environment/${digest}`;
}
function legacyArtifactKey(env: ScriptEngineEnv, digest: string) {
  return workspacePrefix(env) + ".environment-artifacts/" + digest;
}
function artifactBucket(env: ScriptEngineEnv) {
  return env.immutableArtifactBucket ?? env.workspaceBucket ?? env.scriptsBucket;
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
  const bucket = artifactBucket(env);
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
  const bucket = artifactBucket(env);
  const source = await readBytesWithHash(bucket, artifactKey(env, digest), MAX_BYTES);
  const legacy = !source
    ? await readBytesWithHash(env.immutableArtifactBucket ?? env.workspaceBucket ?? env.scriptsBucket, legacyArtifactKey(env, digest), MAX_BYTES)
    : null;
  const resolved = source ?? legacy;
  if (!resolved || resolved.hash !== digest) throw new Error("environment_artifact_integrity_failed");
  return resolved;
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
