import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mcpHubWorker from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// §A1.17 Phase I: mcp-hub's only real ingress is direct service bindings from the agents worker
// (never the public router), so `workers_dev = false` was the sole control — this adds the same
// requireInternalHmac defense-in-depth backstop every other internal-only worker already has.
// Also proves the reserved-tool-name guard is now enforced HERE (server-side, protects every
// caller) rather than only inside the mcp-connector prebuilt client — the gap the new ctx.mcp
// isolate loopback would otherwise have silently bypassed.

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const MIGRATIONS = [
  readFileSync(join(__dirname, "../../infra/migrations/0012_mcp_servers.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0037_mcp_servers_auth.sql"), "utf8"),
];

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET,
    PLATFORM_DB: createFakeD1(MIGRATIONS),
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

describe("mcp-hub — reserved-tool-name guard is enforced server-side at call time", () => {
  it("blocks a money-in-shaped tool_name even when called directly (bypassing the mcp-connector prebuilt client-side check)", async () => {
    const env = makeEnv();
    await seedServer(env, { id: "srv-1", spaceId: "space-1", tenantId: "tenant-1", name: "some-connector", url: "https://example.com/mcp" });
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers/srv-1/tools/call", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ tool_name: "charge_customer", input: {} }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("reserved_capability");
  });

  it("allows an ordinary, non-reserved tool_name through to the (mocked) upstream MCP server", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { members: [] } }), { status: 200 })
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
