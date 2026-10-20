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
import { deleteWorkspaceBytesCas, publishWorkspaceBytesCas, readBytesWithHash, sha256Bytes } from "../r2-cas.js";
import { documentClauseNodeId } from "@naelao/agent-sdk";

type WorkspaceName = "r2" | "container";

async function contentHash(content: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(content));
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
  if (typeof v !== "string" || v.length === 0) throw new Error(`'${name}' (string) is required`);
  return v;
}

function reqWorkspace(args: Record<string, unknown>, name: string): WorkspaceName {
  const v = args[name];
  if (v !== "r2" && v !== "container") throw new Error(`'${name}' must be 'r2' or 'container'`);
  return v;
}

async function writeR2Cas(ctx: PrebuiltOpContext, path: string, content: string, expectedHash: string | null): Promise<void> {
  const storageKey = key(ctx, path);
  await publishWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, new TextEncoder().encode(content), expectedHash);
}

async function deleteR2Cas(ctx: PrebuiltOpContext, path: string, expectedHash: string | null): Promise<void> {
  const storageKey = key(ctx, path);
  await deleteWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, expectedHash);
}

async function readOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string): Promise<string | null> {
  if (ws === "r2") {
    const obj = await readBytesWithHash(bucket(ctx), key(ctx, path));
    return obj ? new TextDecoder().decode(obj.bytes) : null;
  }
  if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
  const { files } = await ctx.env.containerWorkspace.read([path]);
  return files[path] ?? null;
}

async function writeOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string, content: string): Promise<void> {
  if (ws === "r2") {
    const current = await readBytesWithHash(bucket(ctx), key(ctx, path));
    await writeR2Cas(ctx, path, content, current?.hash ?? null);
    return;
  }
  if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
  const existing = await ctx.env.containerWorkspace.read([path]);
  const prior = existing.files[path];
  await ctx.env.containerWorkspace.write({ [path]: content }, { [path]: prior === undefined ? null : await contentHash(prior) });
}

async function deleteOne(ctx: PrebuiltOpContext, ws: WorkspaceName, path: string, expectedHash?: string): Promise<void> {
  if (ws === "r2") {
    await deleteR2Cas(ctx, path, expectedHash ?? null);
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
const WORKSPACE_LOCK_TTL_MS = 30_000;

async function withWorkspaceLock<T>(ctx: PrebuiltOpContext, keyName: string, work: () => Promise<T>): Promise<T> {
  // The host supplies runId for production runs. Tiny isolated script tests and local callers
  // without a ConcurrencyDO remain usable; every real agent run has both values and is forced
  // through the same namespaced lock gateway as the explicit lock prebuilt.
  if (!ctx.env.lockGateway || !ctx.env.runId) return work();
  const lock = await ctx.env.lockGateway.acquire({ key: `workspace:${keyName}`, holderId: ctx.env.runId, limit: 1, ttlMs: WORKSPACE_LOCK_TTL_MS });
  if (!lock.granted || !Number.isSafeInteger(lock.fencingToken) || !lock.fencingToken) throw new Error(`Workspace is busy: '${keyName}' is locked by another run`);
  try {
    return await work();
  } finally {
    await ctx.env.lockGateway.release({ key: `workspace:${keyName}`, holderId: ctx.env.runId, fencingToken: lock.fencingToken });
  }
}

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
      if (obj.customMetadata?.["deleted"] === "true") continue;
      if (obj.size !== o.size || totalBytes + obj.size > SYNC_MAX_TOTAL_BYTES) {
        skippedCount++;
        continue;
      }
      const relativePath = o.key.slice(wsPrefix.length);
      const bytes = await obj.arrayBuffer();
      if (bytes.byteLength !== obj.size || bytes.byteLength > SYNC_MAX_TOTAL_BYTES - totalBytes) {
        skippedCount++;
        continue;
      }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      files[relativePath] = text;
      totalBytes += bytes.byteLength;
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
    "document.replace_clause": "path, zero-based clause_index, exact expected_clause, and replacement. Uses a human-priority 15s node lease plus content-hash CAS; if another human is editing it, returns a proposal without changing the document.",
  },
  operations: {
    async "document.replace_clause"(args, ctx) {
      const path = reqStr(args, "path");
      const expected = reqStr(args, "expected_clause");
      const replacement = args["replacement"];
      const clauseIndex = args["clause_index"];
      if (typeof replacement !== "string" || !Number.isSafeInteger(clauseIndex) || (clauseIndex as number) < 0 || expected.length > 20_000 || replacement.length > 20_000 || expected.includes("\u0000") || replacement.includes("\u0000")) {
        throw new Error("invalid_document_clause_edit");
      }
      const projectId = ctx.env.projectId;
      const leaseGateway = ctx.env.documentNodeLeaseGateway;
      const holderId = ctx.env.runId ?? `agent:${ctx.env.agentId}`;
      if (!projectId || !leaseGateway) throw new Error("document_node_leases_unavailable");
      const nodeId = documentClauseNodeId(path, clauseIndex as number);
      const lease = await leaseGateway.claim({ projectId, nodeId, holderId, holderType: "AGENT" });
      if (!lease.acquired) return { ok: false, status: "proposal_required", node_id: nodeId, held_by: lease.heldBy, holder_type: lease.holderType, message: "A person is editing this clause. Preserve the requested replacement as a proposal for explicit human review; do not overwrite it." };
      try {
        const storageKey = key(ctx, path);
        const current = await readBytesWithHash(bucket(ctx), storageKey);
        if (!current) return { ok: false, status: "not_found", path };
        const source = new TextDecoder().decode(current.bytes);
        const clauses = source.split(/\n\s*\n/);
        if (clauses[clauseIndex as number] !== expected) return { ok: false, status: "revision_conflict", path, node_id: nodeId };
        clauses[clauseIndex as number] = replacement;
        if (!(await leaseGateway.renew({ projectId, nodeId, holderId, holderType: "AGENT" })).renewed) {
          return { ok: false, status: "proposal_required", node_id: nodeId, message: "The document edit lease was taken over; do not retry without a fresh read and human review." };
        }
        try {
          await publishWorkspaceBytesCas(ctx.env, bucket(ctx), storageKey, new TextEncoder().encode(clauses.join("\n\n")), current.hash);
        } catch (error) {
          if (error instanceof Error && error.message.includes("changed concurrently")) return { ok: false, status: "revision_conflict", path, node_id: nodeId };
          throw error;
        }
        return { ok: true, status: "updated", path, node_id: nodeId };
      } finally {
        await leaseGateway.release({ projectId, nodeId, holderId, holderType: "AGENT" });
      }
    },

    async "workspace.sync_to_container"(args, ctx) {
      if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
      const pathPrefix = typeof args["path"] === "string" ? (args["path"] as string) : "";
      return withWorkspaceLock(ctx, `r2-to-container:${pathPrefix}`, async () => {
        const { files, skipped_count, skipped_reason } = await readAllR2(ctx, pathPrefix);
        const count = Object.keys(files).length;
        if (count > 0) {
          const current = await ctx.env.containerWorkspace!.read(Object.keys(files));
          const expected = Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, current.files[path] === undefined ? null : await contentHash(current.files[path])] as const)));
          await ctx.env.containerWorkspace!.write(files, expected);
        }
        return { ok: true, synced_files_count: count, target: "container:/workspace", ...(skipped_count > 0 ? { skipped_count, skipped_reason } : {}) };
      });
    },

    async "workspace.sync_from_container"(_args, ctx) {
      if (!ctx.env.containerWorkspace) throw new Error("container workspace unavailable: TOOL_SANDBOX not configured");
      return withWorkspaceLock(ctx, "container-to-r2", async () => {
        const { files } = await ctx.env.containerWorkspace!.read();
        // Always process multi-file syncs in one canonical order. The current projection uses a
        // single enclosing lease and per-file CAS, but deterministic ordering also keeps future
        // per-file lock acquisition deadlock-free.
        const entries = Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        const snapshot = new Map<string, string | null>();
        for (const [path] of entries) {
          const observed = await readBytesWithHash(bucket(ctx), key(ctx, path));
          snapshot.set(path, observed?.hash ?? null);
        }
        for (const [path, content] of entries) await writeR2Cas(ctx, path, content, snapshot.get(path) ?? null);
        return { ok: true, synced_files_count: entries.length, target: "r2" };
      });
    },
    async "workspace.list"(args, ctx) {
      const name = reqWorkspace(args, "name");
      if (name === "r2") {
        const prefix = key(ctx, typeof args["path"] === "string" ? (args["path"] as string) : "");
        const out: string[] = [];
        let cursor: string | undefined;
        do {
          const listing = await bucket(ctx).list(cursor ? { prefix, cursor } : { prefix });
          for (const o of listing.objects) if (o.customMetadata?.["deleted"] !== "true") out.push(o.key.slice(workspacePrefix(ctx.env).length));
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
      return withWorkspaceLock(ctx, `copy:${from}:${path}:${to}:${destPath}`, async () => {
        const content = await readOne(ctx, from, path);
        if (content === null) throw new Error(`source file not found in ${from}: ${path}`);
        await writeOne(ctx, to, destPath, content);
        return { ok: true, from, to, path, to_path: destPath };
      });
    },

    async "workspace.move"(args, ctx) {
      const from = reqWorkspace(args, "from");
      const to = reqWorkspace(args, "to");
      const path = reqStr(args, "path");
      const destPath = typeof args["to_path"] === "string" ? (args["to_path"] as string) : path;
      if (from === to) throw new Error("'from' and 'to' must be different workspaces");
      return withWorkspaceLock(ctx, `move:${from}:${path}:${to}:${destPath}`, async () => {
        const content = await readOne(ctx, from, path);
        if (content === null) throw new Error(`source file not found in ${from}: ${path}`);
        await writeOne(ctx, to, destPath, content);
        await deleteOne(ctx, from, path, from === "r2" ? await sha256Bytes(new TextEncoder().encode(content)) : undefined);
        return { ok: true, from, to, path, to_path: destPath };
      });
    },
  },
};
