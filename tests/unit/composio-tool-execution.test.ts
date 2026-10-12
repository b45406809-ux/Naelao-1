// Composio moved its tool execution/listing API from v2 (`/api/v2/actions/...`) to v3
// (`/api/v3/tools/...`) — the connect-flow (connectors/composio.ts) was updated to v3 for the
// OAuth handshake, but mcp-hub's actual tool CALL/LIST functions (what every real agent tool
// call goes through, once a connector is already connected) were left on the dead v2 shape,
// which is why "the assistant can't use Composio tools" reproduced even for an already-connected
// business. Confirmed against Composio's real, live OpenAPI spec
// (`GET https://backend.composio.dev/api/v3/openapi.json`), not assumed — these tests pin the
// exact request shape that spec describes.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mcpHubWorker from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const PLATFORM_SECRET = "test-platform-secret";
const PLATFORM_COMPOSIO_KEY = "naelao-platform-composio-key";
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
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET,
    COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY,
    PLATFORM_DB: db,
    ...overrides,
  };
}

async function seedComposioServer(env: ReturnType<typeof makeEnv>, id: string, connectionId = "ca_1a2b3c") {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, transport, enabled, auth_type, connector_provider, provider_connection_id)
     VALUES (?, 'space-1', 'tenant-1', ?, 'https://provider.example/mcp', 'http', 1, 'none', 'composio', ?)`
  ).bind(id, id, connectionId).run();
}

async function callTool(env: ReturnType<typeof makeEnv>, serverId: string, toolName: string, input: Record<string, unknown> = {}) {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return mcpHubWorker.fetch(
    new Request(`https://mcp-hub.naelao.com/v1/spaces/space-1/mcp-servers/${serverId}/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ tool_name: toolName, input }),
    }),
    env as never, execCtx
  );
}

async function aliasRequest(env: ReturnType<typeof makeEnv>, path: string, init: RequestInit = {}) {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return mcpHubWorker.fetch(new Request(`https://mcp-hub.naelao.com/v1/spaces/space-1/connector-aliases${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "user-1", "x-naelao-internal-token": token, ...init.headers },
  }), env as never, execCtx);
}

async function listTools(env: ReturnType<typeof makeEnv>, serverId: string) {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return mcpHubWorker.fetch(
    new Request(`https://mcp-hub.naelao.com/v1/spaces/space-1/mcp-servers/${serverId}/tools`, {
      headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
    }),
    env as never, execCtx
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("composio tool execution — real v3 API shape", () => {
  it("creates, resolves, scope-checks, reauthorizes, and deletes connector aliases", async () => {
    globalThis.fetch = (async () => Response.json({ data: { id: 9 }, successful: true })) as typeof fetch;
    const env = makeEnv();
    await seedComposioServer(env, "srv-alias");
    const created = await aliasRequest(env, "", { method: "POST", body: JSON.stringify({ alias: "primary_inbox", scope: "user_personal", server_id: "srv-alias", granted_scopes: ["email.read"] }) });
    expect(created.status).toBe(201);
    const row = await created.json() as { id: string };
    const missing = await aliasRequest(env, "/primary_inbox/tools/call", { method: "POST", headers: { "x-naelao-connector-scope": "user_personal", "x-naelao-required-scopes": "email.send" }, body: JSON.stringify({ tool_name: "send_email", input: {} }) });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error_code: "scope_upgrade_required", card: { missing_scopes: ["email.send"] } });
    const listed = await aliasRequest(env, "");
    expect((await listed.json() as { data: unknown[] }).data).toHaveLength(1);
    expect((await aliasRequest(env, `/${row.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("blocks nested sensitive data before any provider request", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => { calls.push(args); return Response.json({ data: {} }); }) as typeof fetch;
    const env = makeEnv();
    await seedComposioServer(env, "srv-dlp");
    const res = await callTool(env, "srv-dlp", "DISCORD_SEND_MESSAGE", { nested: { ssn: "123-45-6789" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error_code: "egress_dlp_blocked", findings: ["ssn"] });
    expect(calls).toHaveLength(0);
  });

  it("calls POST /api/v3/tools/execute/:tool_slug with connected_account_id + arguments, not the dead v2 path", async () => {
    const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const h: Record<string, string> = {};
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { h[k] = v; });
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined, headers: h });
      return Response.json({ data: { id: 42 }, error: null, successful: true, log_id: "log_1" });
    }) as typeof fetch;

    const env = makeEnv();
    await seedComposioServer(env, "srv-1", "ca_abc123");

    const res = await callTool(env, "srv-1", "GITHUB_CREATE_ISSUE", { repo: "x", title: "y" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toEqual({ id: 42 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://backend.composio.dev/api/v3/tools/execute/GITHUB_CREATE_ISSUE");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["x-api-key"]).toBe(PLATFORM_COMPOSIO_KEY);
    // The v3 body shape — connected_account_id (not connectedAccountId) and the tool's params
    // under "arguments" (not "input"), per Composio's real OpenAPI schema.
    expect(calls[0]!.body).toEqual({ connected_account_id: "ca_abc123", arguments: { repo: "x", title: "y" } });
  });

  it("treats successful:false as a failure even though the HTTP status was 200", async () => {
    globalThis.fetch = (async () =>
      Response.json({ data: null, error: null, successful: false, log_id: "log_2" })
    ) as typeof fetch;
    const env = makeEnv();
    await seedComposioServer(env, "srv-2");

    const res = await callTool(env, "srv-2", "SOME_ACTION");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error_code: string; message: string };
    expect(body.error_code).toBe("upstream_error");
    expect(body.message).toContain("unsuccessful");
  });

  it("still surfaces a real error message when Composio reports one", async () => {
    globalThis.fetch = (async () =>
      Response.json({ data: null, error: "invalid input: 'repo' is required", successful: false })
    ) as typeof fetch;
    const env = makeEnv();
    await seedComposioServer(env, "srv-3");

    const res = await callTool(env, "srv-3", "SOME_ACTION");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("'repo' is required");
  });

  it("lists tools by resolving the connected account's toolkit, then filtering by toolkit_slug — v3 has no per-connection tool filter", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes("/connected_accounts/")) {
        return Response.json({ id: "ca_abc123", toolkit: { slug: "github" } });
      }
      expect(url).toContain("/api/v3/tools?");
      expect(url).toContain("toolkit_slug=github");
      return Response.json({ items: [{ slug: "GITHUB_CREATE_ISSUE" }], next_cursor: null, total_pages: 1, current_page: 1, total_items: 1 });
    }) as typeof fetch;

    const env = makeEnv();
    await seedComposioServer(env, "srv-4", "ca_abc123");

    const res = await listTools(env, "srv-4");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: unknown[] };
    expect(body.tools).toEqual([{ slug: "GITHUB_CREATE_ISSUE" }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://backend.composio.dev/api/v3/connected_accounts/ca_abc123");
  });

  it("degrades to an empty tool list, never a crash, when the connected account can't be resolved", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const env = makeEnv();
    await seedComposioServer(env, "srv-5");

    const res = await listTools(env, "srv-5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: unknown[] };
    expect(body.tools).toEqual([]);
  });
});
