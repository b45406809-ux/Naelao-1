/**
 * workspace (§A1.17 Phase R) — explicit copy/move/list between the filesystems an
 * agent can use: 'sqlite' (Tier 1 authoritative Virtual FS in DO SQLite), 'r2' (R2 object storage),
 * and 'container' (the Tier-5 sandbox's own local disk — large/binary/
 * stateful-capable, e.g. real database data files or a full git clone, but only persists while
 * that specific container instance stays warm; genuinely empty on a cold start).
 *
 * This is deliberately NOT an implicit sync — the agent reasons about which workspace has what
 * and moves files on purpose, the same way it would think about two different machines. The R2
 * side of every op is an ordinary read/write against the SAME bucket/prefix r2-workspace.ts
 * already uses; the container side goes through ContainerWorkspaceGateway (ToolSandboxDO).
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { workspacePrefix } from "../types.js";

type WorkspaceName = "sqlite" | "r2" | "container";

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
  if (typeof v !== "string" || v.length === 0) throw new Error(`'${name}' (string) is required`);
  return v;
}

function reqWorkspace(args: Record<string, unknown>, name: string): WorkspaceName {
  const v = args[name];
  if (v !== "sqlite" && v !== "r2" && v !== "container") throw new Error(`'${name}' must be 'sqlite', 'r2' or 'container'`);
  return v;
}

async function readFromSqlite(ctx: PrebuiltOpContext, path: string): Promise<string | null> {
  try {
    const res = await (ctx.env as any).agentDo?.fetch(`http://internal/workspace/sqlite/read?path=${encodeURIComponent(path)}`);
    if (!res || !res.ok) return null;
    const data = await res.json() as any;
    return data.file?.content ?? null;
  } catch {
    return null;
  }
}

async function writeToSqlite(ctx: PrebuiltOpContext, path: string, content: string): Promise<void> {
  await (ctx.env as any).agentDo?.fetch(`http://internal/workspace/sqlite/write`, {
    method: "POST",
    body: JSON.stringify({ path, content })
  });
}

async function readOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string): Promise<string | null> {
  if (ws === "sqlite") return readFromSqlite(ctx, path);
  if (ws === "r2") {
    const obj = await bucket(ctx).get(key(ctx, path));
    return obj ? obj.text() : null;
  }
  if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
  const { files } = await ctx.env.containerWorkspace.read([path]);
  return files[path] ?? null;
}

async function writeOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string, content: string): Promise<void> {
  if (ws === "sqlite") return writeToSqlite(ctx, path, content);
  if (ws === "r2") {
    await bucket(ctx).put(key(ctx, path), content, { customMetadata: { updatedAt: Date.now().toString() } });
    return;
  }
  if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
  await ctx.env.containerWorkspace.write({ [path]: content });
}

async function deleteOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string): Promise<void> {
  if (ws === "r2") {
    await bucket(ctx).delete(key(ctx, path));
    return;
  }
  if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
  await ctx.env.containerWorkspace.remove([path]);
}

/** Every R2 workspace key under this run's prefix, as {relativePath: content} — the bulk-read
 *  half of workspace.sync_to_container. Deliberately bounded (a container's disk and a single
 *  write() call both have real limits, unlike R2 itself): a workspace with more than
 *  SYNC_MAX_FILES or whose total content exceeds SYNC_MAX_TOTAL_BYTES reports what it skipped
 *  rather than silently truncating or failing outright. */
const SYNC_MAX_FILES = 500;
const SYNC_MAX_TOTAL_BYTES = 20_000_000;

async function readAllR2(
  ctx: PrebuiltOpContext,
  pathPrefix: string
): Promise<{ files: Record<string, string>; skipped_count: number; skipped_reason?: string }> {
  const prefix = key(ctx, pathPrefix);
  const wsPrefix = workspacePrefix(ctx.env);
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let skippedCount = 0;
  let cursor: string | undefined;
  do {
    const listing = await bucket(ctx).list(cursor ? { prefix, cursor } : { prefix });
    for (const o of listing.objects) {
      if (o.key.endsWith("/.keep")) continue;
      if (Object.keys(files).length >= SYNC_MAX_FILES || totalBytes + o.size > SYNC_MAX_TOTAL_BYTES) {
        skippedCount++;
        continue;
      }
      const obj = await bucket(ctx).get(o.key);
      if (!obj) continue;
      const relativePath = o.key.slice(wsPrefix.length);
      const text = await obj.text();
      files[relativePath] = text;
      totalBytes += text.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return {
    files,
    skipped_count: skippedCount,
    ...(skippedCount > 0
      ? { skipped_reason: `over the ${SYNC_MAX_FILES}-file / ${SYNC_MAX_TOTAL_BYTES}-byte sync limit — sync a narrower 'path' prefix, or workspace.copy the specific files you need.` }
      : {}),
  };
}

export const workspace: PrebuiltScript = {
  name: "workspace",
  description:
    "Copy, move, or list files between the R2 workspace (always available, durable, small/text) " +
    "and the Tier-5 container's own local disk (large/binary/stateful-capable, but only persists " +
    "while that container stays warm — copy anything worth keeping back to R2 before finishing). " +
    "sync_to_container/sync_from_container bulk-copy EVERY file under a prefix in one call, for " +
    "when you need the whole project staged rather than one file at a time.",
  domain: "filesystem",
  requires_tier: 1,
  paramHints: {
    "workspace.sync_to_container": "path (string, optional prefix — omit to sync the whole R2 " +
      `workspace; bounded at ${SYNC_MAX_FILES} files / ${SYNC_MAX_TOTAL_BYTES} bytes total).`,
    "workspace.sync_from_container": "No arguments — copies every file the container currently " +
      "has back into the R2 workspace, at the SAME relative paths.",
  },
  operations: {
    async "workspace.sync_to_container"(args, ctx) {
      if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
      const prefix = typeof args["prefix"] === "string" ? (args["prefix"] as string) : (typeof args["path"] === "string" ? (args["path"] as string) : "");
      
      // 1. Fetch files from authoritative SQLite Virtual FS
      let bundle: Record<string, string> = {};
      try {
        const listRes = await (ctx.env as any).agentDo?.fetch(`http://internal/workspace/sqlite/list?prefix=${encodeURIComponent(prefix)}`);
        const fileList = listRes && listRes.ok ? (await listRes.json() as any).files : [];
        if (fileList && fileList.length > 0) {
          for (const item of fileList) {
            const content = await readFromSqlite(ctx, item.path);
            if (content !== null) bundle[item.path] = content;
          }
        }
      } catch {
        // fallback
      }

      if (Object.keys(bundle).length === 0) {
        const { files } = await readAllR2(ctx, prefix);
        bundle = files;
      }

      // 2. Stage into Container Disk
      const count = Object.keys(bundle).length;
      if (count > 0) await ctx.env.containerWorkspace.write(bundle);
      return {
        ok: true,
        synced_files_count: count,
        target: "container:/workspace",
      };
    },

    async "workspace.sync_from_container"(_args, ctx) {
      if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
      const { files } = await ctx.env.containerWorkspace.read();
      const entries = Object.entries(files);
      for (const [path, content] of entries) {
        await writeToSqlite(ctx, path, content);
        await bucket(ctx).put(key(ctx, path), content, { customMetadata: { updatedAt: Date.now().toString() } });
      }
      return { ok: true, synced_files_count: entries.length, target: "r2" };
    },
    async "workspace.list"(args, ctx) {
      const name = reqWorkspace(args, "name");
      if (name === "sqlite") {
        const prefix = typeof args["path"] === "string" ? (args["path"] as string) : "";
        try {
          const listRes = await (ctx.env as any).agentDo?.fetch(`http://internal/workspace/sqlite/list?prefix=${encodeURIComponent(prefix)}`);
          const rows = listRes && listRes.ok ? (await listRes.json() as any).files : [];
          return { workspace: "sqlite", files: rows.map((r: any) => r.path) };
        } catch {
          return { workspace: "sqlite", files: [] };
        }
      }
      if (name === "r2") {
        const prefix = key(ctx, typeof args["path"] === "string" ? (args["path"] as string) : "");
        const out: string[] = [];
        let cursor: string | undefined;
        do {
          const listing = await bucket(ctx).list(cursor ? { prefix, cursor } : { prefix });
          for (const o of listing.objects) out.push(o.key.slice(workspacePrefix(ctx.env).length));
          cursor = listing.truncated ? listing.cursor : undefined;
        } while (cursor);
        return { workspace: "r2", files: out };
      }
      if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
      const { files } = await ctx.env.containerWorkspace.list();
      return { workspace: "container", files };
    },

    async "workspace.copy"(args, ctx) {
      const from = reqWorkspace(args, "from");
      const to = reqWorkspace(args, "to");
      const path = reqStr(args, "path");
      const destPath = typeof args["to_path"] === "string" ? (args["to_path"] as string) : path;
      if (from === to) throw new Error("'from' and 'to' must be different workspaces");
      const content = await readOne(ctx, from, path);
      if (content === null) throw new Error(`source file not found in ${from}: ${path}`);
      await writeOne(ctx, to, destPath, content);
      return { ok: true, from, to, path, to_path: destPath };
    },

    async "workspace.move"(args, ctx) {
      const from = reqWorkspace(args, "from");
      const to = reqWorkspace(args, "to");
      const path = reqStr(args, "path");
      const destPath = typeof args["to_path"] === "string" ? (args["to_path"] as string) : path;
      if (from === to) throw new Error("'from' and 'to' must be different workspaces");
      const content = await readOne(ctx, from, path);
      if (content === null) throw new Error(`source file not found in ${from}: ${path}`);
      await writeOne(ctx, to, destPath, content);
      await deleteOne(ctx, from, path);
      return { ok: true, from, to, path, to_path: destPath };
    },
  },
};
