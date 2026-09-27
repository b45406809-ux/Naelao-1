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
  stop?(signal?: string): Promise<void> | void;
}

const HARNESS_PORT = 8080;
const WORKSPACE_ROUTES = [
  "/workspace/read",
  "/workspace/write",
  "/workspace/list",
  "/workspace/delete",
];

interface StoredShellState {
  cwd: string;
  env: Record<string, string>;
  gitHead: string;
  revision: number;
}

export class ToolSandboxDO extends DurableObject {
  private lastUsedAt = Date.now();

  private get container(): ContainerRuntime | undefined {
    return (this.ctx as unknown as { container?: ContainerRuntime }).container;
  }

  override async alarm(): Promise<void> {
    const lastUsed =
      (await this.ctx.storage.get<number>("last_used_at")) ?? this.lastUsedAt;
    if (Date.now() - lastUsed >= 60_000) {
      const container = this.container;
      if (container?.running) {
        const port = container.getTcpPort(HARNESS_PORT);
        const snapshot: { files?: Record<string, string> } = await port.fetch(new Request("http://sandbox/workspace/read", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).then((r) => r.json<{ files?: Record<string, string> }>()).catch(() => ({}));
        if (snapshot.files) await this.ctx.storage.put("workspace_snapshot", snapshot.files);
        await port.fetch(new Request("http://sandbox/shutdown", { method: "POST" })).catch(() => undefined);
        await container.stop?.("SIGTERM");
      }
      await this.ctx.storage.put("container_status", "hibernated");
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lastUsedAt = Date.now();
    await this.ctx.storage.put("last_used_at", this.lastUsedAt);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);

    if (url.pathname === "/session/state" && request.method === "POST") {
      const current = (await this.ctx.storage.get<StoredShellState>(
        "shell_state"
      )) ?? { cwd: "/workspace", env: {}, gitHead: "main", revision: 1 };
      const body: {
        expected_revision?: number;
        patch?: Partial<StoredShellState>;
      } = await request
        .json<{
          expected_revision?: number;
          patch?: Partial<StoredShellState>;
        }>()
        .catch(() => ({}));
      if (
        body.expected_revision !== undefined &&
        body.expected_revision !== current.revision
      ) {
        return Response.json(
          { error: "workspace_state_conflict", revision: current.revision },
          { status: 409 }
        );
      }
      const next: StoredShellState = {
        ...current,
        ...(body.patch ?? {}),
        env: { ...current.env, ...(body.patch?.env ?? {}) },
        revision: current.revision + 1,
      };
      await this.ctx.storage.put("shell_state", next);
      return Response.json(next);
    }

    const container = this.container;
    if (!container) {
      // No container runtime bound (e.g. local dev without containers). Both build/test and
      // workspace ops report the same honest "not available" — no simulated success.
      if (WORKSPACE_ROUTES.some((r) => url.pathname.endsWith(r))) {
        return Response.json(
          { ok: false, error: "Tier-6 container runtime not available" },
          { status: 503 }
        );
      }
      return Response.json(
        {
          built: false,
          tests_passed: false,
          logs: "Tier-6 container runtime not available",
        },
        { status: 503 }
      );
    }

    // Cold-start the container on demand; it sleeps again when idle (configured via sleepAfter
    // in wrangler). /workspace is genuinely empty on a cold start (see the file header) — the
    // caller (workspace.copy) is responsible for staging anything it needs before running code
    // that depends on it.
    if (!container.running) {
      container.start({ enableInternet: false });
      await this.ctx.storage.put("container_status", "running");
      const snapshot = await this.ctx.storage.get<Record<string, string>>("workspace_snapshot");
      if (snapshot && Object.keys(snapshot).length) {
        await container.getTcpPort(HARNESS_PORT).fetch(new Request("http://sandbox/workspace/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: snapshot }) }));
      }
    }

    // /build, /exec, and every /workspace/* route all forward to the harness as-is now — this
    // DO no longer inspects or mutates the request/response for any of them.
    return container.getTcpPort(HARNESS_PORT).fetch(request);
  }
}
