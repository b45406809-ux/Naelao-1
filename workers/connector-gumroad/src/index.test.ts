import { mintInternalToken } from "@naelao/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

afterEach(() => vi.unstubAllGlobals());

async function mcpRequest(body: unknown): Promise<Request> {
  const token = await mintInternalToken("secret", "tenant");
  return new Request("https://gumroad/connectors/gumroad/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gumroad-token",
      "x-naelao-space-id": "space",
      "x-naelao-tenant-id": "tenant",
      "x-naelao-internal-token": token,
    },
    body: JSON.stringify(body),
  });
}

const env = { PLATFORM_SECRET: "secret", ENVIRONMENT: "test" } as never;

describe("Gumroad MCP shim boundaries", () => {
  it("rejects product path traversal before making a provider request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await worker.fetch(await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_product", arguments: { product_id: "../../user" } },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ error: { message: "invalid_product_id" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds MCP input and outbound provider behavior", async () => {
    const oversized = await worker.fetch(await mcpRequest({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_products", arguments: { padding: "x".repeat(70_000) } },
    }), env, {} as ExecutionContext);
    expect(oversized.status).toBe(400);

    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true, products: [] }));
    vi.stubGlobal("fetch", fetch);
    const response = await worker.fetch(await mcpRequest({
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_products", arguments: {} },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
