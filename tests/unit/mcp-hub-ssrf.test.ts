import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mcpHubWorker from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// S0.5: validateMcpUrl was a literal hostname/IP blocklist with NO DNS resolution — a
// DNS-rebinding attack (register a public-IP hostname, then repoint its DNS to
// 169.254.169.254 or another internal address) sailed straight through, and even the literal
// check only ran at registration, never again before the actual outbound fetch. Now backed by
// @naelao/security's checkSsrf (DoH resolution) and re-checked at CALL TIME too.

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const MIGRATIONS = [
  readFileSync(join(__dirname, "../../infra/migrations/0012_mcp_servers.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0037_mcp_servers_auth.sql"), "utf8"),
];

function makeEnv(overrides: Record<string, unknown> = {}) {
  return { ENVIRONMENT: "test", PLATFORM_SECRET, PLATFORM_DB: createFakeD1(MIGRATIONS), ...overrides };
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

/** Mocks global fetch: DoH lookups (cloudflare-dns.com) resolve per `dohIp`, and the actual MCP
 *  call (anything else) returns a canned success response. */
function mockFetchWithDohResolution(dohIp: string | null): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://cloudflare-dns.com/")) {
      if (!dohIp) return new Response(JSON.stringify({ Answer: [] }), { status: 200 });
      return new Response(JSON.stringify({ Answer: [{ data: dohIp }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { tools: [] } }), { status: 200 });
  }) as typeof fetch;
}

describe("mcp-hub SSRF — DoH-backed checkSsrf replaces the literal-only blocklist", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("rejects registration when the hostname resolves to a metadata-service IP (169.254.169.254) — literal check alone would have missed this", async () => {
    mockFetchWithDohResolution("169.254.169.254");
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "evil", url: "https://evil.example.com" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("rejects registration when the hostname resolves into the CGNAT range (100.64.0.0/10) — the literal-only check had no CGNAT rule", async () => {
    mockFetchWithDohResolution("100.100.0.1");
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "evil", url: "https://evil.example.com" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("allows registration when the hostname resolves to an ordinary public IP", async () => {
    mockFetchWithDohResolution("93.184.216.34");
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "good", url: "https://example.com" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });

  it("re-validates at CALL TIME: a server registered while its hostname resolved safely is rejected on tools/call once DNS-rebinding repoints it to a blocked address", async () => {
    const env = makeEnv();

    // Registration time: the hostname resolves to a public IP — passes.
    mockFetchWithDohResolution("93.184.216.34");
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const regRes = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "rebinder", url: "https://rebinder.example.com" }),
      }),
      env as never, execCtx
    );
    expect(regRes.status).toBe(201);
    const { id: serverId } = await regRes.json<{ id: string }>();

    // Call time: DNS has since been repointed to an internal address — must now be rejected,
    // proving the fetch is re-validated, not just trusted from registration.
    mockFetchWithDohResolution("169.254.169.254");
    const callRes = await mcpHubWorker.fetch(
      req(`/v1/spaces/space-1/mcp-servers/${serverId}/tools/call`, {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ tool_name: "list_members", input: {} }),
      }),
      env as never, execCtx
    );
    expect(callRes.status).toBe(400);
  });

  it("re-validates at CALL TIME for tools/list too", async () => {
    const env = makeEnv();
    mockFetchWithDohResolution("93.184.216.34");
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const regRes = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "rebinder2", url: "https://rebinder2.example.com" }),
      }),
      env as never, execCtx
    );
    const { id: serverId } = await regRes.json<{ id: string }>();

    mockFetchWithDohResolution("fd00::1");
    const listRes = await mcpHubWorker.fetch(
      req(`/v1/spaces/space-1/mcp-servers/${serverId}/tools`, { headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token } }),
      env as never, execCtx
    );
    expect(listRes.status).toBe(400);
  });
});
