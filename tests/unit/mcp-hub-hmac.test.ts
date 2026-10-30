import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mcpHubWorker from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// mcp-hub is internal-only and also verifies its service-bound HMAC. Tool policy remains scoped
// to installed connection capabilities, outbound data checks, and caller approvals.

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const MIGRATIONS = [
  readFileSync(join(__dirname, "../../infra/migrations/0003_spaces.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0012_mcp_servers.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0037_mcp_servers_auth.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0060_mcp_server_connector_provider.sql"), "utf8"),
];

function makeEnv(overrides: Record<string, unknown> = {}) {
  const db = createFakeD1(MIGRATIONS);
  db.db.exec(`INSERT INTO spaces (id, tenant_id, spacetype_id, name, config_json) VALUES ('space-1', 'tenant-1', 'type-1', 'Test', '{}')`);
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET,
    PLATFORM_DB: db,
    ...overrides,
  };
}

async function seedServer(env: ReturnType<typeof makeEnv>, opts: { id: string; spaceId: string; tenantId: string; name: string; url: string }) {
  await env.PLATFORM_DB.prepare(
    "INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, transport, enabled) VALUES (?, ?, ?, ?, ?, 'http', 1)"
  ).bind(opts.id, opts.spaceId, opts.tenantId, opts.name, opts.url).run();
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://mcp-hub.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("mcp-hub — requireInternalHmac defense-in-depth", () => {
  it("rejects a request with no internal token", async () => {
    const env = makeEnv();
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", { headers: { "x-naelao-tenant-id": "tenant-1" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects a token minted for a different tenant than the caller claims", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "someone-else");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", { headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token } }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("accepts a valid, matching internal token", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", { headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token } }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });
});

describe("mcp-hub — authorized connector calls", () => {
  it("allows an ordinary, non-reserved tool_name through to the (mocked) upstream MCP server", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify({ Answer: [{ data: "93.184.216.34" }] }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
    }
    ) as typeof fetch;
    try {
      const env = makeEnv();
      await seedServer(env, { id: "srv-1", spaceId: "space-1", tenantId: "tenant-1", name: "some-connector", url: "https://example.com/mcp" });
      const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
      const res = await mcpHubWorker.fetch(
        req("/v1/spaces/space-1/mcp-servers/srv-1/tools/call", {
          method: "POST",
          headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
          body: JSON.stringify({ tool_name: "list_members", input: {} }),
        }),
        env as never, execCtx
      );
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
