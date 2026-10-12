import { mintInternalToken } from "@naelao/http";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentsEnv, app } from "../../workers/agents/src/index.js";

const SECRET = "tenant-oauth-test-secret";
class TestKv {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}
function makeEnv() {
  const kv = new TestKv();
  const credentials = new Map<string, string>();
  const servers: Array<Record<string, unknown>> = [];
  const calls: Array<{ name: string; value: string }> = [];
  const env = {
    PLATFORM_SECRET: SECRET,
    PUBLIC_AGENTS_URL: "https://agents.naelao.com",
    AGENT_CACHE: kv as unknown as KVNamespace,
    PLATFORM_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            config_json: JSON.stringify({
              security: {
                egress: { allowedHosts: ["identity.example", "mcp.example"] },
              },
            }),
          }),
        }),
      }),
    } as unknown as D1Database,
    CREDENTIALS_WORKER: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (
          request.method === "POST" &&
          url.pathname === "/spaces/space-a/credentials"
        ) {
          const body = await request.json<{ name: string; value: string }>();
          credentials.set(body.name, body.value);
          calls.push(body);
          return Response.json({ id: body.name }, { status: 201 });
        }
        const match = url.pathname.match(/\/credentials\/([^/]+)\/plaintext$/);
        if (request.method === "POST" && match) {
          const credentialName = match[1];
          if (!credentialName) return new Response("missing", { status: 404 });
          const value = credentials.get(decodeURIComponent(credentialName));
          return value === undefined
            ? new Response("missing", { status: 404 })
            : Response.json({ value });
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as Fetcher,
    MCP_HUB: {
      async fetch(request: Request) {
        if (request.method === "GET") return Response.json({ data: servers });
        const body = await request.json<Record<string, unknown>>();
        servers.push({ id: "srv-custom-1", ...body });
        return Response.json({ id: "srv-custom-1" }, { status: 201 });
      },
    } as unknown as Fetcher,
    ANALYTICS: { writeDataPoint() {} },
    __test: { kv, credentials, servers, calls },
  } as unknown as AgentsEnv & {
    __test: {
      kv: TestKv;
      credentials: Map<string, string>;
      servers: Array<Record<string, unknown>>;
      calls: Array<{ name: string; value: string }>;
    };
  };
  return env;
}
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
async function request(
  env: AgentsEnv,
  path: string,
  body: unknown,
  role = "admin"
) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return app.fetch(
    new Request(`https://agents.naelao.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-user-id": "user-a",
        "x-naelao-role": role,
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify(body),
    }),
    env as never
  );
}

describe("tenant-owned custom OAuth", () => {
  it("keeps tenant OAuth credentials vaulted and completes PKCE into an MCP registration", async () => {
    const env = makeEnv();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/dns-query"))
        return Response.json({
          Status: 0,
          Answer: url.includes("type=AAAA") ? [] : [{ data: "1.1.1.1" }],
        });
      if (url === "https://identity.example/oauth/token") {
        const form = new URLSearchParams(init?.body as string);
        expect(form.get("client_id")).toBe("tenant-client");
        expect(form.get("client_secret")).toBe("tenant-secret");
        if (form.get("grant_type") === "authorization_code") {
          expect(form.get("code_verifier")).toBeTruthy();
          return Response.json({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
          });
        }
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("refresh");
        return Response.json({
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected outbound request ${url}`);
    }) as typeof fetch;
    const started = await request(
      env,
      "/connectors/custom-oauth/port_edi/oauth/start",
      {
        space_id: "space-a",
        return_url: "https://shell.naelao.com/p/acme/spaces/space-a",
        display_name: "Port EDI",
        client_id: "tenant-client",
        client_secret: "tenant-secret",
        authorization_url: "https://identity.example/oauth/authorize",
        token_url: "https://identity.example/oauth/token",
        scopes: ["manifest:read"],
        mcp_url: "https://mcp.example/mcp",
      }
    );
    expect(started.status).toBe(200);
    const startBody = await started.json<{
      authorize_url: string;
      redirect_uri: string;
    }>();
    const authorization = new URL(startBody.authorize_url);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256"
    );
    expect(authorization.searchParams.get("client_secret")).toBeNull();
    expect(startBody.redirect_uri).toBe(
      "https://agents.naelao.com/connectors/custom-oauth/port_edi/oauth/callback"
    );
    expect(env.__test.calls).toHaveLength(1);
    expect(env.__test.calls[0]?.name).toBe("TENANT_OAUTH_PORT_EDI_CONFIG");

    const callback = await app.fetch(
      new Request(
        `${startBody.redirect_uri}?code=one-time-code&state=${authorization.searchParams.get("state")}`
      ),
      env as never
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("port_edi_connected=1");
    expect(
      env.__test.credentials.get("TENANT_OAUTH_PORT_EDI_TOKENS")
    ).toContain('"refresh_token":"refresh"');
    expect(env.__test.servers[0]).toMatchObject({
      name: "custom-oauth:port_edi",
      url: "https://mcp.example/mcp",
      auth_type: "oauth2",
      auth_secret_name: "TENANT_OAUTH_PORT_EDI_TOKENS",
    });
    const refreshed = await request(env, "/internal/connectors/oauth/refresh", {
      space_id: "space-a",
      platform: "custom-oauth:port_edi",
      refresh_token: "refresh",
    });
    expect(refreshed.status).toBe(200);
    expect(
      env.__test.credentials.get("TENANT_OAUTH_PORT_EDI_TOKENS")
    ).toContain('"refresh_token":"refresh-rotated"');
    const replay = await app.fetch(
      new Request(
        `${startBody.redirect_uri}?code=again&state=${authorization.searchParams.get("state")}`
      ),
      env as never
    );
    expect(replay.status).toBe(400);
  });

  it("requires owner/admin authority and the space's explicit egress grants", async () => {
    const env = makeEnv();
    const data = {
      space_id: "space-a",
      return_url: "https://shell.naelao.com/p/a",
      display_name: "ERP",
      client_id: "id",
      client_secret: "secret",
      authorization_url: "https://identity.example/auth",
      token_url: "https://identity.example/token",
      scopes: [],
      mcp_url: "https://ungranted.example/mcp",
    };
    expect(
      (
        await request(
          env,
          "/connectors/custom-oauth/private_erp/oauth/start",
          data,
          "member"
        )
      ).status
    ).toBe(403);
    expect(
      (
        await request(
          env,
          "/connectors/custom-oauth/private_erp/oauth/start",
          data
        )
      ).status
    ).toBe(400);
    expect(env.__test.calls).toHaveLength(0);
  });
});
