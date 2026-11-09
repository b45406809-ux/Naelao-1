export type WorkspaceManifestRead = () => Promise<{
  head: { branch: string; revision: number; updatedAt: string };
  entries: Array<{ path: string; sha256: string; size: number; executable: boolean; objectKey: string; contentType?: string }>;
} | null>;

export interface WorkspaceReadDriftOptions {
  enabled: boolean;
  tenantId: string;
  spaceId: string;
  projectId: string;
}

const DUAL_READ_MAX_FILES = 20;
const DUAL_READ_MAX_FILE_BYTES = 512 * 1024;
const DUAL_READ_MAX_BYTES = 2 * 1024 * 1024;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashPath(path: string): Promise<string> {
  return sha256(new TextEncoder().encode(path));
}

/**
 * Read adapter for legacy R2 consumers during the unified-workspace transition. It projects
 * canonical manifest state into the small R2 surface used by script-engine readers. Writes to
 * the project workspace fail closed: they must use checked coordinator publication.
 */
export function withWorkspaceManifestRead(
  source: R2Bucket,
  prefix: string,
  readManifest: WorkspaceManifestRead,
  driftOptions?: WorkspaceReadDriftOptions,
): R2Bucket {
  const inWorkspace = (key: string) => key.startsWith(prefix);
  let driftCompared = 0;
  let driftBytes = 0;
  let driftMismatches = 0;
  let driftTruncated = false;
  const verifyLegacy = async (key: string, canonical: { sha256: string; size: number; contentType?: string } | null, head?: { branch: string; revision: number }): Promise<void> => {
    if (!driftOptions?.enabled || driftCompared >= DUAL_READ_MAX_FILES) { if (driftOptions?.enabled) driftTruncated = true; return; }
    let legacy: R2ObjectBody | null;
    try { legacy = await source.get(key); }
    catch { driftTruncated = true; return; }
    if (!canonical && !legacy) return;
    if (legacy?.customMetadata?.deleted === "true") return;
    if ((legacy?.size ?? 0) > DUAL_READ_MAX_FILE_BYTES || driftBytes + (legacy?.size ?? 0) > DUAL_READ_MAX_BYTES) {
      driftTruncated = true;
      return;
    }
    driftCompared++;
    let mismatchClass: "legacy_missing" | "manifest_missing" | "hash_mismatch" | "size_mismatch" | "content_type_mismatch" | undefined;
    let legacyHash: string | null = null;
    if (!legacy) mismatchClass = "legacy_missing";
    else {
      const bytes = new Uint8Array(await legacy.arrayBuffer());
      driftBytes += bytes.byteLength;
      legacyHash = await sha256(bytes);
      if (!canonical) mismatchClass = "manifest_missing";
      else if (legacy.size !== canonical.size || bytes.byteLength !== canonical.size) mismatchClass = "size_mismatch";
      else if ((legacy.httpMetadata?.contentType ?? "application/octet-stream") !== (canonical.contentType ?? "application/octet-stream")) mismatchClass = "content_type_mismatch";
      else if (legacyHash !== canonical.sha256) mismatchClass = "hash_mismatch";
    }
    if (!mismatchClass) return;
    driftMismatches++;
    console.info("workspace_dual_read", {
      tenantId: driftOptions.tenantId, spaceId: driftOptions.spaceId, projectId: driftOptions.projectId,
      branch: head?.branch ?? "unknown", revision: head?.revision ?? 0, pathHash: await hashPath(key.slice(prefix.length)), legacyHash,
      manifestHash: canonical?.sha256 ?? null, mismatchClass,
      compared: driftCompared, mismatched: driftMismatches, bytesHashed: driftBytes, truncated: driftTruncated,
    });
  };
  return new Proxy(source, {
    get(target, property) {
      if (property === "get") return async (key: string, options?: R2GetOptions) => {
        if (!inWorkspace(key)) return target.get(key, options);
        const manifest = await readManifest();
        if (!manifest) return target.get(key, options);
        const entry = manifest.entries.find((candidate) => prefix + candidate.path === key);
        if (!entry) { await verifyLegacy(key, null, manifest.head); return null; }
        if (!entry.objectKey.startsWith("workspace-v1/") || !entry.objectKey.endsWith(`/${entry.sha256}`)) throw new Error("workspace_object_scope_mismatch");
        const stored = await target.get(entry.objectKey);
        if (!stored || stored.size !== entry.size) throw new Error("workspace_content_unavailable");
        const bytes = new Uint8Array(await stored.arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        if (hash !== entry.sha256) throw new Error("workspace_content_integrity_failed");
        await verifyLegacy(key, { sha256: entry.sha256, size: entry.size, ...(entry.contentType ? { contentType: entry.contentType } : {}) }, manifest.head);
        let selected = bytes;
        const range = options?.range as { offset?: number; length?: number; suffix?: number } | undefined;
        if (range && Number.isSafeInteger(range.offset)) {
          const offset = Math.max(0, range.offset!);
          selected = bytes.slice(offset, range.length === undefined ? undefined : offset + Math.max(0, range.length));
        } else if (range && Number.isSafeInteger(range.suffix)) {
          selected = bytes.slice(Math.max(0, bytes.length - Math.max(0, range.suffix!)));
        }
        const copy = selected.slice();
        return {
          key, version: "workspace-v1", size: entry.size, etag: entry.sha256,
          uploaded: new Date(manifest.head.updatedAt), httpMetadata: { contentType: entry.contentType ?? "application/octet-stream" }, customMetadata: { sha256: entry.sha256,
            workspaceBranch: manifest.head.branch, workspaceRevision: String(manifest.head.revision) },
          async arrayBuffer() { return copy.slice().buffer; },
          async text() { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(copy); },
          async json() { return JSON.parse(new TextDecoder().decode(copy)); },
          async blob() { return new Blob([copy]); },
        } as unknown as R2ObjectBody;
      };
      if (property === "head") return async (key: string) => {
        if (!inWorkspace(key)) return target.head(key);
        const manifest = await readManifest();
        if (!manifest) return target.head(key);
        const entry = manifest.entries.find((candidate) => prefix + candidate.path === key);
        if (!entry) return null;
        return { key, version: "workspace-v1", size: entry.size, etag: entry.sha256, uploaded: new Date(manifest.head.updatedAt), httpMetadata: { contentType: entry.contentType ?? "application/octet-stream" }, customMetadata: { sha256: entry.sha256,
          workspaceBranch: manifest.head.branch, workspaceRevision: String(manifest.head.revision) } } as unknown as R2Object;
      };
      if (property === "list") return async (options: R2ListOptions = {}) => {
        const requestedPrefix = options.prefix ?? "";
        if (!inWorkspace(requestedPrefix) && requestedPrefix !== prefix) return target.list(options);
        const manifest = await readManifest();
        if (!manifest) return target.list(options);
        const items = manifest.entries
          .filter((entry) => (prefix + entry.path).startsWith(requestedPrefix))
          .sort((a, b) => a.path.localeCompare(b.path));
        const parsedCursor = Number(options.cursor ?? "0");
        const start = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
        const limit = Math.max(1, Math.min(1000, options.limit ?? 1000));
        const page = items.slice(start, start + limit);
        const objects = page.map((entry) => ({ key: prefix + entry.path, version: "workspace-v1", size: entry.size,
          etag: entry.sha256, uploaded: new Date(manifest.head.updatedAt), httpMetadata: { contentType: entry.contentType ?? "application/octet-stream" }, customMetadata: { sha256: entry.sha256,
            workspaceBranch: manifest.head.branch, workspaceRevision: String(manifest.head.revision) } }));
        const truncated = start + page.length < items.length;
        return { objects, delimitedPrefixes: [], ...(truncated ? { truncated: true as const, cursor: String(start + page.length) } : { truncated: false as const }) } as unknown as R2Objects;
      };
      if (property === "put") return async (key: string, ...args: unknown[]) => {
        if (inWorkspace(key)) throw new Error("workspace_write_requires_checked_publication");
        return (target.put as (...values: unknown[]) => unknown)(key, ...args);
      };
      if (property === "delete") return async (keys: string | string[], ...args: unknown[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.some(inWorkspace)) throw new Error("workspace_delete_requires_checked_publication");
        return (target.delete as (...values: unknown[]) => unknown)(keys, ...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
