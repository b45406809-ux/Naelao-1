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
  stop?(): Promise<void> | void;
}

const HARNESS_PORT = 8080;
const WORKSPACE_ROUTES = ["/workspace/read", "/workspace/write", "/workspace/list", "/workspace/delete"];

export class ToolSandboxDO extends DurableObject {
  private lastCommandAt: number = Date.now();

  private get container(): ContainerRuntime | undefined {
    return (this.ctx as unknown as { container?: ContainerRuntime }).container;
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.container;
    const url = new URL(request.url);

    this.lastCommandAt = Date.now();
    // Schedule 60s scale-to-zero micro-sleep countdown alarm
    await this.ctx.storage.setAlarm(Date.now() + 60000).catch(() => {});

    if (url.pathname === "/exec-grpc") {
      const body = (await request.json().catch(() => ({}))) as {
        command?: string;
        code?: string;
        cwd?: string;
        envVars?: Record<string, string>;
        branch?: string;
        name?: string;
        args?: Record<string, unknown>;
      };

      const cmd = body.command || body.code || "";
      const cwd = body.cwd || "/workspace";
      const envVars = body.envVars || {};
      const branch = body.branch || "main";

      if (!container) {
        return Response.json(
          {
            ok: false,
            stdout: "",
            stderr: "Tier-5 container runtime not available",
            exitCode: 1,
            error: "Tier-5 container runtime not available",
            durationMs: 0,
          },
          { status: 503 }
        );
      }

      if (!container.running) {
        container.start({ enableInternet: false });
      }

      const result = await this.executeInContainer(cmd, cwd, envVars, branch);
      return Response.json(result);
    }

    if (!container) {
      // No container runtime bound (e.g. local dev without containers). Both build/test and
      // workspace ops report the same honest "not available" — no simulated success.
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

  // Scale-to-zero alarm handler
  override async alarm(): Promise<void> {
    const idleTime = Date.now() - this.lastCommandAt;
    if (idleTime >= 60000) {
      console.log("😴 60s idle threshold reached. Micro-sleeping container instance...");
      await this.shutdownContainerProcess();
    }
  }

  private async shutdownContainerProcess(): Promise<void> {
    const container = this.container;
    if (container && typeof container.stop === "function") {
      try {
        await container.stop();
      } catch (err) {
        console.warn("[ToolSandboxDO] Container shutdown warning:", err);
      }
    }
  }

  private async executeInContainer(
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    branch: string = "main"
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    result?: unknown;
    error?: string;
  }> {
    const startTime = Date.now();
    const container = this.container;
    if (!container) {
      return {
        ok: false,
        stdout: "",
        stderr: "Container runtime unavailable",
        exitCode: 1,
        error: "Container runtime unavailable",
        durationMs: 0,
      };
    }

    try {
      // Execute command inside container userland with injected CWD and ENV
      const harnessPort = container.getTcpPort(HARNESS_PORT);
      const resp = await harnessPort.fetch(
        new Request("http://sandbox/exec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: cmd,
            command: cmd,
            cwd,
            envVars: env,
            branch,
          }),
        })
      );

      const durationMs = Date.now() - startTime;
      if (resp.ok) {
        const data = await resp.json<{ ok?: boolean; result?: unknown; stdout?: string; stderr?: string; logs?: string; exitCode?: number; error?: string }>().catch(() => ({}));
        const ok = data.ok !== false;
        return {
          ok,
          stdout: data.stdout || (typeof data.result === "string" ? data.result : data.logs || `Executed in container at ${cwd}`),
          stderr: data.stderr || (ok ? "" : data.error || ""),
          exitCode: data.exitCode ?? (ok ? 0 : 1),
          result: data.result,
          error: data.error,
          durationMs,
        };
      }

      const errText = await resp.text().catch(() => "");
      return {
        ok: false,
        stdout: "",
        stderr: errText || `Container harness returned ${resp.status}`,
        exitCode: 1,
        error: errText || `Container harness returned ${resp.status}`,
        durationMs,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        stdout: "",
        stderr: message,
        exitCode: 1,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
  }
}
