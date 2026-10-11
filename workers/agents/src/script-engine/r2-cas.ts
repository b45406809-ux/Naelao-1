
/** Shared SHA-256/ETag compare-and-swap primitives for mutable R2 projections. */

interface WorkspaceCasEnv {
  runId?: string;
  lockGateway?: {
    acquire(input: { key: string; holderId: string; limit: number; ttlMs?: number }): Promise<{ granted: boolean; fencingToken?: number; heldBy?: string }>;
    publishWorkspace?(input: {
      key: string; holderId: string; fencingToken: number; path: string; operation: "write" | "delete";
      expectedHash: string | null; contentBase64?: string; metadata?: Record<string, string>; contentType?: string;
    }): Promise<{ hash?: string; etag?: string; deleted?: boolean; fencingToken: number }>;
    release(input: { key: string; holderId: string; fencingToken?: number }): Promise<void>;
  };
}

const encoder = new TextEncoder();
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface CasWriteResult { hash: string; etag: string }
export interface CasReadResult { bytes: Uint8Array; hash: string; etag: string; metadata: Record<string, string> }

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

/** Production project-workspace publication passes through the same ConcurrencyDO that owns
 *  the fenced lease. Local isolated tests retain the conditional R2 path. */
export async function publishWorkspaceBytesCas(
  env: WorkspaceCasEnv,
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  expectedHash: string | null,
  metadata: Record<string, string> = {},
  httpMetadata?: R2HTTPMetadata,
): Promise<CasWriteResult> {
  const gateway = env.lockGateway;
  if (!gateway?.publishWorkspace || !env.runId) return putBytesCas(bucket, key, bytes, expectedHash, metadata, httpMetadata);
  const lockKey = `workspace-file:${key}`;
  const lease = await gateway.acquire({ key: lockKey, holderId: env.runId, limit: 1, ttlMs: 30_000 });
  if (!lease.granted || !Number.isSafeInteger(lease.fencingToken) || !lease.fencingToken) {
    throw new Error(`Workspace lease unavailable for '${key}'${lease.heldBy ? ` (held by ${lease.heldBy})` : ""}`);
  }
  try {
    const result = await gateway.publishWorkspace({
      key: lockKey,
      holderId: env.runId,
      fencingToken: lease.fencingToken,
      path: key,
      operation: "write",
      expectedHash,
      contentBase64: encodeBase64(bytes),
      metadata,
      ...(httpMetadata?.contentType ? { contentType: httpMetadata.contentType } : {}),
    });
    if (!result.hash || result.fencingToken !== lease.fencingToken) throw new Error(`Workspace publication did not confirm its fenced revision: '${key}'`);
    return { hash: result.hash, etag: result.etag ?? "" };
  } finally {
    await gateway.release({ key: lockKey, holderId: env.runId, fencingToken: lease.fencingToken });
  }
}

export async function deleteWorkspaceBytesCas(
  env: WorkspaceCasEnv,
  bucket: R2Bucket,
  key: string,
  expectedHash: string | null,
): Promise<{ deleted: boolean; etag?: string }> {
  const gateway = env.lockGateway;
  if (!gateway?.publishWorkspace || !env.runId) return deleteBytesCas(bucket, key, expectedHash);
  const lockKey = `workspace-file:${key}`;
  const lease = await gateway.acquire({ key: lockKey, holderId: env.runId, limit: 1, ttlMs: 30_000 });
  if (!lease.granted || !Number.isSafeInteger(lease.fencingToken) || !lease.fencingToken) throw new Error(`Workspace lease unavailable for '${key}'`);
  try {
    const result = await gateway.publishWorkspace({ key: lockKey, holderId: env.runId, fencingToken: lease.fencingToken, path: key, operation: "delete", expectedHash });
    if (result.fencingToken !== lease.fencingToken) throw new Error(`Workspace deletion did not confirm its fenced revision: '${key}'`);
    return { deleted: result.deleted === true, ...(result.etag ? { etag: result.etag } : {}) };
  } finally {
    await gateway.release({ key: lockKey, holderId: env.runId, fencingToken: lease.fencingToken });
  }
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class R2CasConflictError extends Error {
  constructor(key: string) {
    super(`Conflict Error: '${key}' changed concurrently; re-read before writing`);
    this.name = "R2CasConflictError";
  }
}

async function observedHash(bucket: R2Bucket, key: string, head: R2Object): Promise<string | null> {
  if (head.customMetadata?.["deleted"] === "true") return null;
  const object = await bucket.get(key);
  if (!object) throw new R2CasConflictError(key);
  const actual = await sha256Bytes(new Uint8Array(await object.arrayBuffer()));
  const recorded = head.customMetadata?.["sha256"];
  if (recorded && recorded !== actual) throw new Error(`Workspace integrity check failed for '${key}'`);
  return actual;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readBytesWithHash(bucket: R2Bucket, key: string): Promise<CasReadResult | null> {
  const head = await bucket.head(key);
  if (!head || head.customMetadata?.["deleted"] === "true") return null;
  const object = await bucket.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const hash = await sha256Bytes(bytes);
  if (head.customMetadata?.["sha256"] && head.customMetadata["sha256"] !== hash) throw new Error(`Workspace integrity check failed for '${key}'`);
  return {
    bytes,
    hash,
    etag: head.etag,
    metadata: head.customMetadata ?? {},
  };
}

/** One conditional R2 PUT is the publication point. ETags close the head/read/write race. */
export async function putBytesCas(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  expectedHash: string | null,
  metadata: Record<string, string> = {},
  httpMetadata?: R2HTTPMetadata,
): Promise<CasWriteResult> {
  const head = await bucket.head(key);
  const currentHash = head ? await observedHash(bucket, key, head) : null;
  if (currentHash !== expectedHash) throw new R2CasConflictError(key);
  const hash = await sha256Bytes(bytes);
  const written = await bucket.put(key, bytes, {
    customMetadata: { ...metadata, updatedAt: Date.now().toString(), sha256: hash },
    ...(httpMetadata ? { httpMetadata } : {}),
    ...(head ? { onlyIf: { etagMatches: head.etag } } : { onlyIf: { etagDoesNotMatch: "*" } }),
  });
  if (!written) throw new R2CasConflictError(key);
  return { hash, etag: written.etag };
}

/** R2 has conditional PUT but no conditional DELETE. A tombstone is therefore published with
 *  the same atomic ETag CAS as an update. Readers/listings must filter deleted=true. */
export async function deleteBytesCas(
  bucket: R2Bucket,
  key: string,
  expectedHash: string | null,
  metadata: Record<string, string> = {},
): Promise<{ deleted: boolean; etag?: string }> {
  const head = await bucket.head(key);
  const currentHash = head ? await observedHash(bucket, key, head) : null;
  if (currentHash !== expectedHash) throw new R2CasConflictError(key);
  if (currentHash === null) return { deleted: false };
  const written = await bucket.put(key, new Uint8Array(), {
    customMetadata: {
      ...metadata,
      updatedAt: Date.now().toString(),
      sha256: EMPTY_HASH,
      deleted: "true",
      deletedHash: currentHash,
    },
    onlyIf: { etagMatches: head!.etag },
  });
  if (!written) throw new R2CasConflictError(key);
  return { deleted: true, etag: written.etag };
}

export async function readTextWithHash(bucket: R2Bucket, key: string): Promise<{ text: string; hash: string } | null> {
  const value = await readBytesWithHash(bucket, key);
  if (!value) return null;
  return { text: new TextDecoder().decode(value.bytes), hash: value.hash };
}

export async function putTextCas(bucket: R2Bucket, key: string, text: string, expectedHash: string | null): Promise<{ hash: string }> {
  const result = await putBytesCas(bucket, key, encoder.encode(text), expectedHash);
  return { hash: result.hash };
}
import type { ScriptEngineEnv } from "./types.js";

