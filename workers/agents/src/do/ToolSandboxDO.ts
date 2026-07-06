/**
 * ToolSandboxDO — Tier-5 compute. A Cloudflare Container attached to this Durable
 * Object (via `[[containers]]` in wrangler.toml). The agent spins one up on demand to actually
 * build and test the micro-tool's code — including scripts that need a real runtime (Node,
 * Python). This is CF-native: no external service, the DO owns the container lifecycle and
 * lets it sleep when idle.
 *
 * The container runs a tiny harness (see container/server.mjs) listening on 8080:
 *   POST /build            { code }        -> { built, tests_passed, logs }
 *   POST /exec             { name, code, args } -> { ok, result?, error?, logs }
 *   POST /workspace/read   { paths? }       -> { files }
 *   POST /workspace/write  { files }        -> { ok }
 *   POST /workspace/list   {}               -> { files: string[] }
 *   POST /workspace/delete { paths }        -> { ok }
 *
 * §A1.17 Phase K addressed this DO per PROJECT (sandbox:{space}:{project}, see
 * code-runner.ts's runContainer, unchanged) so every thread's agent in a project shares one
 * container. Phase R replaced that phase's blind full-materialize/collect around every /exec
 * call: a Cloudflare Container has no native R2 mount, but pretending one exists by silently
 * syncing everything on every call is neither honest about persistence (a script "sees" R2
 * content that's really just a snapshot from the start of the call) nor cheap (a 300-file/2MB/
 * 25MB tax on every single /exec, whether the script touches files or not). The container's own
 * /workspace disk now persists across calls to the SAME warm instance with NO R2 traffic, and
 * starts genuinely empty on a cold start — an agent explicitly moves files between R2 and the
 * container via the `workspace` prebuilt's copy/move/list ops (script-engine/prebuilt/
 * workspace.ts), which call straight through to the routes above with zero DO-side R2 logic at
 * all (the R2 side of a copy is a normal R2 read/write in that prebuilt, same bucket/prefix Tier
 * 1's r2-workspace already uses).
 *
 * WS-7 (audit plan) — DO-naming exception, documented not normalized: addressed by a plain
 * `sandbox:{spaceId}:{projectId}` key, not the HMAC-SHA256(tenantId, secret):type:id convention
 * SpaceDO/NaelaoAgentDO use (G-BA01). Same server-derived-key rationale as TaskDO's exception
 * (see its file header) — spaceId/projectId here are never raw client input forwarded as-is.
 * (The legacy BusinessDO code path used to address this same container class by a separate,
 * un-tenant-scoped `sandbox:{userId}` key — that whole code path was retired along with
 * BusinessDO, so this is the only sandbox-addressing scheme left.)
 */

import { DurableObject } from "cloudflare:workers";

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

const HARNESS_PORT = 8080;
const WORKSPACE_ROUTES = ["/workspace/read", "/workspace/write", "/workspace/list", "/workspace/delete"];

export class ToolSandboxDO extends DurableObject {
  private get container(): ContainerRuntime | undefined {
    return (this.ctx as unknown as { container?: ContainerRuntime }).container;
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.container;
    if (!container) {
      // No container runtime bound (e.g. local dev without containers). Both build/test and
      // workspace ops report the same honest "not available" — no simulated success.
      const url = new URL(request.url);
      if (WORKSPACE_ROUTES.some((r) => url.pathname.endsWith(r))) {
        return Response.json({ ok: false, error: "Tier-5 container runtime not available" }, { status: 503 });
      }
      return Response.json(
        { built: false, tests_passed: false, logs: "Tier-5 container runtime not available" },
        { status: 503 },
      );
    }

    // Cold-start the container on demand; it sleeps again when idle (configured via sleepAfter
    // in wrangler). /workspace is genuinely empty on a cold start (see the file header) — the
    // caller (workspace.copy) is responsible for staging anything it needs before running code
    // that depends on it.
    if (!container.running) {
      container.start({ enableInternet: false });
    }

    // /build, /exec, and every /workspace/* route all forward to the harness as-is now — this
    // DO no longer inspects or mutates the request/response for any of them.
    return container.getTcpPort(HARNESS_PORT).fetch(request);
  }
}
