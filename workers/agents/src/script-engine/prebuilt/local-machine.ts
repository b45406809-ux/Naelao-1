/**
 * local-machine (§A1.17 Phase M) — "Local PC as a Container Target" (spec gap G-3). Lets an
 * agent read/write files or run an allowlisted command on a builder's OWN machine, through the
 * Naelao Local Agent client's WebSocket tunnel (LocalTunnelDO). Tier 2 (pure orchestration; the
 * actual work happens on the remote machine, not in this isolate).
 *
 * Security model — grant-checked BEFORE the tunnel is ever touched:
 *   1. Load this space's active `local_grants` (spaces worker, §A1.17 Phase M migration v21).
 *      No grant exists by default — there is no implicit access to anyone's machine.
 *   2. Normalize the requested path (collapse `.`/`..` segments) and find the FIRST grant whose
 *      type covers the requested operation (read needs read|readwrite, write needs
 *      write|readwrite) AND whose `directory` is a real prefix of the normalized path — not a
 *      naive string prefix, which `/home/alice/allowed-evil` would incorrectly satisfy against a
 *      grant for `/home/alice/allowed`.
 *   3. For `exec`, the command must EXACTLY match one entry in the grant's allowlist — no prefix
 *      or substring matching, so `rm -rf /` cannot sneak in under a broader allowed command.
 *   4. The MATCHING grant's own `user_id` is what addresses the tunnel — a grant scoped to one
 *      project never lets a different project's run reach that same machine (see loadGrants'
 *      project_id filter), and there is no separate "which machine" parameter for the model to
 *      get wrong or spoof.
 * A denied request never reaches LocalTunnelDO at all. Mutating ops (`write_file`, `exec`) are
 * ordinary gate-worthy action names — the space's `assistant_policy` governs whether they need
 * human approval, same as every other prebuilt.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

interface LocalGrant {
  id: string;
  project_id: string | null;
  user_id: string;
  grant_type: "read" | "write" | "readwrite" | "exec";
  directory: string | null;
  commands: string[];
}

async function loadGrants(ctx: PrebuiltOpContext): Promise<LocalGrant[]> {
  if (!ctx.env.spacesWorker) throw new Error("local-machine unavailable: spaces worker binding not configured");
  const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker/spaces/${ctx.env.spaceId}/local-grants`, {
      headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token },
    })
  );
  if (!resp.ok) throw new Error(`local-machine: failed to load grants (${resp.status})`);
  const body = await resp.json<{ data: LocalGrant[] }>();
  // A grant with a project_id only applies to runs bound to THAT project; a space-wide grant
  // (project_id null) applies to any run, including the Space Assistant's (projectId absent).
  return (body.data || []).filter((g) => g.project_id === null || g.project_id === ctx.env.projectId);
}

/** Collapses `.`/`..` segments server-side so a grant check can't be bypassed by traversal. */
function normalizePath(p: string): string {
  const isAbsolute = p.startsWith("/");
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

/** True path-segment containment — NOT a naive string prefix (see module doc). */
function isWithinDirectory(normalizedTarget: string, grantDirectory: string): boolean {
  const dir = normalizePath(grantDirectory).replace(/\/+$/, "");
  return normalizedTarget === dir || normalizedTarget.startsWith(dir + "/");
}

function matchReadWriteGrant(grants: LocalGrant[], need: "read" | "write", normalizedPath: string): LocalGrant | null {
  for (const g of grants) {
    if (g.grant_type !== need && g.grant_type !== "readwrite") continue;
    if (!g.directory) continue;
    if (isWithinDirectory(normalizedPath, g.directory)) return g;
  }
  return null;
}

function matchExecGrant(grants: LocalGrant[], command: string): LocalGrant | null {
  for (const g of grants) {
    if (g.grant_type !== "exec") continue;
    if (g.commands.includes(command)) return g;
  }
  return null;
}

async function callTunnel(ctx: PrebuiltOpContext, userId: string, op: string, params: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.localTunnel) throw new Error("local-machine unavailable: no local tunnel configured in this environment");
  const result = await ctx.env.localTunnel.exec({ userId, op, params });
  if (!result.ok) throw new Error(result.error || `local.${op} failed`);
  return result.result;
}

async function readFile(ctx: PrebuiltOpContext, path: string): Promise<unknown> {
  if (!path) throw new Error("local.read_file requires a path");
  const normalized = normalizePath(path);
  const grants = await loadGrants(ctx);
  const grant = matchReadWriteGrant(grants, "read", normalized);
  if (!grant) throw new Error(`local.read_file denied: no active read grant covers '${path}' on this space`);
  return callTunnel(ctx, grant.user_id, "read_file", { path: normalized });
}

async function writeFile(ctx: PrebuiltOpContext, path: string, content: string): Promise<unknown> {
  if (!path) throw new Error("local.write_file requires a path");
  const normalized = normalizePath(path);
  const grants = await loadGrants(ctx);
  const grant = matchReadWriteGrant(grants, "write", normalized);
  if (!grant) throw new Error(`local.write_file denied: no active write grant covers '${path}' on this space`);
  return callTunnel(ctx, grant.user_id, "write_file", { path: normalized, content: content ?? "" });
}

async function execCommand(ctx: PrebuiltOpContext, command: string): Promise<unknown> {
  if (!command) throw new Error("local.exec requires a command");
  const grants = await loadGrants(ctx);
  const grant = matchExecGrant(grants, command);
  if (!grant) throw new Error(`local.exec denied: '${command}' is not in any active exec grant's allowlist for this space`);
  return callTunnel(ctx, grant.user_id, "exec", { command });
}

async function status(ctx: PrebuiltOpContext): Promise<unknown> {
  if (!ctx.env.localTunnel) return { configured: false, targets: [] };
  const grants = await loadGrants(ctx);
  const userIds = [...new Set(grants.map((g) => g.user_id))];
  if (userIds.length === 0) return { configured: true, targets: [], message: "no local-machine grants configured for this space" };
  const targets = await Promise.all(
    userIds.map(async (userId) => ({ user_id: userId, ...(await ctx.env.localTunnel!.status(userId)) }))
  );
  return { configured: true, targets };
}

export const localMachine: PrebuiltScript = {
  name: "local-machine",
  description:
    "Read/write files or run an explicitly allowlisted command on a builder's OWN machine, via " +
    "the Naelao Local Agent tunnel. Every action is checked against that space's active grants " +
    "BEFORE anything reaches the machine — there is no default access, and a grant is always a " +
    "specific directory or a specific set of exact commands, never a blanket 'do anything'.",
  domain: "container",
  requires_tier: 2,
  operations: {
    "local.read_file": (a, c) => readFile(c, String(a["path"] ?? "")),
    "local.write_file": (a, c) => writeFile(c, String(a["path"] ?? ""), String(a["content"] ?? "")),
    "local.exec": (a, c) => execCommand(c, String(a["command"] ?? "")),
    "local.status": (_a, c) => status(c),
  },
};
