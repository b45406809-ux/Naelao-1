/**
 * file-manager (spec §12.3) — advanced file operations extending r2-workspace with
 * diff tracking, append, and history. Tier 1 (R2) for reads/writes.
 *
 * Operations: file.append, file.diff, file.patch, file.history.
 * (file.lock / file.unlock are declared but use R2 conditional writes; kept minimal here.)
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

function bucket(ctx: PrebuiltOpContext): R2Bucket {
  return ctx.env.workspaceBucket ?? ctx.env.scriptsBucket;
}
function key(ctx: PrebuiltOpContext, path: string): string {
  const clean = String(path).replace(/^\/+/, "");
  if (clean.includes("..")) throw new Error(`Path traversal rejected: ${path}`);
  return `spaces/${ctx.env.spaceId}/workspace/${clean}`;
}
function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new Error(`'${name}' (string) is required`);
  return v;
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
      const k = key(ctx, reqStr(args, "path"));
      const existing = await bucket(ctx).get(k);
      const prior = existing ? await existing.text() : "";
      const content = prior + reqStr(args, "content");
      await bucket(ctx).put(k, content, { customMetadata: { updatedAt: Date.now().toString() } });
      return { ok: true, size: content.length };
    },

    async "file.diff"(args, ctx) {
      const [a, b] = await Promise.all([
        bucket(ctx).get(key(ctx, reqStr(args, "path_a"))),
        bucket(ctx).get(key(ctx, reqStr(args, "path_b"))),
      ]);
      const aText = a ? await a.text() : "";
      const bText = b ? await b.text() : "";
      return lineDiff(aText, bText);
    },

    async "file.patch"(args, ctx) {
      // Apply a simple find/replace patch: { path, find, replace }.
      const k = key(ctx, reqStr(args, "path"));
      const obj = await bucket(ctx).get(k);
      if (!obj) throw new Error("file not found");
      const before = await obj.text();
      const find = reqStr(args, "find");
      const replace = reqStr(args, "replace");
      const after = before.split(find).join(replace);
      await bucket(ctx).put(k, after, { customMetadata: { updatedAt: Date.now().toString() } });
      return { ok: true, changed: before !== after };
    },

    async "file.history"(_args, _ctx) {
      // Workspace files are not versioned (only the skill library is). Return empty
      // history rather than fabricate one; agents that need history write to scripts/.
      return { versions: [] };
    },
  },
};
