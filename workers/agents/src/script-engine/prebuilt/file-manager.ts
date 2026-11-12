/**
 * file-manager (spec §12.3) — advanced file operations extending r2-workspace with
 * diff tracking, append, and history. Tier 1 (R2) for reads/writes.
 *
 * Operations: file.append, file.diff, file.patch, file.history.
 * (file.lock / file.unlock are declared but use R2 conditional writes; kept minimal here.)
 */

import { inferWorkspaceContentType } from "@naelao/types";
import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { workspacePrefix } from "../types.js";
import { deleteWorkspaceBytesCas, publishWorkspaceBytesCas } from "../r2-cas.js";
import { normalizeWorkspacePath } from "../workspace-paths.js";

const MAX_FILE_OPERATION_BYTES = 1024 * 1024;
const MAX_FILE_RESTORE_BYTES = 20 * 1024 * 1024;

async function readWorkspaceFile(object: R2ObjectBody | null): Promise<string> {
  if (!object) return "";
  if (object.size > MAX_FILE_OPERATION_BYTES) throw new Error(`file operation is limited to ${MAX_FILE_OPERATION_BYTES} bytes; use workspace.read_file with offset/length for larger files`);
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size || bytes.byteLength > MAX_FILE_OPERATION_BYTES)
    throw new Error("file changed size during read; retry the operation");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function bucket(ctx: PrebuiltOpContext): R2Bucket {
  return ctx.env.workspaceBucket ?? ctx.env.scriptsBucket;
}
function key(ctx: PrebuiltOpContext, path: string): string {
  return `${workspacePrefix(ctx.env)}${normalizeWorkspacePath(path)}`;
}
function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new Error(`'${name}' (string) is required`);
  return v;
}

function requiredExpectedHash(args: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(args, "expectedHash")) {
    throw new Error("'expectedHash' (SHA-256 string or null) is required for every workspace mutation");
  }
  const value = args["expectedHash"];
  if (value !== null && typeof value !== "string") throw new Error("'expectedHash' must be a SHA-256 string or null");
  return value;
}

function revisionFromObject(object: R2ObjectBody | null): { branch: string; revision: number } | undefined {
  const branch = object?.customMetadata?.workspaceBranch;
  const revision = Number(object?.customMetadata?.workspaceRevision);
  return branch && Number.isSafeInteger(revision) && revision >= 1 ? { branch, revision } : undefined;
}

async function casWrite(ctx: PrebuiltOpContext, storageKey: string, content: string, expectedHash: string | null, contentType = "text/plain; charset=utf-8"): Promise<{ hash: string; revision?: { branch: string; revision: number } }> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_FILE_OPERATION_BYTES)
    throw new Error(`file operation is limited to ${MAX_FILE_OPERATION_BYTES} bytes; use workspace.write_file with ranged edits for larger files`);
  const result = await publishWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, bytes, expectedHash, {}, { contentType });
  const revision = /^revision:(\d+)$/.exec(result.etag)?.[1];
  return { hash: result.hash, ...(revision && ctx.env.workspaceBranch ? { revision: { branch: ctx.env.workspaceBranch, revision: Number(revision) } } : {}) };
}

/** Naive line-level diff (added/removed line sets) — adequate for change tracking. */
function lineDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const aLines = new Set(a.split("\n"));
  const bLines = new Set(b.split("\n"));
  return {
    added: [...bLines].filter((l) => !aLines.has(l)),
    removed: [...aLines].filter((l) => !bLines.has(l)),
  };
}

export const fileManager: PrebuiltScript = {
  name: "file-manager",
  description: "Advanced file ops: append, diff between two files, naive patch, change history.",
  domain: "filesystem",
  requires_tier: 1,
  operations: {
    async "file.append"(args, ctx) {
      const path = reqStr(args, "path");
      const k = key(ctx, path);
      const existing = await bucket(ctx).get(k);
      const prior = await readWorkspaceFile(existing);
      const content = prior + reqStr(args, "content");
      const write = await casWrite(ctx, k, content, requiredExpectedHash(args), existing?.httpMetadata?.contentType ?? inferWorkspaceContentType(path));
      await ctx.env.onWorkspaceChange?.({ path, operation: "write" });
      return { ok: true, size: content.length, ...write };
    },

    async "file.diff"(args, ctx) {
      const [a, b] = await Promise.all([
        bucket(ctx).get(key(ctx, reqStr(args, "path_a"))),
        bucket(ctx).get(key(ctx, reqStr(args, "path_b"))),
      ]);
      const aText = await readWorkspaceFile(a);
      const bText = await readWorkspaceFile(b);
      const aRevision = revisionFromObject(a);
      const bRevision = revisionFromObject(b);
      if (aRevision && bRevision && (aRevision.branch !== bRevision.branch || aRevision.revision !== bRevision.revision))
        throw new Error("workspace_manifest_changed_during_diff; retry file.diff");
      return { ...lineDiff(aText, bText), ...(aRevision ? { revision: aRevision } : bRevision ? { revision: bRevision } : {}) };
    },

    async "file.patch"(args, ctx) {
      // Apply a simple find/replace patch: { path, find, replace }.
      const path = reqStr(args, "path");
      const k = key(ctx, path);
      const obj = await bucket(ctx).get(k);
      if (!obj) throw new Error("file not found");
      const before = await readWorkspaceFile(obj);
      const find = reqStr(args, "find");
      const replace = reqStr(args, "replace");
      const after = before.split(find).join(replace);
      const write = await casWrite(ctx, k, after, requiredExpectedHash(args), obj.httpMetadata?.contentType ?? inferWorkspaceContentType(path));
      await ctx.env.onWorkspaceChange?.({ path, operation: "write" });
      return { ok: true, changed: before !== after, ...write };
    },

    async "file.history"(args, ctx) {
      if (!ctx.env.workspaceHistoryRead) return { versions: [], available: false };
      const path = normalizeWorkspacePath(reqStr(args, "path"));
      const afterRevision = args["afterRevision"] === undefined ? undefined : Number(args["afterRevision"]);
      const limit = args["limit"] === undefined ? 100 : Number(args["limit"]);
      if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) throw new Error("'afterRevision' must be a non-negative integer");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("'limit' must be an integer from 1 to 100");
      const history = await ctx.env.workspaceHistoryRead({ path, ...(afterRevision === undefined ? {} : { afterRevision }), limit });
      return { ...history, available: true, versions: [...history.versions].reverse() };
    },

    async "file.restore"(args, ctx) {
      if (!ctx.env.workspaceRevisionRead) throw new Error("workspace_history_unavailable");
      const path = normalizeWorkspacePath(reqStr(args, "path"));
      const revision = Number(args["revision"]);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("'revision' must be a positive integer");
      const expectedHash = requiredExpectedHash(args);
      const historical = await ctx.env.workspaceRevisionRead({ path, revision });
      if (!historical) throw new Error("workspace_revision_not_found");
      const storageKey = key(ctx, path);
      let restored: { revision?: number; deleted: boolean; hash: string | null };
      if (historical.deleted || !historical.bytes) {
        const result = await deleteWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, expectedHash);
        const revisionMatch = /^revision:(\d+)$/.exec(result.etag ?? "");
        restored = { ...(revisionMatch ? { revision: Number(revisionMatch[1]) } : {}), deleted: result.deleted, hash: null };
      } else {
        if (historical.bytes.byteLength > MAX_FILE_RESTORE_BYTES) throw new Error(`file restore is limited to ${MAX_FILE_RESTORE_BYTES} bytes`);
        const digest = await crypto.subtle.digest("SHA-256", historical.bytes);
        const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
        if (hash !== historical.sha256) throw new Error("workspace_revision_content_integrity_failed");
        const write = await publishWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, historical.bytes, expectedHash, {}, {
          contentType: historical.contentType ?? inferWorkspaceContentType(path),
        });
        const revisionMatch = /^revision:(\d+)$/.exec(write.etag);
        restored = { ...(revisionMatch ? { revision: Number(revisionMatch[1]) } : {}), deleted: false, hash: write.hash };
      }
      await ctx.env.onWorkspaceChange?.({ path, operation: restored.deleted ? "delete" : "write" });
      return { ok: true, path, restoredFromRevision: revision, ...restored,
        ...(restored.revision && ctx.env.workspaceBranch ? { branch: ctx.env.workspaceBranch } : {}) };
    },
  },
};
