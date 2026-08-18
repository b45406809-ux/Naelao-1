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

function numArg(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Cap on how large a file search_file will read in one pass. Higher than the single-read cap
 *  because search returns only matching lines, not the whole file — but still bounded so a
 *  genuinely huge file is read in chunks via read_file(offset,length) instead. */
const MAX_SEARCHABLE_FILE_BYTES = 5_000_000;

export const r2Workspace: PrebuiltScript = {
  name: "r2-workspace",
  description:
    "Read, write, list, delete, copy and move files in the agent's R2 workspace. read_file " +
    "supports chunked reads (offset/length) for files too big to read at once; stat_file checks " +
    "size first; search_file finds matching lines inside a file without reading the whole thing.",
  domain: "filesystem",
  requires_tier: 1,
  paramHints: {
    read_file:
      "path (string, REQUIRED). offset (number, optional) + length (number, optional) — read ONLY " +
      "that byte range, the way to read a file bigger than the read limit: start at offset 0, then " +
      "pass the next_offset the result returns until has_more is false. Omit both for a full read " +
      "(refused with too_large if the file exceeds the limit — then use offset/length or search_file).",
    stat_file: "path (string, REQUIRED). Returns size + whether it's readable in one call — call this " +
      "BEFORE read_file on anything that might be large.",
    search_file:
      "path (string, REQUIRED). query (string, REQUIRED — a substring, matched case-insensitively). " +
      "context (number, optional, 0-10) — lines of surrounding context per match. Returns matching " +
      "lines with line numbers; many matches are paged automatically.",
    write_file: "path (string, REQUIRED). content (string, REQUIRED).",
    list_directory: "path (string, optional — a prefix; omit for the whole workspace).",
    delete_file: "path (string, REQUIRED).",
    copy_file: "from (string, REQUIRED). to (string, REQUIRED).",
    move_file: "from (string, REQUIRED). to (string, REQUIRED).",
  },
  operations: {
    async read_file(args, ctx) {
      const path = reqStr(args, "path");
      const k = key(ctx, path);

      // Step 3: chunked/ranged read. When offset and/or length are given, read only that byte
      // range — the way to read a file LARGER than the single-read cap, a slice at a time. The
      // returned chunk is byte-bounded by the cap; has_more/next_offset tell the agent how to
      // page through the rest (same convention as the tool-result paginator). A ranged R2 get()
      // still reports the FULL object size in `.size`, so no separate head() is needed.
      const offset = numArg(args, "offset");
      const length = numArg(args, "length");
      if (offset !== undefined || length !== undefined) {
        const off = Math.max(0, offset ?? 0);
        const len = Math.min(length ?? MAX_READABLE_FILE_BYTES, MAX_READABLE_FILE_BYTES);
        const obj = await bucket(ctx).get(k, { range: { offset: off, length: len } });
        if (!obj) return { exists: false, content: null };
        const total = obj.size;
        if (off >= total) {
          return { exists: true, content: "", offset: off, length: 0, total_size: total, has_more: false };
        }
        const content = await obj.text();
        // Byte-accurate next offset (content.length is chars, which drifts for multibyte UTF-8).
        const bytesRead = Math.min(len, total - off);
        const end = off + bytesRead;
        const hasMore = end < total;
        return {
          exists: true,
          content,
          offset: off,
          length: bytesRead,
          total_size: total,
          has_more: hasMore,
          ...(hasMore ? { next_offset: end } : {}),
        };
      }

      // Full read. get() returns the object with its real `.size` metadata, so the oversize check
      // still happens before the body is materialized into a payload that could blow the turn.
      const obj = await bucket(ctx).get(k);
      if (!obj) return { exists: false, content: null };
      if (obj.size > MAX_READABLE_FILE_BYTES) {
        return {
          exists: true,
          content: null,
          size: obj.size,
          too_large: true,
          message: `This file is ${obj.size} bytes, over the ${MAX_READABLE_FILE_BYTES}-byte limit for a single read. Read it in chunks with read_file(path, offset, length) — start at offset 0, then use the next_offset it returns — or use search_file(path, query) to jump straight to the part you need.`,
        };
      }
      return { exists: true, content: await obj.text(), size: obj.size };
    },
    // Step 3: search WITHIN a file and get back only the matching lines (with line numbers, and
    // optional surrounding context) instead of pulling the whole file. Many matches are paged by
    // the generic tool-result paginator, so a broad query never overflows the turn. For a file too
    // large even to scan in one pass, use read_file's chunked offset/length reads.
    async search_file(args, ctx) {
      const path = reqStr(args, "path");
      const query = reqStr(args, "query");
      const k = key(ctx, path);
      const head = await bucket(ctx).head(k);
      if (!head) return { exists: false };
      if (head.size > MAX_SEARCHABLE_FILE_BYTES) {
        return {
          exists: true,
          too_large: true,
          size: head.size,
          message: `This file is ${head.size} bytes, over the ${MAX_SEARCHABLE_FILE_BYTES}-byte search limit. Read it in chunks with read_file(path, offset, length) and scan each chunk yourself.`,
        };
      }
      const obj = await bucket(ctx).get(k);
      if (!obj) return { exists: false };
      const text = await obj.text();
      const q = query.toLowerCase();
      const contextLines = Math.max(0, Math.min(numArg(args, "context") ?? 0, 10));
      const lines = text.split(/\r?\n/);
      const matches: Array<{ line_number: number; text: string; context?: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        if ((lines[i] ?? "").toLowerCase().includes(q)) {
          const entry: { line_number: number; text: string; context?: string } = {
            line_number: i + 1,
            text: lines[i] ?? "",
          };
          if (contextLines > 0) {
            entry.context = lines.slice(Math.max(0, i - contextLines), i + contextLines + 1).join("\n");
          }
          matches.push(entry);
        }
      }
      return { exists: true, query, total_matches: matches.length, matches };
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
