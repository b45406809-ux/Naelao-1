/**
 * r2-workspace (spec §12.1) — maps file operations to Tier 1 direct R2.
 * Default for all agents. The R2 workspace is the agent's persistent filesystem; it
 * persists across sessions. Operations: read_file, write_file, list_directory,
 * delete_file, copy_file, move_file, stat_file.
 *
 * The matching observe script for this is observe_filesystem (see observe.ts).
 *
 * read_file's own result becomes part of THIS turn's reasoner payload immediately — it isn't
 * windowed down to a short observation until step-context.ts trims an OLDER step, which is too
 * late for a single oversized read. A multi-MB file (a customer-uploaded CSV, a large export)
 * read in full would blow a small model's ~24k-token context in one call. stat_file lets the
 * agent check size before committing to a read; read_file itself also refuses past
 * MAX_READABLE_FILE_BYTES rather than trusting the model to check first — same "structure over
 * prompts" reasoning as every other hard cap in this engine.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { workspacePrefix } from "../types.js";

/** Above this, read_file refuses rather than returning a payload that can blow the context of a
 *  turn all by itself. ~50k tokens at a rough 4-chars/token estimate — generous for real text/
 *  config/code files, bounded well under even the platform's smallest usable model window. */
const MAX_READABLE_FILE_BYTES = 200_000;

/** Resolve the workspace bucket (falls back to the scripts bucket if not separate). */
function bucket(ctx: PrebuiltOpContext): R2Bucket {
  return ctx.env.workspaceBucket ?? ctx.env.scriptsBucket;
}

/** All workspace keys are scoped under the run's workspace prefix (space- or project-scoped). */
function key(ctx: PrebuiltOpContext, path: string): string {
  const clean = String(path).replace(/^\/+/, "");
  if (clean.includes("..")) throw new Error(`Path traversal rejected: ${path}`);
  return `${workspacePrefix(ctx.env)}${clean}`;
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
      // .size is real object metadata, available before the body is ever pulled — checking it
      // here avoids reading a multi-MB body into memory just to discard it.
      if (obj.size > MAX_READABLE_FILE_BYTES) {
        return {
          exists: true,
          content: null,
          size: obj.size,
          too_large: true,
          message: `This file is ${obj.size} bytes, over the ${MAX_READABLE_FILE_BYTES}-byte limit for a single read. Use stat_file first to check size before reading a file you're not sure about.`,
        };
      }
      return { exists: true, content: await obj.text(), size: obj.size };
    },
    // A cheap, content-free size/existence check — call this BEFORE read_file on anything that
    // might be large (a customer upload, an export another agent produced) instead of finding out
    // the hard way.
    async stat_file(args, ctx) {
      const head = await bucket(ctx).head(key(ctx, reqStr(args, "path")));
      if (!head) return { exists: false };
      return {
        exists: true,
        size: head.size,
        uploaded: head.uploaded.toISOString(),
        readable: head.size <= MAX_READABLE_FILE_BYTES,
      };
    },

    async write_file(args, ctx) {
      const path = reqStr(args, "path");
      const content = args["content"];
      if (typeof content !== "string") throw new Error("'content' (string) is required");
      await bucket(ctx).put(key(ctx, path), content, {
        customMetadata: { updatedAt: Date.now().toString() },
      });
      // The file IS the handoff between projects: one project's agent records what it found,
      // that write fires an event, and a no-code rule wakes whoever owns the next stage. Fired
      // after the write actually succeeded, and never awaited — a listener failing must not turn
      // a successful write into a failed one.
      ctx.env.onWorkspaceChange?.({ path, operation: "write" });
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
      const path = reqStr(args, "path");
      await bucket(ctx).delete(key(ctx, path));
      ctx.env.onWorkspaceChange?.({ path, operation: "delete" });
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
