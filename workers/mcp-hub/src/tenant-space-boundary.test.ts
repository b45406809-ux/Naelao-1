import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker, { type Env } from "./index.js";

function env(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    COMPOSIO_API_KEY: "platform-key",
    PLATFORM_DB: {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => null) })) })),
    } as unknown as D1Database,
  };
}

describe("MCP Hub tenant-space binding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["connect", "/connectors/composio/connect", { auth_config_id: "auth-1", user_id: "user-b", callback_url: "https://app.example/callback" }],
    ["execute", "/connectors/composio/execute", { connection_id: "account-b", action: "GMAIL_LIST_MESSAGES", arguments: {} }],
  ])("blocks cross-tenant %s requests before provider access", async (_name, path, body) => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const binding = env();
    const response = await worker.fetch!(new Request(`https://mcp${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-space-id": "space-owned-by-tenant-b",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant-a"),
      },
      body: JSON.stringify(body),
    }), binding, {} as ExecutionContext);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: "space_not_found" });
    expect(binding.PLATFORM_DB.prepare).toHaveBeenCalledWith(expect.stringContaining("tenant_id = ?"));
    expect(outbound).not.toHaveBeenCalled();
  });
});
