import { mintInternalToken } from "@naelao/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

afterEach(() => vi.unstubAllGlobals());

async function mcpRequest(body: unknown): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant");
  return new Request("https://whop/connectors/whop/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer whop-token",
      "x-naelao-space-id": "space", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token,
    },
    body: JSON.stringify(body),
  });
}

const env = { PLATFORM_SECRET: "secret", ENVIRONMENT: "test" } as never;

describe("Whop MCP shim boundaries", () => {
  it("rejects membership path traversal and malformed write arguments before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const params of [
      { name: "get_membership", arguments: { id: "../payments" } },
      { name: "send_message", arguments: { to_user_id: "member-1", message: "" } },
    ]) {
      const response = await worker.fetch(await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params }), env, {} as ExecutionContext);
      expect(response.status).toBe(200);
      expect((await response.json() as { error: { message: string } }).error.message).toMatch(/^invalid_/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds JSON-RPC bodies and applies redirect and timeout policy to Whop requests", async () => {
    const oversized = await worker.fetch(await mcpRequest({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_members", arguments: { padding: "x".repeat(70_000) } },
    }), env, {} as ExecutionContext);
    expect(oversized.status).toBe(400);

    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    const response = await worker.fetch(await mcpRequest({
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_members", arguments: {} },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect((fetch.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
