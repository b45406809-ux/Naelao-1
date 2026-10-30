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
  readFileSync(join(__dirname, "../../infra/migrations/0003_spaces.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0012_mcp_servers.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0037_mcp_servers_auth.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0060_mcp_server_connector_provider.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0092_mcp_connector_provider_pin.sql"), "utf8"),
];

function makeEnv(overrides: Record<string, unknown> = {}) {
  const db = createFakeD1(MIGRATIONS);
  for (const id of ["space-1", "space-p", "space-a"]) void db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, 'tenant-1', 'type-1', ?)").bind(id, id).run();
  return { ENVIRONMENT: "test", PLATFORM_SECRET, PLATFORM_DB: db, ...overrides };
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

  it("allows a payment provider connector when normal SSRF validation passes", async () => {
    mockFetchWithDohResolution("93.184.216.34");
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "payments", url: "https://api.stripe.com/mcp" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
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

// ── Phase P: Composio/Pipedream connector provider routing ───────────────────────────────────

describe("mcp-hub Phase P — Composio/Pipedream provider routing", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeEnvP(overrides: Record<string, unknown> = {}) {
    const db = createFakeD1(MIGRATIONS);
    for (const id of ["space-1", "space-p", "space-a"]) void db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, 'tenant-1', 'type-1', ?)").bind(id, id).run();
    return { ENVIRONMENT: "test", PLATFORM_SECRET, PLATFORM_DB: db, ...overrides };
  }

  it("registers a Composio connector and stores connector_provider + provider_connection_id", async () => {
    const env = makeEnvP();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-p");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-p/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-p", "x-naelao-internal-token": token },
        body: JSON.stringify({
          name: "composio-gmail",
          auth_type: "bearer",
          auth_secret_name: "COMPOSIO_API_KEY",
          connector_provider: "composio",
          provider_connection_id: "connected-account-abc123",
        }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ connector_provider: string }>();
    expect(body.connector_provider).toBe("composio");
  });

  it("rejects Composio registration without provider_connection_id", async () => {
    const env = makeEnvP();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-p");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-p/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-p", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "composio-gmail", connector_provider: "composio", auth_secret_name: "COMPOSIO_API_KEY" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ message: string }>();
    expect(body.message).toMatch(/provider_connection_id/);
  });

  it("pins one provider per workspace/app and requires removal before changing providers", async () => {
    const env = makeEnvP();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-p");
    const register = (provider: string, connectionId: string) => mcpHubWorker.fetch(
      req("/v1/spaces/space-p/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-p", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "notion", connector_provider: provider, provider_connection_id: connectionId }),
      }), env as never, execCtx
    );
    expect((await register("composio", "ca-1")).status).toBe(201);
    const switched = await register("pipedream", "naelao-space:space-p");
    expect(switched.status).toBe(409);
    expect(await switched.json()).toMatchObject({ error_code: "connector_provider_pinned" });
  });

  it("rejects an invalid connector_provider value", async () => {
    const env = makeEnvP();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-p");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-p/mcp-servers", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-p", "x-naelao-internal-token": token },
        body: JSON.stringify({ name: "x", url: "https://x.example.com", connector_provider: "zapier" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("routes tools/call through Composio when connector_provider='composio'", async () => {
    // Seed a composio server directly into D1 (bypassing registration to avoid credential resolution).
    const env = makeEnvP();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, auth_type, auth_secret_name, enabled, connector_provider, provider_connection_id, created_at, updated_at)
       VALUES ('srv-composio', 'space-p', 'tenant-p', 'composio-gmail', '', 'bearer', 'COMPOSIO_API_KEY', 1, 'composio', 'conn-abc', ?, ?)`
    ).bind(new Date().toISOString(), new Date().toISOString()).run();

    // Stub credentials worker to return a test API key.
    const mockCreds: Fetcher = { fetch: async () => new Response(JSON.stringify({ value: "test-composio-key" })) } as unknown as Fetcher;
    const envWithCreds = { ...env, CREDENTIALS_WORKER: mockCreds };

    // Stub fetch: intercept the Composio API call.
    let composioCallUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      composioCallUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return new Response(JSON.stringify({ data: { result: "email sent" } }), { status: 200 });
    }) as typeof fetch;

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-p");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-p/mcp-servers/srv-composio/tools/call", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-p", "x-naelao-internal-token": token },
        body: JSON.stringify({ tool_name: "send_email", input: { to: "a@b.com" } }),
      }),
      envWithCreds as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(composioCallUrl).toMatch(/composio\.dev/);
    expect(composioCallUrl).toMatch(/send_email/);
    const body = await res.json<{ result: unknown }>();
    expect(body.result).toEqual({ result: "email sent" });
  });

  it("allows a granted extension operation to reach its connected provider", async () => {
    globalThis.fetch = (async () => Response.json({ successful: true, data: { id: "payment-1" } })) as typeof fetch;
    const env = makeEnvP({ COMPOSIO_API_KEY: "test-composio-platform-key" });
    await env.PLATFORM_DB.prepare(
      `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, auth_type, auth_secret_name, enabled, connector_provider, provider_connection_id, created_at, updated_at)
       VALUES ('srv-c2', 'space-p', 'tenant-p', 'composio-stripe', '', 'none', NULL, 1, 'composio', 'conn-abc', ?, ?)`
    ).bind(new Date().toISOString(), new Date().toISOString()).run();

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-p");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-p/mcp-servers/srv-c2/tools/call", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-p", "x-naelao-internal-token": token },
        body: JSON.stringify({ tool_name: "create_payment", input: {} }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });
});
