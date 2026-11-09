import type { WorkspaceCompatEntry, WorkspaceCompatHead } from "./workspace-compat.js";

export type WorkspaceDriftClass = "legacy_missing" | "manifest_missing" | "hash_mismatch" | "size_mismatch" | "content_type_mismatch" | "executable_mismatch";
export type WorkspaceDualReadSummary = {
  compared: number;
  matching: number;
  mismatched: number;
  truncated: boolean;
  drifts: Array<{ pathHash: string; legacyHash: string | null; manifestHash: string | null; mismatchClass: WorkspaceDriftClass }>;
};

const MAX_COMPARE = 50;
const MAX_REPORTED_DRIFTS = 20;
const MAX_COMPARE_BYTES = 16 * 1024 * 1024;

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pathDigest(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path);
  return digest(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/**
 * Bounded read-only comparison for the project UI migration. It logs scoped IDs, hashes,
 * mismatch classes and counters only; file names and bytes are never emitted. A project admin
 * can repair shadow drift from the legacy snapshot through the checked migration repair route;
 * cutover independently requires a complete zero-mismatch pass.
 */
export async function verifyWorkspaceDualRead(input: {
  bucket: R2Bucket;
  prefix: string;
  tenantId: string;
  spaceId: string;
  projectId: string;
  head: WorkspaceCompatHead;
  entries: WorkspaceCompatEntry[];
  path?: string;
}): Promise<WorkspaceDualReadSummary> {
  const canonicalPaths = new Set(input.entries.map((entry) => entry.path));
  const candidates = input.path ? input.entries.filter((entry) => entry.path === input.path) : input.entries;
  const bounded = candidates.slice(0, MAX_COMPARE);
  const summary: WorkspaceDualReadSummary = { compared: 0, matching: 0, mismatched: 0, truncated: candidates.length > bounded.length, drifts: [] };
  let bytesHashed = 0;
  for (const entry of bounded) {
    const legacy = await input.bucket.get(input.prefix + entry.path);
    if (legacy && legacy.customMetadata?.deleted !== "true" && legacy.size > MAX_COMPARE_BYTES - bytesHashed) {
      summary.truncated = true;
      continue;
    }
    summary.compared++;
    let mismatchClass: WorkspaceDriftClass | undefined;
    let legacyHash: string | null = null;
    if (!legacy || legacy.customMetadata?.deleted === "true") mismatchClass = "legacy_missing";
    else {
      const bytes = await legacy.arrayBuffer();
      bytesHashed += bytes.byteLength;
      legacyHash = await digest(bytes);
      if (bytes.byteLength !== entry.size || legacy.size !== entry.size) mismatchClass = "size_mismatch";
      else if (normalizeContentType(legacy.httpMetadata?.contentType) !== normalizeContentType(entry.contentType)) mismatchClass = "content_type_mismatch";
      else if ((legacy.customMetadata?.executable === "true") !== entry.executable) mismatchClass = "executable_mismatch";
      else if (legacyHash !== entry.sha256) mismatchClass = "hash_mismatch";
    }
    if (!mismatchClass) { summary.matching++; continue; }
    summary.mismatched++;
    if (summary.drifts.length < MAX_REPORTED_DRIFTS) summary.drifts.push({
      pathHash: await pathDigest(entry.path), legacyHash, manifestHash: entry.sha256, mismatchClass,
    });
  }
  // Also catch legacy-only files, while keeping listing work bounded. Single-file reads
  // probe their exact key so a stale object cannot be missed when the manifest omits it.
  if (input.path && !canonicalPaths.has(input.path)) {
    const legacy = await input.bucket.get(input.prefix + input.path);
    if (legacy && legacy.customMetadata?.deleted !== "true" && legacy.size <= MAX_COMPARE_BYTES - bytesHashed) {
      summary.compared++;
      summary.mismatched++;
      const bytes = await legacy.arrayBuffer();
      bytesHashed += bytes.byteLength;
      if (summary.drifts.length < MAX_REPORTED_DRIFTS) summary.drifts.push({
        pathHash: await pathDigest(input.path), legacyHash: await digest(bytes),
        manifestHash: null, mismatchClass: "manifest_missing",
      });
    } else if (legacy && legacy.customMetadata?.deleted !== "true") summary.truncated = true;
  } else if (!input.path) {
    const listed = await input.bucket.list({ prefix: input.prefix, limit: MAX_COMPARE + 1 });
    const legacyOnly = listed.objects.filter((object) => !object.key.endsWith("/.keep") && object.customMetadata?.deleted !== "true" && !canonicalPaths.has(object.key.slice(input.prefix.length)));
    for (const object of legacyOnly.slice(0, MAX_COMPARE)) {
      const relative = object.key.slice(input.prefix.length);
      const bytes = await input.bucket.get(object.key);
      if (!bytes) continue;
      if (bytes.size > MAX_COMPARE_BYTES - bytesHashed) { summary.truncated = true; break; }
      const contents = await bytes.arrayBuffer();
      bytesHashed += contents.byteLength;
      summary.compared++;
      summary.mismatched++;
      if (summary.drifts.length < MAX_REPORTED_DRIFTS) summary.drifts.push({
        pathHash: await pathDigest(relative), legacyHash: await digest(contents),
        manifestHash: null, mismatchClass: "manifest_missing",
      });
    }
    summary.truncated ||= listed.truncated || legacyOnly.length > MAX_COMPARE;
  }
  console.info("workspace_dual_read", {
    tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId,
    branch: input.head.branch, revision: input.head.revision,
    compared: summary.compared, matching: summary.matching, mismatched: summary.mismatched,
    bytesHashed, truncated: summary.truncated, drifts: summary.drifts,
  });
  return summary;
}

function normalizeContentType(value?: string): string {
  return (value ?? "application/octet-stream").trim().toLowerCase().replace(/\s*;\s*/g, ";");
}
