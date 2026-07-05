/**
 * workspace (§A1.17 Phase R) — explicit copy/move/list between the two DIFFERENT filesystems an
 * agent can use: 'r2' (Tier 1's r2-workspace — always available, small/text files, durable
 * across restarts) and 'container' (the Tier-5 sandbox's own local disk — large/binary/
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

type WorkspaceName = "r2" | "container";

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
  if (v !== "r2" && v !== "container") throw new Error(`'${name}' must be 'r2' or 'container'`);
  return v;
}

async function readOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string): Promise<string | null> {
  if (ws === "r2") {
    const obj = await bucket(ctx).get(key(ctx, path));
    return obj ? obj.text() : null;
  }
  if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
  const { files } = await ctx.env.containerWorkspace.read([path]);
  return files[path] ?? null;
}

async function writeOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string, content: string): Promise<void> {
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

export const workspace: PrebuiltScript = {
  name: "workspace",
  description:
    "Copy, move, or list files between the R2 workspace (always available, durable, small/text) " +
    "and the Tier-5 container's own local disk (large/binary/stateful-capable, but only persists " +
    "while that container stays warm — copy anything worth keeping back to R2 before finishing).",
  domain: "filesystem",
  requires_tier: 1,
  operations: {
    async "workspace.list"(args, ctx) {
      const name = reqWorkspace(args, "name");
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
