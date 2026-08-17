import { describe, it, expect, afterEach } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { mcpConnector } from "../../workers/agents/src/script-engine/prebuilt/mcp-connector.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Composio "click Install" hosted-connect flow (growth layer G-1/G-3) — the mechanism behind a
// real click-to-Install connector experience for Twitter/LinkedIn/Instagram/TikTok/etc, distinct
// from Whop's bespoke OAuth2+PKCE app (whop-oauth-connect.test.ts). Safety invariants under test:
//   1. The start route only builds a real connect_url when the platform key + auth config are
//      configured, never fabricates one — and never proceeds without them.
//   2. The callback's `ticket` is single-use — an unknown/expired ticket is rejected cleanly.
//   3. The connection is only registered as an MCP server after POLLING Composio's real status as
//      ACTIVE — a bailed-out consent flow never gets silently marked connected.
//   4. No OAuth token/credential is ever vaulted for a composio-routed connector — mcp-hub
//      resolves it via the platform COMPOSIO_API_KEY + provider_connection_id at call time.

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
    COMPOSIO_API_KEY: "composio_test_key",
    COMPOSIO_TWITTER_AUTH_CONFIG_ID: "ac_twitter_123",
    AGENT_CACHE: new FakeKv() as unknown as KVNamespace,
    MCP_HUB: mcpHub as unknown as Fetcher,
    ANALYTICS: { writeDataPoint() {} },
    __mcpServers: mcpServers,
    ...overrides,
  } as unknown as AgentsEnv & { __mcpServers: typeof mcpServers };
}

const realFetch = globalThis.fetch;
let fetchOverride: typeof globalThis.fetch | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  fetchOverride = null;
});

function mockComposio(opts: {
  linkStatus?: number;
  linkBody?: unknown;
  connectionStatus?: string;
  /** The on-demand managed Auth Config creation, used when no hand-registered id is configured. */
  authConfigStatus?: number;
  authConfigBody?: unknown;
  expectAuthConfigId?: string;
}) {
  fetchOverride = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "https://backend.composio.dev/api/v3.1/auth_configs") {
      return new Response(
        JSON.stringify(opts.authConfigBody ?? { auth_config: { id: "ac_managed_1", is_composio_managed: true } }),
        { status: opts.authConfigStatus ?? 201 }
      );
    }
    if (url === "https://backend.composio.dev/api/v3/connected_accounts/link") {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("composio_test_key");
      const body = JSON.parse(init?.body as string) as { user_id: string; auth_config_id: string; callback_url: string };
      expect(body.user_id).toBe("naelao-space:space-a");
      expect(body.auth_config_id).toBe(opts.expectAuthConfigId ?? "ac_twitter_123");
      return new Response(
        JSON.stringify(opts.linkBody ?? { redirect_url: "https://backend.composio.dev/consent/xyz", id: "conn_abc123" }),
        { status: opts.linkStatus ?? 200 }
      );
    }
    if (url.startsWith("https://backend.composio.dev/api/v3/connected_accounts/conn_abc123")) {
      return Response.json({ status: opts.connectionStatus ?? "ACTIVE" });
    }
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
  globalThis.fetch = fetchOverride;
}

async function startReq(env: AgentsEnv, platform = "twitter", spaceId = "space-a") {
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

describe("POST /connectors/:platform/provider-connect/start", () => {
  it("returns a real connect_url from Composio's hosted link API", async () => {
    const env = makeEnv();
    mockComposio({});
    const res = await startReq(env);
    expect(res.status).toBe(200);
    const { connect_url } = await res.json<{ connect_url: string }>();
    expect(connect_url).toBe("https://backend.composio.dev/consent/xyz");
  });

  it("degrades honestly to provider_not_configured when the platform key is unset", async () => {
    const env = makeEnv({ COMPOSIO_API_KEY: undefined });
    const res = await startReq(env);
    expect(res.status).toBe(503);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_not_configured");
  });

  it("falls back to Composio-managed auth when no hand-registered Auth Config id is set", async () => {
    // This used to 503. Requiring a per-app Auth Config, registered by hand in Composio's
    // dashboard, is what kept most of the catalogue permanently "coming soon" — Composio will
    // run the OAuth dance with its OWN app credentials, so the env var is now an override for
    // the connectors where we want our own OAuth app, not a precondition for connecting at all.
    const env = makeEnv({ COMPOSIO_TWITTER_AUTH_CONFIG_ID: undefined });
    mockComposio({ expectAuthConfigId: "ac_managed_1" });
    const res = await startReq(env);
    expect(res.status).toBe(200);
    expect((await res.json<{ connect_url: string }>()).connect_url).toBeTruthy();
  });

  it("still degrades honestly when Composio has no managed app for the toolkit", async () => {
    const env = makeEnv({ COMPOSIO_TWITTER_AUTH_CONFIG_ID: undefined });
    mockComposio({ authConfigStatus: 400, authConfigBody: { error: { message: "no managed auth" } } });
    const res = await startReq(env);
    expect(res.status).toBe(502);
    expect((await res.json<{ error_code: string; message: string }>()).error_code).toBe("provider_connect_unavailable");
  });

  it("rejects a connector with no composio spec at all (e.g. Whop, which uses its own OAuth app)", async () => {
    const env = makeEnv();
    const res = await startReq(env, "whop");
    expect(res.status).toBe(400);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_connect_not_supported");
  });

  it("surfaces a clear error when Composio's link call itself fails", async () => {
    const env = makeEnv();
    mockComposio({ linkStatus: 500, linkBody: { error: "boom" } });
    const res = await startReq(env);
    expect(res.status).toBe(502);
    expect((await res.json<{ error_code: string }>()).error_code).toBe("provider_connect_failed");
  });
});

describe("GET /connectors/:platform/provider-connect/callback", () => {
  it("rejects a missing/unknown ticket with a clear message, not a crash", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/twitter/provider-connect/callback?ticket=does-not-exist"),
      env as never
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired|already used/i);
  });

  it("polls the real connection status and only registers the connector when ACTIVE, then redirects with no credential in the URL", async () => {
    const env = makeEnv();
    mockComposio({ connectionStatus: "ACTIVE" });
    const startRes = await startReq(env);
    expect(startRes.status).toBe(200);
    const { connect_url } = await startRes.json<{ connect_url: string }>();
    expect(connect_url).toBeTruthy();

    // The ticket lives in AGENT_CACHE keyed off the callback URL start built internally — recover
    // it the same way a real browser would: by following the callback the start route wired up.
    // We don't have direct access to the generated ticket id from the response (by design — it's
    // server-held), so read it back out of the fake KV store directly for the test.
    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const keys = [...(kv as unknown as { store: Map<string, string> }).store.keys()];
    const ticketKey = keys.find((k) => k.startsWith("connector-provider-ticket:"));
    expect(ticketKey).toBeTruthy();
    const ticketId = ticketKey!.replace("connector-provider-ticket:", "");

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/twitter/provider-connect/callback?ticket=${ticketId}`),
      env as never
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("twitter_connected=1");
    expect(location).not.toMatch(/conn_abc123|access_token|token=/);

    expect(env.__mcpServers.length).toBe(1);
    expect(env.__mcpServers[0]!.name).toBe("twitter");
    expect(env.__mcpServers[0]!.connector_provider).toBe("composio");
    expect(env.__mcpServers[0]!.provider_connection_id).toBe("conn_abc123");
    expect(env.__mcpServers[0]!.auth_type).toBe("none");

    // A replayed callback URL can't be redeemed twice.
    const replay = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/twitter/provider-connect/callback?ticket=${ticketId}`),
      env as never
    );
    expect(replay.status).toBe(400);
  });

  it("does NOT register the connector when the connection never actually activated (bailed-out consent)", async () => {
    const env = makeEnv();
    mockComposio({ connectionStatus: "FAILED" });
    const startRes = await startReq(env);
    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const ticketKey = [...(kv as unknown as { store: Map<string, string> }).store.keys()].find((k) => k.startsWith("connector-provider-ticket:"));
    void (await startRes.json());

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/twitter/provider-connect/callback?ticket=${ticketKey!.replace("connector-provider-ticket:", "")}`),
      env as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("twitter_oauth_error=connection_failed");
    expect(env.__mcpServers.length).toBe(0);
  });

  it("REVOKED is surfaced as its own distinct reason, not lumped into FAILED/UNKNOWN", async () => {
    // A real, distinct Composio status: the end user disconnected the app on Composio's/the
    // target app's own side after the connection was once active. Must never silently register.
    const env = makeEnv();
    mockComposio({ connectionStatus: "REVOKED" });
    const startRes = await startReq(env);
    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const ticketKey = [...(kv as unknown as { store: Map<string, string> }).store.keys()].find((k) => k.startsWith("connector-provider-ticket:"));
    void (await startRes.json());

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/twitter/provider-connect/callback?ticket=${ticketKey!.replace("connector-provider-ticket:", "")}`),
      env as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("twitter_oauth_error=connection_revoked");
    expect(env.__mcpServers.length).toBe(0);
  });

  it("prefers connected_account_id over other field names when parsing the link response", async () => {
    const env = makeEnv();
    mockComposio({
      linkBody: {
        // Real Composio SDK shape (composio/core/models/connected_accounts.py): snake_case,
        // top-level. Also include a decoy `id` to prove the preference order — if pick() picked
        // this instead, the callback's status poll (keyed on conn_abc123 in mockComposio) would
        // 404/UNKNOWN and registration would never happen.
        redirect_url: "https://backend.composio.dev/consent/xyz",
        connected_account_id: "conn_abc123",
        id: "decoy-id-that-must-not-be-used",
      },
      connectionStatus: "ACTIVE",
    });
    const startRes = await startReq(env);
    expect(startRes.status).toBe(200);
    const kv = env.AGENT_CACHE as unknown as FakeKv;
    const ticketKey = [...(kv as unknown as { store: Map<string, string> }).store.keys()].find((k) => k.startsWith("connector-provider-ticket:"));
    const res = await app.fetch(
      new Request(`https://agents.naelao.com/connectors/twitter/provider-connect/callback?ticket=${ticketKey!.replace("connector-provider-ticket:", "")}`),
      env as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("twitter_connected=1");
    expect(env.__mcpServers[0]!.provider_connection_id).toBe("conn_abc123");
  });
});

describe("mcp-connector resolveServerId — needs_connector signal (click-Install onboarding)", () => {
  function makeScriptEnv(servers: Array<{ id: string; name: string }> = []): ScriptEngineEnv {
    const mcpHubWorker = {
      async fetch() {
        return Response.json({ data: servers });
      },
    };
    return {
      spaceId: "space-1", tenantId: "tenant-1", agentId: "agent-1", platformSecret: SECRET,
      mcpHubWorker: mcpHubWorker as unknown as Fetcher,
    } as unknown as ScriptEngineEnv;
  }
  const noopRun = async () => ({});

  it("names the exact catalogued connector to connect, and flags needs_connector", async () => {
    const env = makeScriptEnv([]);
    await expect(
      mcpConnector.operations["call"]!({ server: "twitter", tool: "create_post", params: {} }, { env, run: noopRun })
    ).rejects.toThrow(/Twitter.*not connected|Connect Apps/i);
    try {
      await mcpConnector.operations["call"]!({ server: "twitter", tool: "create_post", params: {} }, { env, run: noopRun });
      expect.unreachable();
    } catch (err) {
      const meta = err as unknown as Record<string, unknown>;
      expect(meta["needsConnector"]).toBe(true);
      expect(meta["connectorId"]).toBe("twitter");
      expect(meta["connectorName"]).toBe("X (Twitter)");
    }
  });

  it("a truly unknown server name gets the old plain error, not a connector prompt", async () => {
    const env = makeScriptEnv([]);
    try {
      await mcpConnector.operations["call"]!({ server: "not-a-real-thing", tool: "x", params: {} }, { env, run: noopRun });
      expect.unreachable();
    } catch (err) {
      const meta = err as unknown as Record<string, unknown>;
      expect(meta["needsConnector"]).toBeUndefined();
      expect((err as Error).message).toMatch(/no registered server/);
    }
  });

  it("succeeds normally once the server IS registered", async () => {
    const env = makeScriptEnv([{ id: "srv-9", name: "twitter" }]);
    const { resolveServerId } = await import("../../workers/agents/src/script-engine/prebuilt/mcp-connector.js");
    const id = await resolveServerId({ env, run: noopRun }, "twitter");
    expect(id).toBe("srv-9");
  });
});
