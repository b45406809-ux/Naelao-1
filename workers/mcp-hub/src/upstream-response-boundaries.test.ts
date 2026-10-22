import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker, { type Env } from "./index.js";

function env(): Env {
  const server = {
    id: "server", space_id: "s", tenant_id: "tenant", name: "public-mcp",
    url: "https://8.8.8.8", auth_type: "none", auth_secret_name: null,
    enabled: 1, connector_provider: "direct", provider_connection_id: null,
    created_at: "now", updated_at: "now",
  };
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    PLATFORM_DB: {
      prepare(sql: string) {
        return { bind: () => ({ first: async () => sql.includes("SELECT config_json") ? { config_json: "{}" } : server }) };
      },
    } as unknown as D1Database,
  };
}

function oversizedJsonResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"result":{"content":"'));
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}}'));
      controller.close();
    },
  }));
}

describe("MCP server response boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["direct", "https://mcp/v1/spaces/s/mcp-servers/server/tools/call"],
    ["alias", "https://mcp/v1/spaces/s/connector-aliases/mail/tools/call"],
  ])("rejects oversized %s tool-call requests before parsing or egress", async (_name, url) => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const tenantToken = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch!(new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": tenantToken,
      },
      body: `{"tool_name":"search","input":{"payload":"${"x".repeat(1024 * 1024)}"}}`,
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "request_body_too_large" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([
    ["Composio connect", "POST", "https://mcp/connectors/composio/connect"],
    ["Composio execute", "POST", "https://mcp/connectors/composio/execute"],
    ["MCP registration", "POST", "https://mcp/v1/spaces/s/mcp-servers"],
    ["MCP update", "PATCH", "https://mcp/v1/spaces/s/mcp-servers/server"],
    ["alias registration", "POST", "https://mcp/v1/spaces/s/connector-aliases"],
  ])("bounds %s mutation JSON before processing", async (_name, method, url) => {
    const tenantToken = await mintInternalToken("secret", "tenant");
    const spaceScoped = url.includes("/connectors/composio/");
    const overLimitBytes = url.endsWith("/execute") ? 1024 * 1024 + 1 : 65 * 1024;
    const response = await worker.fetch!(new Request(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": tenantToken,
        ...(spaceScoped ? { "x-naelao-space-id": "s" } : {}),
      },
      body: `{"padding":"${"x".repeat(overLimitBytes)}"}`,
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "request_body_too_large" });
  });

  it("rejects malformed and structurally invalid tool-call JSON without provider access", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const tenantToken = await mintInternalToken("secret", "tenant");
    for (const body of ["{", JSON.stringify({ tool_name: "search", input: [] })]) {
      const response = await worker.fetch!(new Request("https://mcp/v1/spaces/s/mcp-servers/server/tools/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant",
          "x-naelao-internal-token": tenantToken,
        },
        body,
      }), env(), {} as ExecutionContext);
      expect(response.status).toBe(400);
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "https://mcp/v1/spaces/s/mcp-servers/server/tools"],
    ["POST", "https://mcp/v1/spaces/s/mcp-servers/server/tools/call"],
  ])("rejects oversized %s upstream JSON", async (method, url) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversizedJsonResponse()));
    const tenantToken = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch!(new Request(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": tenantToken,
      },
      ...(method === "POST" ? { body: JSON.stringify({ tool_name: "search", input: {} }) } : {}),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error_code: "upstream_error" });
  });

  it.each([
    ["GET", "https://mcp/v1/spaces/s/mcp-servers/server/tools"],
    ["POST", "https://mcp/v1/spaces/s/mcp-servers/server/tools/call"],
  ])("rejects redirects for credentialed %s direct MCP egress", async (method, url) => {
    let redirect: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return Response.json({ result: { tools: [] } });
    }));
    const tenantToken = await mintInternalToken("secret", "tenant");
    const response = await worker.fetch!(new Request(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": tenantToken,
      },
      ...(method === "POST" ? { body: JSON.stringify({ tool_name: "search", input: {} }) } : {}),
    }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(redirect).toBe("error");
  });
});
