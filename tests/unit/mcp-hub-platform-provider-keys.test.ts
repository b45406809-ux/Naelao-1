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
const PLATFORM_PIPEDREAM_KEY = "naelao-platform-pipedream-key";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const MIGRATIONS = [
  readFileSync(join(__dirname, "../../infra/migrations/0012_mcp_servers.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0037_mcp_servers_auth.sql"), "utf8"),
  readFileSync(join(__dirname, "../../infra/migrations/0060_mcp_server_connector_provider.sql"), "utf8"),
];

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET,
    PLATFORM_DB: createFakeD1(MIGRATIONS),
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

/** Capture outbound provider requests; respond with a benign provider payload. */
function mockProviderFetch(capture: { url?: string; headers?: Record<string, string> }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    capture.url = url;
    const h: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { h[k] = v; });
    capture.headers = h;
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

  it("injects the platform Pipedream key for pipedream-routed connectors", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    mockProviderFetch(capture);
    const env = makeEnv({ PIPEDREAM_API_KEY: PLATFORM_PIPEDREAM_KEY });
    await seedProviderServer(env, { id: "srv-pd", provider: "pipedream" });

    const res = await callTool(env, "srv-pd");
    expect(res.status).toBe(200);
    expect(capture.url).toContain("api.pipedream.com");
    expect(capture.headers?.["authorization"]).toBe(`Bearer ${PLATFORM_PIPEDREAM_KEY}`);
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
