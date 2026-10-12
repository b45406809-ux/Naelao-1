import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mcpHubWorker from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Spec G-BF01/G-BF02 (Appendix BF, universal-tools doctrine): provider-backed connectors
// (Composio/Pipedream) are PLATFORM-KEYED — Naelao holds ONE provider key as a Workers Secret
// and injects it server-side; builders and end users never see or enter it (the Claude/ChatGPT
// bundled-connector model). BYO stays supported and WINS when a connector names its own vault
// credential (a builder running their own Composio project). Neither configured → honest
// provider_not_configured, never a silent empty result. The platform key must never appear in
// any response body.

const PLATFORM_SECRET = "test-platform-secret";
const PLATFORM_COMPOSIO_KEY = "naelao-platform-composio-key";
const PIPEDREAM_CLIENT_ID = "pd_client_test";
const PIPEDREAM_CLIENT_SECRET = "pd_secret_test";
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
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET,
    PLATFORM_DB: db,
    ...overrides,
  };
}

interface SeedOpts {
  id: string;
  provider: "composio" | "pipedream";
  connectionId?: string | null;
  authSecretName?: string | null;
  authType?: string;
}

async function seedProviderServer(env: ReturnType<typeof makeEnv>, opts: SeedOpts) {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, transport, enabled, auth_type, auth_secret_name, connector_provider, provider_connection_id)
     VALUES (?, 'space-1', 'tenant-1', ?, 'https://provider.example/mcp', 'http', 1, ?, ?, ?, ?)`
  ).bind(
    opts.id, opts.id,
    opts.authType ?? (opts.authSecretName ? "bearer" : "none"),
    opts.authSecretName ?? null,
    opts.provider,
    opts.connectionId === undefined ? "conn-123" : opts.connectionId
  ).run();
}

/** A credentials-worker stub that resolves any credential name to `byo-key`. */
const credentialsWorkerStub = {
  async fetch() {
    return Response.json({ value: "byo-key" });
  },
} as unknown as Fetcher;

async function callTool(env: ReturnType<typeof makeEnv>, serverId: string, toolName = "list_rows") {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return mcpHubWorker.fetch(
    new Request(`https://mcp-hub.naelao.com/v1/spaces/space-1/mcp-servers/${serverId}/tools/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-1",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ tool_name: toolName, input: {} }),
    }),
    env as never, execCtx
  );
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

/** Capture outbound provider requests; respond with a benign provider payload. The Pipedream
 *  OAuth token endpoint is special-cased since resolveProviderApiKey now exchanges client
 *  credentials for a real access token before making the actual provider call. */
function mockProviderFetch(capture: { url?: string; headers?: Record<string, string> }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.pipedream.com/v1/oauth/token") {
      return Response.json({ access_token: "pd-derived-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    capture.url = url;
    const h: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { h[k] = v; });
    capture.headers = h;
    if (url.endsWith("/actions/run")) return Response.json({ ret: { ok: true } });
    if (url.includes("/actions?")) return Response.json({ data: [] });
    return Response.json({ data: { ok: true }, items: [] });
  }) as typeof fetch;
}

describe("mcp-hub — platform-provided provider keys (G-BF02)", () => {
  it("injects the platform Composio key when the connector has no BYO credential", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    mockProviderFetch(capture);
    const env = makeEnv({ COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY });
    await seedProviderServer(env, { id: "srv-composio", provider: "composio" });

    const res = await callTool(env, "srv-composio");
    expect(res.status).toBe(200);
    expect(capture.url).toContain("backend.composio.dev");
    expect(capture.headers?.["x-api-key"]).toBe(PLATFORM_COMPOSIO_KEY);
  });

  it("exchanges the platform Pipedream OAuth client for a live access token, never a static key", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    mockProviderFetch(capture);
    const env = makeEnv({ PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID: "proj-test" });
    await seedProviderServer(env, { id: "srv-pd", provider: "pipedream" });

    const res = await callTool(env, "srv-pd");
    expect(res.status).toBe(200);
    expect(capture.url).toContain("api.pipedream.com");
    // The Bearer token is the OAuth-derived access token, not PIPEDREAM_CLIENT_SECRET itself —
    // Pipedream's REST API is client_credentials-only, verified against its own docs.
    expect(capture.headers?.["authorization"]).toBe("Bearer pd-derived-access-token");
    expect(capture.headers?.["authorization"]).not.toContain(PIPEDREAM_CLIENT_SECRET);
  });

  it("routes Pipedream calls and tool discovery through its official Connect API", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    mockProviderFetch(capture);
    const env = makeEnv({ PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID: "proj-test" });
    await seedProviderServer(env, { id: "srv-pd-actions", provider: "pipedream", connectionId: "naelao-space:space-1" });
    const call = await callTool(env, "srv-pd-actions", "google_sheets-add-row", { spreadsheet_id: "sheet-1" });
    expect(call.status).toBe(200);
    expect(capture.url).toContain("/actions/run");
    expect(capture.headers?.authorization).toBe("Bearer pd-derived-access-token");
    const tools = await listTools(env, "srv-pd-actions");
    expect(tools.status).toBe(200);
    expect(capture.url).toContain("/actions?");
  });

  it("degrades honestly (502 provider_auth_failed) when the Pipedream token exchange itself fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.pipedream.com/v1/oauth/token") return new Response("unauthorized", { status: 401 });
      return Response.json({ data: {} });
    }) as typeof fetch;
    // A distinct client id forces a fresh (uncached) token exchange — the module-scoped
    // access-token cache is keyed by client_id, and the previous test legitimately warmed the
    // cache for PIPEDREAM_CLIENT_ID.
    const env = makeEnv({ PIPEDREAM_CLIENT_ID: "pd_client_test_broken", PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID: "proj-test" });
    await seedProviderServer(env, { id: "srv-pd-broken", provider: "pipedream" });

    const res = await callTool(env, "srv-pd-broken");
    expect(res.status).toBe(502);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("provider_auth_failed");
  });

  it("BYO credential WINS over the platform key when the connector names one", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    mockProviderFetch(capture);
    const env = makeEnv({ COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY, CREDENTIALS_WORKER: credentialsWorkerStub });
    await seedProviderServer(env, { id: "srv-byo", provider: "composio", authSecretName: "my_composio_key" });

    const res = await callTool(env, "srv-byo");
    expect(res.status).toBe(200);
    expect(capture.headers?.["x-api-key"]).toBe("byo-key");
    expect(capture.headers?.["x-api-key"]).not.toBe(PLATFORM_COMPOSIO_KEY);
  });

  it("degrades honestly (503 provider_not_configured) when neither a BYO credential nor a platform key exists", async () => {
    const env = makeEnv(); // no COMPOSIO_API_KEY
    await seedProviderServer(env, { id: "srv-unconfigured", provider: "composio" });

    const res = await callTool(env, "srv-unconfigured");
    expect(res.status).toBe(503);
    const body = await res.json() as { error_code: string; message: string };
    expect(body.error_code).toBe("provider_not_configured");
    expect(body.message).toContain("composio");
  });

  it("a broken BYO declaration errors clearly instead of silently falling back to the platform key", async () => {
    // auth_type 'none' with a secret name resolves to no key — must NOT bill Naelao's account.
    const env = makeEnv({ COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY, CREDENTIALS_WORKER: credentialsWorkerStub });
    await seedProviderServer(env, { id: "srv-broken-byo", provider: "composio", authSecretName: "my_key", authType: "none" });

    const res = await callTool(env, "srv-broken-byo");
    expect(res.status).toBe(400);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("credential_error");
  });

  it("the platform key never appears in any response body (call, list-tools, or error)", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    mockProviderFetch(capture);
    const env = makeEnv({ COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY });
    await seedProviderServer(env, { id: "srv-leak-check", provider: "composio" });

    const callRes = await callTool(env, "srv-leak-check");
    expect(await callRes.text()).not.toContain(PLATFORM_COMPOSIO_KEY);

    const listRes = await listTools(env, "srv-leak-check");
    expect(await listRes.text()).not.toContain(PLATFORM_COMPOSIO_KEY);
  });

  it("missing provider_connection_id is still rejected even with a platform key present", async () => {
    const env = makeEnv({ COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY });
    await seedProviderServer(env, { id: "srv-no-conn", provider: "composio", connectionId: null });

    const res = await callTool(env, "srv-no-conn");
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("connection_id");
  });

  it("the reserved money-in tool-name guard still applies to platform-keyed provider calls", async () => {
    const env = makeEnv({ COMPOSIO_API_KEY: PLATFORM_COMPOSIO_KEY });
    await seedProviderServer(env, { id: "srv-guarded", provider: "composio" });

    const res = await callTool(env, "srv-guarded", "create_checkout");
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("reserved_capability");
  });
});
