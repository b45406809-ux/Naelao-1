import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker, { type Env } from "./index.js";

function env(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => ({ config_json: '{"compliance":{"airGappedOnly":true}}' })) })) })),
    } as unknown as D1Database,
  };
}

describe("MCP air-gap boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["GET", "https://mcp/v1/spaces/s/mcp-servers/server/tools"],
    ["POST", "https://mcp/v1/spaces/s/mcp-servers/server/tools/call"],
  ])("blocks %s before connector lookup or outbound fetch", async (method, url) => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(new Request(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
      },
      ...(method === "POST" ? { body: JSON.stringify({ tool_name: "search", input: {} }) } : {}),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    expect(outbound).not.toHaveBeenCalled();
  });
});
