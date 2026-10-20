/**
 * file-manager (spec §12.3) — advanced file operations extending r2-workspace with
 * diff tracking, append, and history. Tier 1 (R2) for reads/writes.
 *
 * Operations: file.append, file.diff, file.patch, file.history.
 * (file.lock / file.unlock are declared but use R2 conditional writes; kept minimal here.)
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { workspacePrefix } from "../types.js";
import { publishWorkspaceBytesCas } from "../r2-cas.js";

const MAX_FILE_OPERATION_BYTES = 1024 * 1024;

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
  const clean = String(path).replace(/^\/+/, "");
  if (clean.includes("..")) throw new Error(`Path traversal rejected: ${path}`);
  return `${workspacePrefix(ctx.env)}${clean}`;
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

async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function casWrite(ctx: PrebuiltOpContext, storageKey: string, content: string, expectedHash: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_FILE_OPERATION_BYTES)
    throw new Error(`file operation is limited to ${MAX_FILE_OPERATION_BYTES} bytes; use workspace.write_file with ranged edits for larger files`);
  return (await publishWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, bytes, expectedHash)).hash;
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
      const hash = await casWrite(ctx, k, content, requiredExpectedHash(args));
      await ctx.env.onWorkspaceChange?.({ path, operation: "write" });
      return { ok: true, size: content.length, hash };
    },

    async "file.diff"(args, ctx) {
      const [a, b] = await Promise.all([
        bucket(ctx).get(key(ctx, reqStr(args, "path_a"))),
        bucket(ctx).get(key(ctx, reqStr(args, "path_b"))),
      ]);
      const aText = await readWorkspaceFile(a);
      const bText = await readWorkspaceFile(b);
      return lineDiff(aText, bText);
    },

    async "file.patch"(args, ctx) {
      // Apply a simple find/replace patch: { path, find, replace }.
      const k = key(ctx, reqStr(args, "path"));
      const obj = await bucket(ctx).get(k);
      if (!obj) throw new Error("file not found");
      const before = await readWorkspaceFile(obj);
      const find = reqStr(args, "find");
      const replace = reqStr(args, "replace");
      const after = before.split(find).join(replace);
      const hash = await casWrite(ctx, k, after, requiredExpectedHash(args));
      await ctx.env.onWorkspaceChange?.({ path: reqStr(args, "path"), operation: "write" });
      return { ok: true, changed: before !== after, hash };
    },

    async "file.history"(_args, _ctx) {
      // Workspace files are not versioned (only the skill library is). Return empty
      // history rather than fabricate one; agents that need history write to scripts/.
      return { versions: [] };
    },
  },
};
