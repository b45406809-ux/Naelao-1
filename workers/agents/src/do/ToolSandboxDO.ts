/**
 * ToolSandboxDO — Tier-5 compute. A Cloudflare Container attached to this Durable
 * Object (via `[[containers]]` in wrangler.toml). The agent (BusinessDO) spins one
 * up on demand to actually build and test the micro-tool's code — including scripts
 * that need a real runtime (Node, Python). This is CF-native: no external service,
 * the DO owns the container lifecycle and lets it sleep when idle.
 *
 * The container runs a tiny harness (see container/server.mjs) listening on 8080:
 *   POST /build { code }  ->  { built, tests_passed, logs }
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

export class ToolSandboxDO extends DurableObject {
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

    // Forward the build request to the harness inside the container.
    return container.getTcpPort(HARNESS_PORT).fetch(request);
  }
}
