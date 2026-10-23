import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Regression coverage for two real bugs found in a wallet retirement and connector audit:
//   1. POST /connectors/:platform/connect vaulted the API key with NO x-naelao-user-id header
//      (the real credentials worker 400s without one) and no `scope` (defaults to 'user', a row
//      mcp-hub's actingUserId-less resolveCredential() call can never read back).
//   2. POST /channels/:channel/connect posted to "/v1/spaces/.../credentials" — a path that
//      doesn't exist on the credentials worker (only its internal plaintext-resolution route has
//      a /v1 prefix) — and also omitted x-naelao-user-id/scope.
// Both are fixed via the shared storeConnectorCredential() helper (workers/agents/src/index.ts).
// The stub below mirrors the REAL credentials worker's contract closely enough to catch a
// regression of either bug.

const SECRET = "test-platform-secret";

function makeCredentialsWorkerStub() {
  const calls: Array<{ path: string; hasUserId: boolean; scope?: string; name: string; value: string }> = [];
  const worker = {
    async fetch(reqInput: Request) {
      const url = new URL(reqInput.url);
      if (!/^\/spaces\/[^/]+\/credentials$/.test(url.pathname)) {
        return new Response(`not found: ${url.pathname}`, { status: 404 });
      }
      const hasUserId = Boolean(reqInput.headers.get("x-naelao-user-id"));
      if (!hasUserId) return new Response("x-naelao-user-id header is required", { status: 400 });
      const role = reqInput.headers.get("x-naelao-role") ?? "";
      const body = await reqInput.json<{ name: string; value: string; scope?: string }>().catch(() => ({ name: "", value: "" }));
      if ((body.scope ?? "user") === "space" && role !== "owner" && role !== "admin") {
        return new Response("Only owner/admin may set a space-shared credential", { status: 403 });
      }
      calls.push({ path: url.pathname, hasUserId, scope: body.scope, name: body.name, value: body.value });
      return Response.json({ id: "cred-1", name: body.name, scope: body.scope ?? "user" }, { status: 201 });
    },
  };
  return { worker, calls };
}

function makeMcpHubStub() {
  const servers: Array<{ id: string; name: string; auth_type: string; auth_secret_name: string | null }> = [];
  const worker = {
    async fetch(reqInput: Request) {
      const url = new URL(reqInput.url);
      if (reqInput.method === "GET" && /\/mcp-servers$/.test(url.pathname)) return Response.json({ data: servers });
      if (reqInput.method === "POST" && /\/mcp-servers$/.test(url.pathname)) {
        const body = await reqInput.json<{ name: string; auth_type: string; auth_secret_name: string | null }>();
        const row = { id: `srv-${servers.length + 1}`, ...body };
        servers.push(row);
        return Response.json(row, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return { worker, servers };
}

describe("POST /connectors/:platform/connect — vault write contract", () => {
  it("stores the API key at scope='space' with x-naelao-user-id set, at the real credentials-worker path", async () => {
    const { worker: credentialsWorker, calls } = makeCredentialsWorkerStub();
    const { worker: mcpHub } = makeMcpHubStub();
    const env = {
      PLATFORM_SECRET: SECRET,
      CREDENTIALS_WORKER: credentialsWorker as unknown as Fetcher,
      MCP_HUB: mcpHub as unknown as Fetcher,
    } as unknown as AgentsEnv;

    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/gumroad/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "user-1",
          "x-naelao-role": "owner",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-a", api_key: "gr_secret_123" }),
      }),
      env as never
    );

    expect(res.status).toBe(201);
    expect(calls.length).toBe(1);
    expect(calls[0]!.path).toBe("/spaces/space-a/credentials");
    expect(calls[0]!.hasUserId).toBe(true);
    expect(calls[0]!.scope).toBe("space");
    expect(calls[0]!.name).toBe("GUMROAD_ACCESS_TOKEN");
    expect(calls[0]!.value).toBe("gr_secret_123");
  });

  // §A1.18 connector scope model: the spaces-worker wrapper relaxed its own gate from
  // "admin-only" to "member" (any member can attempt to connect their OWN personal connector),
  // so THIS route is now the one place that enforces admin-only for a scope_model='space'
  // connector — resolved from x-naelao-business-role, forwarded ONLY for a product_end_user
  // caller (a builder's own JWT caller never sends it, so its existing 201 above is proof the
  // new check doesn't regress that path).
  it("refuses a scope_model='space' connector for a non-admin business role", async () => {
    const { worker: credentialsWorker, calls } = makeCredentialsWorkerStub();
    const { worker: mcpHub } = makeMcpHubStub();
    const env = {
      PLATFORM_SECRET: SECRET,
      CREDENTIALS_WORKER: credentialsWorker as unknown as Fetcher,
      MCP_HUB: mcpHub as unknown as Fetcher,
    } as unknown as AgentsEnv;

    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/gumroad/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "end-user-1",
          "x-naelao-business-role": "member",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-a", api_key: "gr_secret_123" }),
      }),
      env as never
    );
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0); // never even reached the vault write
  });

  it("allows a scope_model='space' connector for an admin business role", async () => {
    const { worker: credentialsWorker, calls } = makeCredentialsWorkerStub();
    const { worker: mcpHub } = makeMcpHubStub();
    const env = {
      PLATFORM_SECRET: SECRET,
      CREDENTIALS_WORKER: credentialsWorker as unknown as Fetcher,
      MCP_HUB: mcpHub as unknown as Fetcher,
    } as unknown as AgentsEnv;

    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/gumroad/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "end-user-1",
          "x-naelao-business-role": "admin",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-a", api_key: "gr_secret_123" }),
      }),
      env as never
    );
    expect(res.status).toBe(201);
    expect(calls.length).toBe(1);
  });

  it("surfaces credential_store_failed (not a silent success) when the vault write is rejected", async () => {
    const { worker: mcpHub } = makeMcpHubStub();
    const env = {
      PLATFORM_SECRET: SECRET,
      CREDENTIALS_WORKER: { async fetch() { return new Response("vault down", { status: 500 }); } } as unknown as Fetcher,
      MCP_HUB: mcpHub as unknown as Fetcher,
    } as unknown as AgentsEnv;

    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/connectors/gumroad/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "user-1",
          "x-naelao-role": "owner",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-a", api_key: "gr_secret_123" }),
      }),
      env as never
    );
    expect(res.status).toBe(502);
    const j = await res.json<{ error_code: string }>();
    expect(j.error_code).toBe("credential_store_failed");
  });
});

describe("POST /channels/:channel/connect — vault write contract", () => {
  it("stores the signing secret at scope='space' with x-naelao-user-id set, at the real credentials-worker path", async () => {
    const { worker: credentialsWorker, calls } = makeCredentialsWorkerStub();
    const env = {
      PLATFORM_SECRET: SECRET,
      CREDENTIALS_WORKER: credentialsWorker as unknown as Fetcher,
      PLATFORM_DB: {
        prepare() {
          return { bind() { return { run: async () => ({ meta: { changes: 1 } }) } as never; } } as never;
        },
      } as unknown as AgentsEnv["PLATFORM_DB"],
    } as unknown as AgentsEnv;

    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/channels/slack/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "user-1",
          "x-naelao-role": "owner",
          "x-naelao-internal-token": token,
        },
        body: JSON.stringify({ space_id: "space-a", secret: "shh_signing_secret" }),
      }),
      env as never
    );

    expect(res.status).toBe(201);
    expect(calls.length).toBe(1);
    // Must be the real credentials-worker CRUD path — the pre-fix version posted to
    // "/v1/spaces/.../credentials", which 404s against the real worker (only the internal
    // plaintext-resolution route carries a /v1 prefix).
    expect(calls[0]!.path).toBe("/spaces/space-a/credentials");
    expect(calls[0]!.hasUserId).toBe(true);
    expect(calls[0]!.scope).toBe("space");
    expect(calls[0]!.name).toBe("SLACK_SIGNING_SECRET");
    expect(calls[0]!.value).toBe("shh_signing_secret");
  });
});
