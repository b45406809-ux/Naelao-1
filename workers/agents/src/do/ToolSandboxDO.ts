/**
 * ToolSandboxDO — Tier-5 compute. A Cloudflare Container attached to this Durable
 * Object (via `[[containers]]` in wrangler.toml). The agent (BusinessDO) spins one
 * up on demand to actually build and test the micro-tool's code — including scripts
 * that need a real runtime (Node, Python). This is CF-native: no external service,
 * the DO owns the container lifecycle and lets it sleep when idle.
 *
 * The container runs a tiny harness (see container/server.mjs) listening on 8080:
 *   POST /build { code }             -> { built, tests_passed, logs }
 *   POST /exec  { name, code, args } -> { ok, result?, error?, logs }
 *
 * §A1.17 Phase K: this DO is addressed per PROJECT now (sandbox:{space}:{project}, see
 * code-runner.ts's runContainer), not per agent — every thread's agent in a project shares one
 * container. A Cloudflare Container has no native R2 mount, so "R2-mounted" is implemented as an
 * application-level sync around every /exec call: this DO reads the project's R2 workspace
 * (workspacePrefix(), the SAME prefix Tier-1 r2-workspace already reads/writes), hands the files
 * to the harness to materialize under /workspace before running, and writes back whatever the
 * harness reports as /workspace's contents afterward — deleting anything the script removed. R2
 * is the persistent source of truth: a fresh container instance (post-sleep, post-restart) still
 * sees the same files because they're re-synced on every call, not relied upon to survive in the
 * container's own ephemeral disk.
 */

import { DurableObject } from "cloudflare:workers";
import { workspacePrefix } from "../script-engine/types.js";

// The container runtime surface exposed on DurableObjectState (cast to stay
// version-agnostic across @cloudflare/workers-types).
interface ContainerPort {
  fetch(request: Request): Promise<Response>;
}
interface ContainerRuntime {
  readonly running: boolean;
  start(opts?: { enableInternet?: boolean }): void;
  getTcpPort(port: number): ContainerPort;
}

interface ToolSandboxEnv {
  /** Same bucket the script-engine's Tier 1 r2-workspace reads/writes — one filesystem, whether
   *  a script runs at Tier 1 (direct R2) or Tier 5 (this container). */
  SCRIPTS_R2?: R2Bucket;
}

const HARNESS_PORT = 8080;

// Sync bounds — a Worker→Container request/response and R2 list/get calls all have real limits;
// these keep a single /exec call well inside them rather than attempting an unbounded mount.
// Generous enough for a working set of scripts/data files; a project that outgrows this needs
// the Container Marketplace tier (§A1.17 Phase L), not a bigger cap here.
const MAX_SYNC_FILES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per file
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB per /exec call, in + out combined budget

async function syncWorkspaceIn(
  bucket: R2Bucket,
  prefix: string
): Promise<{ files: Record<string, string>; preKeys: Set<string>; truncated: boolean }> {
  const files: Record<string, string> = {};
  const preKeys = new Set<string>();
  let truncated = false;
  let totalBytes = 0;
  let cursor: string | undefined;
  do {
    const listing = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    for (const o of listing.objects) {
      const relPath = o.key.slice(prefix.length);
      if (!relPath) continue;
      preKeys.add(relPath);
      if (Object.keys(files).length >= MAX_SYNC_FILES || o.size > MAX_FILE_BYTES || totalBytes + o.size > MAX_TOTAL_BYTES) {
        truncated = true;
        continue;
      }
      const obj = await bucket.get(o.key);
      if (!obj) continue;
      const text = await obj.text();
      files[relPath] = text;
      totalBytes += text.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return { files, preKeys, truncated };
}

async function syncWorkspaceOut(
  bucket: R2Bucket,
  prefix: string,
  filesOut: Record<string, string>,
  preKeys: Set<string>
): Promise<void> {
  const outKeys = new Set(Object.keys(filesOut));
  // Write everything the container reports (new + changed). R2 PUT is idempotent, so no need to
  // diff byte-for-byte first — the extra PUTs on unchanged files are a low-frequency, bounded cost.
  await Promise.all(
    Object.entries(filesOut).map(([relPath, content]) =>
      bucket.put(`${prefix}${relPath}`, content, { customMetadata: { updatedAt: Date.now().toString() } })
    )
  );
  // Delete anything that existed before the run but is gone from /workspace afterward — the
  // script deleted it, and the R2 workspace must reflect that (not resurrect it next sync).
  const deleted = [...preKeys].filter((k) => !outKeys.has(k));
  await Promise.all(deleted.map((relPath) => bucket.delete(`${prefix}${relPath}`)));
}

export class ToolSandboxDO extends DurableObject<ToolSandboxEnv> {
  private get container(): ContainerRuntime | undefined {
    return (this.ctx as unknown as { container?: ContainerRuntime }).container;
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.container;
    if (!container) {
      // No container runtime bound (e.g. local dev without containers). The tool
      // version simply stays `building` and cannot deploy — the §02 gate holds.
      return Response.json(
        { built: false, tests_passed: false, logs: "Tier-5 container runtime not available" },
        { status: 503 },
      );
    }

    // Cold-start the container on demand; it sleeps again when idle (configured
    // via sleepAfter in wrangler). Build/test is outbound-only, no inbound internet.
    if (!container.running) {
      container.start({ enableInternet: false });
    }

    const url = new URL(request.url);
    if (url.pathname.endsWith("/exec") && this.env.SCRIPTS_R2) {
      return this.execWithWorkspaceSync(request, container, this.env.SCRIPTS_R2);
    }

    // /build (legacy micro-tool build/test) and /exec-without-R2-bound forward as-is.
    return container.getTcpPort(HARNESS_PORT).fetch(request);
  }

  private async execWithWorkspaceSync(request: Request, container: ContainerRuntime, bucket: R2Bucket): Promise<Response> {
    const body = await request.json<{ name: string; code: string; args?: Record<string, unknown>; spaceId: string; projectId?: string }>().catch(() => null);
    if (!body?.spaceId) {
      // Malformed body — let the harness's own validation produce the error, just without sync.
      return container.getTcpPort(HARNESS_PORT).fetch(new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }));
    }

    const prefix = workspacePrefix({ spaceId: body.spaceId, ...(body.projectId ? { projectId: body.projectId } : {}) });
    const { files, preKeys, truncated } = await syncWorkspaceIn(bucket, prefix);

    const resp = await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: body.name, code: body.code, args: body.args ?? {}, workspace_files: files }),
    }));
    const result = await resp.json<{ ok: boolean; result?: unknown; error?: string; logs?: string; workspace_files_out?: Record<string, string> }>();

    if (result.workspace_files_out) {
      await syncWorkspaceOut(bucket, prefix, result.workspace_files_out, preKeys);
    }

    const { workspace_files_out: _drop, ...clientResult } = result;
    return Response.json(truncated ? { ...clientResult, workspace_sync_truncated: true } : clientResult, { status: resp.status });
  }
}
