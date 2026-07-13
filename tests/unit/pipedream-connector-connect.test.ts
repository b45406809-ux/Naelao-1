import { describe, it, expect, afterEach } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Pipedream Connect "click Install" hosted-connect flow — the second hosted provider behind the
// SAME /provider-connect/* routes and shell UI as Composio (composio-connector-connect.test.ts).
// Notion is the catalogue's Pipedream-routed connector (catalogue.ts).
//
// Safety invariants under test (mirrors the Composio suite):
//   1. The start route only builds a real connect_url when the OAuth client id/secret/project id
//      are configured, never fabricates one — and never proceeds without them.
//   2. Pipedream's REST API is OAuth client_credentials-only (VERIFIED, no static key path) — the
//      start route must exchange for an access token before calling the connect-token endpoint.
//   3. The callback's `ticket` is single-use — an unknown/expired ticket is rejected cleanly.
//   4. The connection is only registered as an MCP server after POLLING for a real, healthy
//      connected account — a bailed-out consent flow never gets silently marked connected.
//   5. No OAuth token/credential is ever vaulted for a pipedream-routed connector.

const SECRET = "test-platform-secret";

class FakeKv {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(overrides: Partial<AgentsEnv> = {}): AgentsEnv & {
  __mcpServers: Array<{ id: string; name: string; auth_type: string; connector_provider?: string; provider_connection_id?: string | null; enabled?: boolean }>;
} {
  const mcpServers: Array<{ id: string; name: string; auth_type: string; connector_provider?: string; provider_connection_id?: string | null; enabled?: boolean }> = [];
  const mcpHub = {
    async fetch(reqInput: Request) {
      const url = new URL(reqInput.url);
      if (reqInput.method === "GET" && /\/mcp-servers$/.test(url.pathname)) {
        return Response.json({ data: mcpServers });
      }
      if (reqInput.method === "POST" && /\/mcp-servers$/.test(url.pathname)) {
        const body = await reqInput.json<{ name: string; auth_type: string; connector_provider?: string; provider_connection_id?: string }>();
        const row = { id: `srv-${mcpServers.length + 1}`, name: body.name, auth_type: body.auth_type, connector_provider: body.connector_provider, provider_connection_id: body.provider_connection_id, enabled: true };
        mcpServers.push(row);
        return Response.json(row, { status: 201 });
      }
      if (reqInput.method === "PATCH") {
        const id = url.pathname.split("/").pop();
        const row = mcpServers.find((s) => s.id === id);
        if (row) row.enabled = true;
        return Response.json(row ?? {});
      }
      return new Response("not found", { status: 404 });
    },
  };
  return {
    PLATFORM_SECRET: SECRET,
    PUBLIC_AGENTS_URL: "https://agents.naelao.com",
    PIPEDREAM_CLIENT_ID: "pd_client_test",
    PIPEDREAM_CLIENT_SECRET: "pd_secret_test",
    PIPEDREAM_PROJECT_ID: "proj_test123",
    AGENT_CACHE: new FakeKv() as unknown as KVNamespace,
    MCP_HUB: mcpHub as unknown as Fetcher,
    ANALYTICS: { writeDataPoint() {} },
    __mcpServers: mcpServers,
    ...overrides,
  } as unknown as AgentsEnv & { __mcpServers: typeof mcpServers };
}

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

function mockPipedream(opts: { tokenStatus?: number; tokenBody?: unknown; connectStatus?: number; connectBody?: unknown; accountsBody?: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { headers[k] = v; });
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, headers, body });

    if (url === "https://api.pipedream.com/v1/oauth/token") {
      expect(body.grant_type).toBe("client_credentials");
      return new Response(
        JSON.stringify(opts.tokenBody ?? { access_token: "pd_access_tok", token_type: "Bearer", expires_in: 3600 }),
        { status: opts.tokenStatus ?? 200 }
      );
    }
    if (url === "https://api.pipedream.com/v1/connect/proj_test123/tokens") {
      expect(headers["authorization"]).toBe("Bearer pd_access_tok");
      expect(headers["x-pd-environment"]).toBe("development");
      expect(body.external_user_id).toBe("naelao-space:space-a");
      expect(body.success_redirect_uri).toContain("/connectors/notion/provider-connect/callback?ticket=");
      return new Response(
        JSON.stringify(opts.connectBody ?? { connect_link_url: "https://pipedream.com/_static/connect.html?token=abc" }),
        { status: opts.connectStatus ?? 200 }
      );
    }
    if (url.startsWith("https://api.pipedream.com/v1/connect/proj_test123/accounts")) {
      expect(headers["authorization"]).toBe("Bearer pd_access_tok");
      const qs = new URL(url).searchParams;
      expect(qs.get("external_user_id")).toBe("naelao-space:space-a");
      expect(qs.get("app")).toBe("notion");
      return Response.json(opts.accountsBody ?? { data: [{ id: "acct_1", app: "notion" }] });
    }
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
}

async function startReq(env: AgentsEnv, platform = "notion", spaceId = "space-a") {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return app.fetch(
    new Request(`https://agents.naelao.com/connectors/${platform}/provider-connect/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ space_id: spaceId, return_url: "https://shell.naelao.com/p/acme/spaces/space-a" }),
    }),
    env as never
  );
}

describe("POST /connectors/:platform/provider-connect/start (Pipedream)", () => {
  it("exchanges client credentials for an access token, then returns a connect_url with ?app= appended", async () => {
    const env = makeEnv();
    mockPipedream({});
    const res = await startReq(env);
    expect(res.status).toBe(200);
    const { connect_url } = await res.json<{ connect_url: string }>();
    expect(connect_url).toBe("https://pipedream.com/_static/connect.html?token=abc&app=notion");
    // Token was fetched before the connect-token call, using the real client credentials.
    const tokenCall = calls.find((c) => c.url === "https://api.pipedream.com/v1/oauth/token");
    expect(tokenCall).toBeTruthy();
    expect((tokenCall!.body as { client_id: string }).client_id).toBe("pd_client_test");
    expect((tokenCall!.body as { client_secret: string }).client_secret).toBe("pd_secret_test");
    expect(calls.some((c) => c.url === "https://api.pipedream.com/v1/connect/proj_test123/tokens")).toBe(true);
  });

  it("degrades honestly to provider_not_configured when the OAuth client is unset", async () => {
    const env = makeEnv({ PIPEDREAM_CLIENT_ID: undefined });
    const res = await startReq(env);
    expect(res.status).toBe(503);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_not_configured");
  });

  it("degrades honestly to provider_not_configured when the project id is unset", async () => {
    const env = makeEnv({ PIPEDREAM_PROJECT_ID: undefined });
    const res = await startReq(env);
    expect(res.status).toBe(503);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_not_configured");
  });

  it("surfaces a clear error when the token exchange itself fails", async () => {
    // A distinct client id forces a fresh (uncached) token exchange — the module-scoped access-
    // token cache is keyed by client_id, and other tests in this file legitimately warm the cache
    // for "pd_client_test".
    const env = makeEnv({ PIPEDREAM_CLIENT_ID: "pd_client_test_tokenfail" });
    mockPipedream({ tokenStatus: 401, tokenBody: { error: "invalid_client" } });
    const res = await startReq(env);
    expect(res.status).toBe(502);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_connect_failed");
  });

  it("surfaces a clear error when the connect-token call itself fails", async () => {
    const env = makeEnv();
    mockPipedream({ connectStatus: 500, connectBody: { error: "boom" } });
    const res = await startReq(env);
    expect(res.status).toBe(502);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_connect_failed");
  });

  it("rejects a connector with no hosted-connect spec at all (e.g. Gumroad, a manual-key-only connector)", async () => {
    const env = makeEnv();
    const res = await startReq(env, "gumroad");
    expect(res.status).toBe(400);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_connect_not_supported");
  });
});

describe("GET /connectors/:platform/provider-connect/callback (Pipedream)", () => {
  it("rejects a missing/unknown ticket with a clear message, not a crash", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/notion/provider-connect/callback?ticket=does-not-exist"),
      env as never
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired|already used/i);
  });

  it("polls for a real connected account and only registers when found, then redirects with no credential in the URL", async () => {
    const env = makeEnv();
    mockPipedream({});
    const startRes = await startReq(env);
    expect(startRes.status).toBe(200);

    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const ticketKey = [...(kv as unknown as { store: Map<string, string> }).store.keys()].find((k) => k.startsWith("connector-provider-ticket:"));
    expect(ticketKey).toBeTruthy();
    const ticketId = ticketKey!.replace("connector-provider-ticket:", "");

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/notion/provider-connect/callback?ticket=${ticketId}`),
      env as never
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("notion_connected=1");
    expect(location).not.toMatch(/pd_access_tok|access_token|token=/);

    expect(env.__mcpServers.length).toBe(1);
    expect(env.__mcpServers[0]!.name).toBe("notion");
    expect(env.__mcpServers[0]!.connector_provider).toBe("pipedream");
    expect(env.__mcpServers[0]!.provider_connection_id).toBe("naelao-space:space-a");
    expect(env.__mcpServers[0]!.auth_type).toBe("none");

    // A replayed callback URL can't be redeemed twice.
    const replay = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/notion/provider-connect/callback?ticket=${ticketId}`),
      env as never
    );
    expect(replay.status).toBe(400);
  });

  it("does NOT register the connector when no connected account exists yet (bailed-out consent)", async () => {
    const env = makeEnv();
    mockPipedream({ accountsBody: { data: [] } });
    const startRes = await startReq(env);
    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const ticketKey = [...(kv as unknown as { store: Map<string, string> }).store.keys()].find((k) => k.startsWith("connector-provider-ticket:"));
    void (await startRes.json());

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/notion/provider-connect/callback?ticket=${ticketKey!.replace("connector-provider-ticket:", "")}`),
      env as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("notion_oauth_error=connection_none");
    expect(env.__mcpServers.length).toBe(0);
  });

  it("treats an explicitly unhealthy account row as not-active (fail closed)", async () => {
    const env = makeEnv();
    mockPipedream({ accountsBody: { data: [{ id: "acct_1", app: "notion", status: "expired" }] } });
    const startRes = await startReq(env);
    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const ticketKey = [...(kv as unknown as { store: Map<string, string> }).store.keys()].find((k) => k.startsWith("connector-provider-ticket:"));
    void (await startRes.json());

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/notion/provider-connect/callback?ticket=${ticketKey!.replace("connector-provider-ticket:", "")}`),
      env as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("notion_oauth_error=connection_none");
    expect(env.__mcpServers.length).toBe(0);
  });
});
