import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import app from "./index.js";

const secret = "0123456789abcdef".repeat(4);
const id = "ap_live_0123456789abcdef01234567";
async function hash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function env(scopes: string[] = ["agentport:read"]) {
  const tokenSecret = "a".repeat(64);
  const record = { id, tenant_id: "tenant-1", owner_type: "individual", owner_id: "owner-1", scopes_json: JSON.stringify(scopes), expires_at: null };
  const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
    first: async () => sql.includes("SELECT id,tenant_id") && values[0] === id && values[1] === await hash(tokenSecret) ? record : sql.includes("SELECT d.status") ? { status: "active", tenant_id: "org-1", token_version: 0, role: "owner", organization_status: "active" } : sql.includes("RETURNING attempts") ? { attempts: 1 } : null,
    run: async () => ({ meta: { changes: 1 } }),
    all: async () => ({ results: [] }),
  }) }), batch: async () => [] } as unknown as D1Database;
  const fetch = vi.fn(async (request: Request) => Response.json({ forwarded: new URL(request.url).pathname }));
  return { PLATFORM_DB: db, PLATFORM_SECRET: secret, AGENTPORT_JWT_SECRET: "jwt-test-secret", ENVIRONMENT: "test", fetch, bearer: `Bearer ${id}.${tokenSecret}` };
}

describe("standalone AgentPort API", () => {
  it("rejects absent and malformed bearer credentials", async () => {
    const bindings = env();
    const response = await app.fetch(new Request("https://agentport.test/v1/services"), bindings);
    expect(response.status).toBe(401);
    expect(bindings.fetch).not.toHaveBeenCalled();
  });
  it("runs authorized API calls through the AgentPort-owned core with a tenant HMAC", async () => {
    const bindings = env();
    const response = await app.fetch(new Request("https://agentport.test/v1/services", { headers: { authorization: bindings.bearer } }), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ services: [] });
    expect(bindings.fetch).not.toHaveBeenCalled();
  });
  it("enforces the requested API-key scopes", async () => {
    const bindings = env(["agentport:read"]);
    const response = await app.fetch(new Request("https://agentport.test/v1/accounts", { method: "POST", headers: { authorization: bindings.bearer, "content-type": "application/json" }, body: "{}" }), bindings);
    expect(response.status).toBe(403);
    expect(bindings.fetch).not.toHaveBeenCalled();
  });
  it("serves MCP initialization and tools over the same bearer auth", async () => {
    const bindings = env();
    const response = await app.fetch(new Request("https://agentport.test/mcp", { method: "POST", headers: { authorization: bindings.bearer, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } }) }), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { protocolVersion: "2026-07-28", serverInfo: { name: "AgentPort" } } });
  });
  it("registers developer identity inside AgentPort and rate limits signup", async () => {
    const bindings = env();
    const response = await app.fetch(new Request("https://agentport.test/v1/auth/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" }, body: JSON.stringify({ email: "dev@example.test", password: "long-test-password" }) }), bindings);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { user: { email: "dev@example.test", role: "owner" }, organization: { id: expect.any(String) }, token: expect.any(String) } });
  });
  it("allows an organization owner JWT to mint the first scoped AgentPort key", async () => {
    const bindings = env();
    const jwt = await signJwt({ sub: "user-1", tid: "org-1", email: "dev@example.test", role: "owner", scopes: ["api:access"], tv: 0 }, bindings.AGENTPORT_JWT_SECRET);
    const response = await app.fetch(new Request("https://agentport.test/v1/keys", { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: ["agentport:read", "agentport:write", "agentport:events", "agentport:admin"] }) }), bindings);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: expect.stringMatching(/^ap_live_[a-f0-9]{24}$/), scopes: expect.arrayContaining(["agentport:admin"]) });
  });
});
