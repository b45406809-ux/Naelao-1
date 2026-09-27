/**
 * r2-workspace (spec §12.1) — maps file operations to Tier 1 direct R2.
 * Default for all agents. The R2 workspace is the agent's persistent filesystem; it
 * persists across sessions. Operations: read_file, write_file, list_directory,
 * delete_file, copy_file, move_file, stat_file, search_file — plus a second, Claude-Code-shaped
 * set of REPL primitives that share the SAME underlying store: Read (line-windowed), Edit
 * (surgical search-and-replace), Write (atomic write — literally the same op as write_file),
 * Grep (regex search across the whole workspace, not just one file), Glob (path-pattern
 * listing). Both sets stay callable forever — RENAMED_OPERATIONS (tool-surface.ts) also maps a
 * few lowercase aliases (read/edit/write/grep/glob/bash) onto these for a model that reaches for
 * the more familiar spelling.
 *
 * The matching observe script for this is observe_filesystem (see observe.ts).
 *
 * read_file's own result becomes part of THIS turn's reasoner payload immediately — it isn't
 * windowed down to a short observation until step-context.ts trims an OLDER step, which is too
 * late for a single oversized read. A multi-MB file (a customer-uploaded CSV, a large export)
 * read in full would blow a small model's ~24k-token context in one call. stat_file lets the
 * agent check size before committing to a read; read_file itself also refuses past
 * MAX_READABLE_FILE_BYTES rather than trusting the model to check first — same "structure over
 * prompts" reasoning as every other hard cap in this engine. Read/Edit/Grep carry their own,
 * independent size gates below — LINE-windowed reading needs the whole object's text in memory
 * to find line boundaries, so its ceiling is deliberately the higher MAX_SEARCHABLE_FILE_BYTES,
 * not the smaller MAX_READABLE_FILE_BYTES read_file uses for a true single-shot read.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { workspacePrefix } from "../types.js";
import { normalizeAvosPath, normalizeWorkspacePath } from "../workspace-paths.js";

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
  if (String(path).replaceAll("\\", "/").startsWith("/.avos/")) {
    const machinePath = normalizeAvosPath(String(path)).slice("/.avos/".length);
    return `${workspacePrefix(ctx.env).replace(/workspace\/$/, "avos/")}${machinePath}`;
  }
  const clean = normalizeWorkspacePath(String(path));
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

/** Cap on how large a file search_file/Read/Grep will read in one pass. Higher than the
 *  single-read cap because search returns only matching lines, not the whole file — but still
 *  bounded so a genuinely huge file is read in chunks via read_file(offset,length) instead. */
const MAX_SEARCHABLE_FILE_BYTES = 5_000_000;

/** Grep scans across the whole workspace, not one named file — bounded on BOTH files touched
 *  and matches found so a sparse query against a large workspace can't approach the platform's
 *  1000-subrequest-per-invocation ceiling (one R2 get per file scanned) or blow a turn's payload. */
const MAX_GREP_FILES_SCANNED = 300;
const MAX_GREP_MATCHES = 100;

async function writeFileImpl(
  ctx: PrebuiltOpContext,
  path: string,
  content: string
): Promise<{ ok: true; path: string; size: number }> {
  await bucket(ctx).put(key(ctx, path), content, {
    customMetadata: { updatedAt: Date.now().toString() },
  });
  // The file IS the handoff between projects: one project's agent records what it found, that
  // write fires an event, and a no-code rule wakes whoever owns the next stage. Fired after the
  // write actually succeeded, and never awaited — a listener failing must not turn a successful
  // write into a failed one.
  if (!path.replaceAll("\\", "/").startsWith("/.avos/")) {
    ctx.env.onWorkspaceChange?.({ path, operation: "write" });
  }
  return { ok: true, path, size: content.length };
}

/** Claude-Code-shaped windowed reader: 1-indexed LINE offset/limit, returned as
 *  `"<n> | <line>"` text the way an agent expects a file viewer to look. Distinct from
 *  read_file's byte-oriented offset/length — the two are NOT interchangeable, and existing
 *  callers of read_file (byte offsets) must keep working unchanged. */
async function readWindowed(
  ctx: PrebuiltOpContext,
  path: string,
  offsetLines?: number,
  limitLines?: number
): Promise<{
  exists: boolean;
  content?: string;
  lines_total?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  too_large?: boolean;
  size?: number;
  message?: string;
}> {
  const head = await bucket(ctx).head(key(ctx, path));
  if (!head) return { exists: false };
  if (head.size > MAX_SEARCHABLE_FILE_BYTES) {
    return {
      exists: true,
      too_large: true,
      size: head.size,
      message: `This file is ${head.size} bytes, over the ${MAX_SEARCHABLE_FILE_BYTES}-byte limit for a windowed read. Use search_file/Grep to jump to the part you need, or read_file(path, offset, length) for a true byte-chunked read.`,
    };
  }
  const obj = await bucket(ctx).get(key(ctx, path));
  if (!obj) return { exists: false };
  const allLines = (await obj.text()).split(/\r?\n/);
  const total = allLines.length;
  const start = Math.max(1, offsetLines ?? 1);
  const count = Math.max(1, Math.min(limitLines ?? 2000, 2000));
  const slice = allLines.slice(start - 1, start - 1 + count);
  const padWidth = String(start + Math.max(0, slice.length - 1)).length;
  const content = slice.map((line, idx) => `${String(start + idx).padStart(padWidth, " ")} | ${line}`).join("\n");
  const hasMore = start - 1 + count < total;
  return {
    exists: true,
    content,
    lines_total: total,
    offset: start,
    limit: count,
    ...(hasMore ? { has_more: true } : { has_more: false }),
  };
}

/** Surgical single-occurrence search-and-replace. Refuses (rather than guessing) when the exact
 *  text isn't found — returning nearby lines sharing a keyword so the model can self-correct
 *  without a wasted extra Read round-trip — and refuses when the match is ambiguous (>1
 *  occurrence), since replacing "the wrong one" silently is worse than asking for more context. */
async function editFile(
  ctx: PrebuiltOpContext,
  path: string,
  oldString: string,
  newString: string
): Promise<{ ok: boolean; path: string; replacements?: number; error?: string; hint?: string }> {
  if (!oldString) throw new Error("'oldString' (string) is required");
  const head = await bucket(ctx).head(key(ctx, path));
  if (!head) return { ok: false, path, error: `File not found: ${path}` };
  if (head.size > MAX_READABLE_FILE_BYTES) {
    return {
      ok: false,
      path,
      error: `This file is ${head.size} bytes, over the ${MAX_READABLE_FILE_BYTES}-byte limit for Edit. Use read_file(path, offset, length) to inspect it in chunks instead.`,
    };
  }
  const obj = await bucket(ctx).get(key(ctx, path));
  if (!obj) return { ok: false, path, error: `File not found: ${path}` };
  const content = await obj.text();

  if (!content.includes(oldString)) {
    const searchLines = oldString.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3);
    const fileLines = content.split(/\r?\n/);
    const nearbyHints: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < fileLines.length; i++) {
      const fl = fileLines[i] ?? "";
      if (searchLines.some((sl) => fl.includes(sl))) {
        nearbyHints.push({ line: i + 1, text: fl.trim().slice(0, 100) });
        if (nearbyHints.length >= 4) break;
      }
    }
    const hint =
      nearbyHints.length > 0
        ? `oldString was not found verbatim. Possibly nearby (line ${nearbyHints[0]!.line}):\n` +
          nearbyHints.map((h) => `  ${h.line}: ${h.text}`).join("\n")
        : `oldString was not found in ${path}. Read it first to get the exact current text.`;
    return { ok: false, path, error: "target_string_not_found", hint };
  }

  const occurrences = content.split(oldString).length - 1;
  if (occurrences > 1) {
    return {
      ok: false,
      path,
      error: `oldString matched ${occurrences} times in ${path} — include more surrounding lines in oldString so the replacement is unambiguous.`,
    };
  }

  const patched = content.replace(oldString, newString);
  await writeFileImpl(ctx, path, patched);
  return { ok: true, path, replacements: 1 };
}

/** Regex search across every file under a prefix (the whole workspace, or a narrower path) —
 *  distinct from search_file, which searches ONE named file. Bounded on files scanned AND
 *  matches found; a search that hits either cap says so rather than silently stopping. */
async function grepWorkspace(
  ctx: PrebuiltOpContext,
  pattern: string,
  pathPrefix = ""
): Promise<{
  pattern: string;
  total_matches: number;
  matches: Array<{ file: string; line_number: number; text: string }>;
  files_scanned: number;
  truncated: boolean;
}> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    throw new Error(`'${pattern}' is not a valid regular expression`);
  }
  const prefix = key(ctx, pathPrefix);
  const wsPrefix = workspacePrefix(ctx.env);
  const matches: Array<{ file: string; line_number: number; text: string }> = [];
  let filesScanned = 0;
  let cursor: string | undefined;
  let truncated = false;
  do {
    const listing = await bucket(ctx).list(cursor ? { prefix, cursor } : { prefix });
    for (const objMeta of listing.objects) {
      if (objMeta.key.endsWith("/.keep") || objMeta.size > MAX_SEARCHABLE_FILE_BYTES) continue;
      if (filesScanned >= MAX_GREP_FILES_SCANNED) { truncated = true; break; }
      filesScanned++;
      const fileObj = await bucket(ctx).get(objMeta.key);
      if (!fileObj) continue;
      const lines = (await fileObj.text()).split(/\r?\n/);
      const relativePath = objMeta.key.slice(wsPrefix.length);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          matches.push({ file: relativePath, line_number: i + 1, text: line.trim().slice(0, 300) });
          if (matches.length >= MAX_GREP_MATCHES) { truncated = true; break; }
        }
      }
      if (matches.length >= MAX_GREP_MATCHES) break;
    }
    cursor = listing.truncated && !truncated ? listing.cursor : undefined;
  } while (cursor);

  return { pattern, total_matches: matches.length, matches, files_scanned: filesScanned, truncated };
}

/**
 * Glob-to-RegExp translation, a single left-to-right token scan rather than a chain of
 * `.replace()` calls. (Note for anyone editing this comment: never write the two characters
 * star-slash next to each other in here, even inside backticks — it closes a block comment.)
 * A naive replace-chain (convert a double-star to a placeholder, THEN a single star to
 * `[^` + slash + `]*`, then swap the placeholder for `.*`) has two real failure modes, both
 * caught by this port's own tests:
 *   1. Re-matching: if the placeholder swap runs before the single-star pass, the star inside
 *      the just-inserted `.*` gets rewritten again, corrupting "cross any directory depth" into
 *      "exactly one path segment".
 *   2. Even done in the right order, treating a double-star-then-slash as two independent
 *      tokens ("cross any depth", then a literal slash) makes the slash MANDATORY — so a
 *      pattern like double-star, slash, star, ".ts" (which must ALSO match a root-level file
 *      with zero directories, e.g. `top.ts`, per standard glob semantics) could never match
 *      anything without a slash in it. Double-star-then-slash has to be recognized as ONE unit
 *      and translated to an OPTIONAL group.
 * A bare double-star not immediately followed by a slash still means "cross any depth" (`.*`);
 * `?` is a single-char wildcard, matching standard glob conventions.
 */
function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    const c = pattern[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) out += "\\" + c;
    else out += c;
    i++;
  }
  return new RegExp(`^${out}$`);
}

async function globWorkspace(
  ctx: PrebuiltOpContext,
  pattern: string | undefined,
  pathPrefix = ""
): Promise<{ path: string; files: string[]; count: number; truncated: boolean }> {
  const prefix = key(ctx, pathPrefix);
  const wsPrefix = workspacePrefix(ctx.env);
  const allFiles: string[] = [];
  let cursor: string | undefined;
  let truncated = false;
  const CAP = 2000;
  do {
    const listing = await bucket(ctx).list(cursor ? { prefix, cursor } : { prefix });
    for (const obj of listing.objects) {
      if (obj.key.endsWith("/.keep")) continue;
      allFiles.push(obj.key.slice(wsPrefix.length));
      if (allFiles.length >= CAP) { truncated = true; break; }
    }
    cursor = listing.truncated && !truncated ? listing.cursor : undefined;
  } while (cursor);

  if (!pattern || pattern === "*" || pattern === "**") {
    return { path: pathPrefix, files: allFiles, count: allFiles.length, truncated };
  }
  const re = globToRegex(pattern);
  const filtered = allFiles.filter((f) => re.test(f));
  return { path: pathPrefix, files: filtered, count: filtered.length, truncated };
}

export const r2Workspace: PrebuiltScript = {
  name: "r2-workspace",
  description:
    "Read, write, list, delete, copy and move files in the agent's R2 workspace. read_file " +
    "supports chunked byte reads (offset/length) for files too big to read at once; stat_file " +
    "checks size first; search_file finds matching lines inside ONE named file. Read/Edit/Write/" +
    "Grep/Glob are the same workspace through a Claude-Code-shaped lens: Read is a line-numbered " +
    "windowed view, Edit is a surgical exact-text replace, Grep searches ACROSS every file (not " +
    "just one), Glob lists paths matching a pattern like '**/*.ts'.",
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
    Read: "path (string, REQUIRED). offset (number, optional — 1-indexed LINE to start at). limit " +
      "(number, optional — line count, default/max 2000). Returns `\"<n> | <line>\"` text, LINE " +
      "numbers not bytes — different from read_file's byte offset/length. Refused past 5MB; use " +
      "Grep or read_file's byte-chunked reads on anything bigger.",
    Edit: "path (string, REQUIRED). oldString (string, REQUIRED — the EXACT text to replace, must " +
      "match exactly once). newString (string, REQUIRED). Read the file first if unsure of the " +
      "exact current text — a near-miss returns nearby lines as a hint, never guesses.",
    Write: "path (string, REQUIRED). content (string, REQUIRED). Identical to write_file.",
    Grep: "pattern (string, REQUIRED — a regular expression). path (string, optional — a prefix to " +
      "search under; omit for the whole workspace). Searches every file under the prefix, not one " +
      "— for one named file use search_file instead.",
    Glob: "pattern (string, optional — e.g. '**/*.ts'; omit or '*'/'**' for every file). path " +
      "(string, optional prefix).",
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

    // ── Claude-Code-shaped REPL primitives — same workspace, different lens (see file header) ──
    async Read(args, ctx) {
      return readWindowed(ctx, reqStr(args, "path"), numArg(args, "offset"), numArg(args, "limit"));
    },
    async Edit(args, ctx) {
      const newString = args["newString"];
      return editFile(
        ctx,
        reqStr(args, "path"),
        reqStr(args, "oldString"),
        typeof newString === "string" ? newString : ""
      );
    },
    async Write(args, ctx) {
      return writeFileImpl(ctx, reqStr(args, "path"), reqStr(args, "content"));
    },
    async Grep(args, ctx) {
      const p = args["path"];
      return grepWorkspace(ctx, reqStr(args, "pattern"), typeof p === "string" ? p : "");
    },
    async Glob(args, ctx) {
      const pattern = args["pattern"];
      const p = args["path"];
      return globWorkspace(
        ctx,
        typeof pattern === "string" ? pattern : undefined,
        typeof p === "string" ? p : ""
      );
    },
  },
};
