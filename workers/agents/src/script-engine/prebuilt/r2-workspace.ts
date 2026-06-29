/**
 * r2-workspace (spec §12.1) — maps file operations to Tier 1 direct R2.
 * Default for all agents. The R2 workspace is the agent's persistent filesystem; it
 * persists across sessions. Operations: read_file, write_file, list_directory,
 * delete_file, copy_file, move_file.
 *
 * The matching observe script for this is observe_filesystem (see observe.ts).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

/** Resolve the workspace bucket (falls back to the scripts bucket if not separate). */
function bucket(ctx: PrebuiltOpContext): R2Bucket {
  return ctx.env.workspaceBucket ?? ctx.env.scriptsBucket;
}

/** All workspace keys are scoped under the space's workspace prefix. */
function key(ctx: PrebuiltOpContext, path: string): string {
  const clean = String(path).replace(/^\/+/, "");
  if (clean.includes("..")) throw new Error(`Path traversal rejected: ${path}`);
  return `spaces/${ctx.env.spaceId}/workspace/${clean}`;
}

function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`'${name}' (string) is required`);
  return v;
}

export const r2Workspace: PrebuiltScript = {
  name: "r2-workspace",
  description: "Read, write, list, delete, copy and move files in the agent's R2 workspace.",
  domain: "filesystem",
  requires_tier: 1,
  operations: {
    async read_file(args, ctx) {
      const obj = await bucket(ctx).get(key(ctx, reqStr(args, "path")));
      if (!obj) return { exists: false, content: null };
      return { exists: true, content: await obj.text(), size: obj.size };
    },

    async write_file(args, ctx) {
      const path = reqStr(args, "path");
      const content = args["content"];
      if (typeof content !== "string") throw new Error("'content' (string) is required");
      await bucket(ctx).put(key(ctx, path), content, {
        customMetadata: { updatedAt: Date.now().toString() },
      });
      return { ok: true, path };
    },

    async list_directory(args, ctx) {
      const prefix = key(ctx, typeof args["path"] === "string" ? (args["path"] as string) : "");
      const out: Array<{ key: string; size: number; uploaded: string }> = [];
      let cursor: string | undefined;
      do {
        const listing = await bucket(ctx).list(cursor ? { prefix, cursor } : { prefix });
        for (const o of listing.objects) {
          out.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
        }
        cursor = listing.truncated ? listing.cursor : undefined;
      } while (cursor);
      return { files: out, count: out.length };
    },

    async delete_file(args, ctx) {
      await bucket(ctx).delete(key(ctx, reqStr(args, "path")));
      return { ok: true };
    },

    async copy_file(args, ctx) {
      const from = await bucket(ctx).get(key(ctx, reqStr(args, "from")));
      if (!from) throw new Error("source file not found");
      await bucket(ctx).put(key(ctx, reqStr(args, "to")), from.body);
      return { ok: true };
    },

    async move_file(args, ctx) {
      const fromKey = key(ctx, reqStr(args, "from"));
      const from = await bucket(ctx).get(fromKey);
      if (!from) throw new Error("source file not found");
      await bucket(ctx).put(key(ctx, reqStr(args, "to")), from.body);
      await bucket(ctx).delete(fromKey);
      return { ok: true };
    },
  },
};
