import { describe, it, expect } from "vitest";
import { mcpConnector } from "../../workers/agents/src/script-engine/prebuilt/mcp-connector.js";
import { verifyInternalToken } from "@naelao/http";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// §A1.17 Phase I: mcp-hub now gates its routes with requireInternalHmac — mcp-connector (the
// prebuilt op client, distinct from the new ctx.mcp isolate loopback) must mint a real,
// verifiable token instead of relying on the identity headers alone. Mirrors the commerce
// prebuilt's precedent (tests/unit/commerce-prebuilt-hmac.test.ts).

const PLATFORM_SECRET = "test-platform-secret";

function makeEnv(capture: { headers?: Record<string, string> }, responder?: () => unknown): ScriptEngineEnv {
  const mcpHubWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      capture.headers = headers;
      return Response.json(responder ? responder() : { data: [] });
    },
  };
  return {
    scriptsBucket: {} as never,
    spaceId: "space-1",
    tenantId: "tenant-1",
    agentId: "agent-1",
    platformSecret: PLATFORM_SECRET,
    mcpHubWorker: mcpHubWorker as unknown as Fetcher,
  } as unknown as ScriptEngineEnv;
}

const noopRun = async () => ({});

describe("mcp-connector prebuilt — mints a verified internal token for mcp-hub", () => {
  it("list_servers sends a token verifiable against the caller's tenant", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const env = makeEnv(capture);
    await mcpConnector.operations["list_servers"]!({}, { env, run: noopRun });

    const token = capture.headers?.["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET)).toBe(true);
    expect(await verifyInternalToken(token, "some-other-tenant", PLATFORM_SECRET)).toBe(false);
  });

  it("register sends a token verifiable against the caller's tenant", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const env = makeEnv(capture, () => ({ id: "srv-1", name: "whop", url: "https://whop.example/mcp" }));
    await mcpConnector.operations["register"]!({ name: "whop", url: "https://whop.example/mcp" }, { env, run: noopRun });

    const token = capture.headers?.["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET)).toBe(true);
  });
});
