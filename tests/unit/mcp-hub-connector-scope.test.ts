import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mcpHubWorker from "../../workers/mcp-hub/src/index.js";
import { buildAuthHeaders } from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// §A1.18 connector scope model: mcp-hub's buildAuthHeaders now threads the REAL acting end user
// through to the credentials worker as `on_behalf_of_user_id` — the plaintext-resolution route
// already implemented the full space-override > user > space-shared hierarchy, it just never
// received an acting user from any caller, so a scope='user' credential (a member's own personal
// connector) was never actually reachable. This proves the threading itself, both at the unit
// level (buildAuthHeaders directly) and end-to-end through the real tools/call route.

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const MIGRATIONS = [
  readFileSync(join(__dirname, "../../infra/migrations/0003_spaces.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0012_mcp_servers.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0037_mcp_servers_auth.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0060_mcp_server_connector_provider.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0092_mcp_connector_provider_pin.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0075_phase1_runtime_security.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0076_connector_alias_hardening.sql"), "utf8"),
];

function makeEnv(overrides: Record<string, unknown> = {}) {
  const db = createFakeD1(MIGRATIONS);
  for (const id of ["space-1", "space-p", "space-a"]) void db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, 'tenant-1', 'type-1', ?)").bind(id, id).run();
  return { ENVIRONMENT: "test", PLATFORM_SECRET, PLATFORM_DB: db, ...overrides };
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://mcp-hub.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function mockFetchWithDohResolution(dohIp: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://cloudflare-dns.com/")) {
      return new Response(JSON.stringify({ Answer: [{ data: dohIp }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }), { status: 200 });
  }) as typeof fetch;
}

describe("buildAuthHeaders — acting user threading (unit)", () => {
  it("includes on_behalf_of_user_id in the credentials-worker request body when given", async () => {
    let capturedBody: unknown;
    const credentialsWorker = {
      fetch: async (input: Request) => {
        capturedBody = await input.clone().json().catch(() => null);
        return new Response(JSON.stringify({ value: "secret-value" }));
      },
    } as unknown as Fetcher;
    const env = { PLATFORM_SECRET, CREDENTIALS_WORKER: credentialsWorker };
    const server = { id: "srv-1", space_id: "space-1", tenant_id: "tenant-1", auth_type: "bearer", auth_secret_name: "MY_CRED" } as never;

    await buildAuthHeaders(server, env as never, "agent-1", "end-user-42");
    expect(capturedBody).toEqual({ on_behalf_of_user_id: "end-user-42" });
  });

  it("omits on_behalf_of_user_id (empty body) when no acting user is given — resolves exactly as before", async () => {
    let capturedBody: unknown;
    const credentialsWorker = {
      fetch: async (input: Request) => {
        capturedBody = await input.clone().json().catch(() => null);
        return new Response(JSON.stringify({ value: "secret-value" }));
      },
    } as unknown as Fetcher;
    const env = { PLATFORM_SECRET, CREDENTIALS_WORKER: credentialsWorker };
    const server = { id: "srv-1", space_id: "space-1", tenant_id: "tenant-1", auth_type: "bearer", auth_secret_name: "MY_CRED" } as never;

    await buildAuthHeaders(server, env as never, "agent-1");
    expect(capturedBody).toEqual({});
  });

  it("resolved value is used as the Authorization bearer header regardless of acting user", async () => {
    const credentialsWorker = { fetch: async () => new Response(JSON.stringify({ value: "tok-abc" })) } as unknown as Fetcher;
    const env = { PLATFORM_SECRET, CREDENTIALS_WORKER: credentialsWorker };
    const server = { id: "srv-1", space_id: "space-1", tenant_id: "tenant-1", auth_type: "bearer", auth_secret_name: "MY_CRED" } as never;

    const headers = await buildAuthHeaders(server, env as never, "agent-1", "end-user-42");
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
  });
});

describe("mcp-hub tools/call — the real x-naelao-user-id header reaches buildAuthHeaders", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("threads x-naelao-user-id through to the credentials worker as on_behalf_of_user_id", async () => {
    mockFetchWithDohResolution("93.184.216.34");
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, auth_type, auth_secret_name, enabled, created_at, updated_at)
       VALUES ('srv-1', 'space-1', 'tenant-1', 'personal-gmail', 'https://mail.example.com', 'bearer', 'GMAIL_TOKEN', 1, ?, ?)`
    ).bind(new Date().toISOString(), new Date().toISOString()).run();

    let capturedBody: unknown;
    const credentialsWorker = {
      fetch: async (input: Request) => {
        capturedBody = await input.clone().json().catch(() => null);
        return new Response(JSON.stringify({ value: "member-own-token" }));
      },
    } as unknown as Fetcher;

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await mcpHubWorker.fetch(
      req("/v1/spaces/space-1/mcp-servers/srv-1/tools/call", {
        method: "POST",
        headers: {
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": token,
          "x-naelao-user-id": "member-42",
        },
        body: JSON.stringify({ tool_name: "list_messages", input: {} }),
      }),
      { ...env, CREDENTIALS_WORKER: credentialsWorker } as never,
      execCtx
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toEqual({ on_behalf_of_user_id: "member-42" });
  });
});
