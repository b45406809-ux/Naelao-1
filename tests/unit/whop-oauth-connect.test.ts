import { describe, it, expect, afterEach } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { resolveOAuthAccessToken } from "../../workers/mcp-hub/src/index.js";
import type { McpServer } from "../../workers/mcp-hub/src/index.js";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";

// "Connect with Whop" — a real OAuth2+PKCE app (self-serve, no invite), a completely separate
// mechanism from the invite-gated Platforms/connected-accounts API the business-wallet rail uses.
// Safety invariants under test:
//   1. The start route only builds a real authorize URL when the OAuth app is configured, never
//      fabricates one.
//   2. The callback's `state` ticket is single-use — a replayed callback URL cannot be redeemed
//      twice, and an unknown/expired ticket is rejected with a clear message, not a crash.
//   3. The exchanged tokens are vaulted (never returned to the browser) and the MCP server is
//      registered with auth_type "oauth2" pointing at the connector's own credential name.
//   4. mcp-hub's buildAuthHeaders proactively refreshes a near-expiry oauth2 token via the agents
//      worker's internal refresh endpoint (the only place holding the client secret), and falls
//      back to the stale token rather than throwing when the refresh call itself fails.

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
  __credentialCalls: Array<{ name: string; value: string }>;
  __mcpServers: Array<{ id: string; name: string; auth_type: string; auth_secret_name: string | null }>;
} {
  const credentialCalls: Array<{ name: string; value: string }> = [];
  const mcpServers: Array<{ id: string; name: string; auth_type: string; auth_secret_name: string | null }> = [];

  const credentialsWorker = {
    async fetch(reqInput: Request) {
      const body = await reqInput.json<{ name: string; value: string }>().catch(() => ({ name: "", value: "" }));
      credentialCalls.push(body);
      return Response.json({ id: "cred-1", name: body.name }, { status: 201 });
    },
  };

  const mcpHub = {
    async fetch(reqInput: Request) {
      const url = new URL(reqInput.url);
      if (reqInput.method === "GET" && /\/mcp-servers$/.test(url.pathname)) {
        return Response.json({ data: mcpServers });
      }
      if (reqInput.method === "POST" && /\/mcp-servers$/.test(url.pathname)) {
        const body = await reqInput.json<{ name: string; auth_type: string; auth_secret_name: string | null }>();
        const row = { id: `srv-${mcpServers.length + 1}`, name: body.name, auth_type: body.auth_type, auth_secret_name: body.auth_secret_name };
        mcpServers.push(row);
        return Response.json(row, { status: 201 });
      }
      if (reqInput.method === "PATCH") {
        const body = await reqInput.json<{ auth_type: string; auth_secret_name: string | null }>();
        const id = url.pathname.split("/").pop();
        const row = mcpServers.find((s) => s.id === id);
        if (row) { row.auth_type = body.auth_type; row.auth_secret_name = body.auth_secret_name; }
        return Response.json(row ?? {});
      }
      return new Response("not found", { status: 404 });
    },
  };

  return {
    PLATFORM_SECRET: SECRET,
    PUBLIC_AGENTS_URL: "https://agents.naelao.com",
    WHOP_OAUTH_CLIENT_ID: "app_test123",
    WHOP_OAUTH_CLIENT_SECRET: "secret_test",
    AGENT_CACHE: new FakeKv() as unknown as KVNamespace,
    CREDENTIALS_WORKER: credentialsWorker as unknown as Fetcher,
    MCP_HUB: mcpHub as unknown as Fetcher,
    ANALYTICS: { writeDataPoint() {} },
    __credentialCalls: credentialCalls,
    __mcpServers: mcpServers,
    ...overrides,
  } as unknown as AgentsEnv & {
    __credentialCalls: typeof credentialCalls;
    __mcpServers: typeof mcpServers;
  };
}

const realFetch = globalThis.fetch;
let fetchOverride: typeof globalThis.fetch | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  fetchOverride = null;
});

function mockWhopTokenEndpoint(respond: (body: URLSearchParams) => unknown) {
  fetchOverride = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "https://api.whop.com/oauth/token") {
      const body = new URLSearchParams(init?.body as string);
      return Response.json(respond(body));
    }
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
  globalThis.fetch = fetchOverride;
}

async function startReq(env: AgentsEnv, spaceId = "space-a") {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return app.fetch(
    new Request("https://agents.naelao.com/connectors/whop/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ space_id: spaceId, return_url: "https://shell.naelao.com/p/acme/spaces/space-a" }),
    }),
    env as never
  );
}

describe("POST /connectors/whop/oauth/start", () => {
  it("returns a real authorize_url with PKCE challenge + the ticket as state", async () => {
    const env = makeEnv();
    const res = await startReq(env);
    expect(res.status).toBe(200);
    const { authorize_url } = await res.json<{ authorize_url: string }>();
    const u = new URL(authorize_url);
    expect(u.origin + u.pathname).toBe("https://api.whop.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("app_test123");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://agents.naelao.com/connectors/whop/oauth/callback");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("degrades honestly to oauth_not_configured when the OAuth app isn't set up", async () => {
    const env = makeEnv({ WHOP_OAUTH_CLIENT_ID: undefined });
    const res = await startReq(env);
    expect(res.status).toBe(503);
    const j = await res.json<{ error_code: string }>();
    expect(j.error_code).toBe("oauth_not_configured");
  });
});

describe("GET /connectors/whop/oauth/callback", () => {
  it("rejects a missing/unknown state ticket with a clear message, not a crash", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/whop/oauth/callback?code=abc&state=does-not-exist"),
      env as never
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired|already used/i);
  });

  it("exchanges the code, vaults the tokens (never returns them to the browser), registers the MCP server, and redirects to return_url", async () => {
    const env = makeEnv();
    mockWhopTokenEndpoint((body) => {
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_secret")).toBe("secret_test");
      expect(body.get("code")).toBe("real-code");
      return { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 };
    });

    const startRes = await startReq(env);
    const { authorize_url } = await startRes.json<{ authorize_url: string }>();
    const state = new URL(authorize_url).searchParams.get("state")!;

    const cbRes = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/whop/oauth/callback?code=real-code&state=${state}`),
      env as never
    );
    expect(cbRes.status).toBe(302);
    const location = cbRes.headers.get("location")!;
    expect(location).toContain("https://shell.naelao.com/p/acme/spaces/space-a");
    expect(location).toContain("whop_connected=1");
    // Never leak the exchanged tokens into the redirect the browser follows.
    expect(location).not.toContain("at_1");
    expect(location).not.toContain("rt_1");

    expect(env.__credentialCalls.length).toBe(1);
    expect(env.__credentialCalls[0]!.name).toBe("WHOP_OAUTH_TOKENS");
    const stored = JSON.parse(env.__credentialCalls[0]!.value) as { access_token: string; refresh_token: string };
    expect(stored.access_token).toBe("at_1");
    expect(stored.refresh_token).toBe("rt_1");

    expect(env.__mcpServers.length).toBe(1);
    expect(env.__mcpServers[0]!.name).toBe("whop");
    expect(env.__mcpServers[0]!.auth_type).toBe("oauth2");
    expect(env.__mcpServers[0]!.auth_secret_name).toBe("WHOP_OAUTH_TOKENS");
  });

  it("a ticket cannot be redeemed twice — the second callback with the same state is rejected", async () => {
    const env = makeEnv();
    mockWhopTokenEndpoint(() => ({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }));
    const startRes = await startReq(env);
    const state = new URL((await startRes.json<{ authorize_url: string }>()).authorize_url).searchParams.get("state")!;

    const first = await app.fetch(new Request(`https://agents.naelao.com/connectors/whop/oauth/callback?code=c1&state=${state}`), env as never);
    expect(first.status).toBe(302);

    const second = await app.fetch(new Request(`https://agents.naelao.com/connectors/whop/oauth/callback?code=c2&state=${state}`), env as never);
    expect(second.status).toBe(400);
  });

  it("an error= query param from Whop redirects back with the error, not a 500", async () => {
    const env = makeEnv();
    const startRes = await startReq(env);
    const state = new URL((await startRes.json<{ authorize_url: string }>()).authorize_url).searchParams.get("state")!;
    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/whop/oauth/callback?error=access_denied&state=${state}`),
      env as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("whop_oauth_error=access_denied");
  });
});

describe("POST /internal/connectors/oauth/refresh", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/connectors/oauth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space_id: "space-a", platform: "whop", refresh_token: "rt_1" }),
      }),
      env as never
    );
    expect(res.status).toBe(401);
  });

  it("refreshes and re-stores the rotated tokens", async () => {
    const env = makeEnv();
    mockWhopTokenEndpoint((body) => {
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt_old");
      return { access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 };
    });
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/connectors/oauth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
        body: JSON.stringify({ space_id: "space-a", platform: "whop", refresh_token: "rt_old" }),
      }),
      env as never
    );
    expect(res.status).toBe(200);
    const j = await res.json<{ access_token: string }>();
    expect(j.access_token).toBe("at_new");
    expect(env.__credentialCalls[0]!.name).toBe("WHOP_OAUTH_TOKENS");
    expect(JSON.parse(env.__credentialCalls[0]!.value).access_token).toBe("at_new");
  });
});

describe("mcp-hub credential resolution — oauth2 proactive refresh", () => {
  const server: McpServer = {
    id: "srv-1", space_id: "space-a", tenant_id: "tenant-a", name: "whop",
    url: "https://mcp.naelao.com/connectors/whop", auth_type: "oauth2", auth_secret_name: "WHOP_OAUTH_TOKENS",
    enabled: 1, connector_provider: "direct", provider_connection_id: null,
    created_at: "", updated_at: "",
  };

  it("returns the current access token unchanged when it's not near expiry", async () => {
    const fresh = JSON.stringify({ access_token: "at_fresh", refresh_token: "rt_1", expires_at: Date.now() + 60 * 60_000 });
    const result = await resolveOAuthAccessToken(server, { PLATFORM_SECRET: SECRET } as never, fresh);
    expect(result).toBe("at_fresh");
  });

  it("proactively refreshes via the agents worker's internal endpoint when near expiry, and uses the new token", async () => {
    const refreshCalls: unknown[] = [];
    const agentsWorker = {
      async fetch(reqInput: Request) {
        const body = await reqInput.json();
        refreshCalls.push(body);
        const token = reqInput.headers.get("x-naelao-internal-token");
        expect(await verifyInternalToken(token ?? undefined, "tenant-a", SECRET)).toBe(true);
        return Response.json({ access_token: "at_refreshed" });
      },
    };
    const nearExpiry = JSON.stringify({ access_token: "at_stale", refresh_token: "rt_1", expires_at: Date.now() + 60_000 });
    const result = await resolveOAuthAccessToken(
      server,
      { PLATFORM_SECRET: SECRET, AGENTS_WORKER: agentsWorker as unknown as Fetcher } as never,
      nearExpiry
    );
    expect(result).toBe("at_refreshed");
    expect(refreshCalls.length).toBe(1);
    expect((refreshCalls[0] as { platform: string }).platform).toBe("whop");
  });

  it("falls back to the stale token rather than throwing when the refresh call itself fails", async () => {
    const agentsWorker = { async fetch() { return new Response("boom", { status: 500 }); } };
    const nearExpiry = JSON.stringify({ access_token: "at_stale", refresh_token: "rt_1", expires_at: Date.now() + 60_000 });
    const result = await resolveOAuthAccessToken(
      server,
      { PLATFORM_SECRET: SECRET, AGENTS_WORKER: agentsWorker as unknown as Fetcher } as never,
      nearExpiry
    );
    expect(result).toBe("at_stale");
  });

  it("falls back to the stale token when no AGENTS_WORKER binding is configured", async () => {
    const nearExpiry = JSON.stringify({ access_token: "at_stale", refresh_token: "rt_1", expires_at: Date.now() + 60_000 });
    const result = await resolveOAuthAccessToken(server, { PLATFORM_SECRET: SECRET } as never, nearExpiry);
    expect(result).toBe("at_stale");
  });
});
