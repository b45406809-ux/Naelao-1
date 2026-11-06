import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import app from "./index.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const jwtSecret = "agentport-oauth-test-secret";
const platformSecret = "agentport-oauth-platform-secret";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agentport_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_developer_id TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE agentport_developers(id TEXT PRIMARY KEY,tenant_id TEXT,email TEXT,email_normalized TEXT UNIQUE,password_hash TEXT,role TEXT,status TEXT,token_version INTEGER,last_login_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE agentport_auth_rate_limits(bucket_key TEXT PRIMARY KEY,window_started_ms INTEGER,attempts INTEGER,updated_at TEXT);
    CREATE TABLE agentport_api_keys(id TEXT PRIMARY KEY,tenant_id TEXT,owner_type TEXT,owner_id TEXT,scopes_json TEXT,expires_at TEXT,key_hash TEXT,status TEXT,last_used_at TEXT);
    CREATE TABLE agentport_oauth_clients(client_id TEXT PRIMARY KEY,owner_tenant_id TEXT,owner_developer_id TEXT,client_name TEXT,redirect_uris_json TEXT,status TEXT DEFAULT 'active',created_at TEXT,revoked_at TEXT);
    CREATE TABLE agentport_oauth_codes(code_hash TEXT PRIMARY KEY,client_id TEXT,tenant_id TEXT,developer_id TEXT,redirect_uri TEXT,code_challenge TEXT,scopes_json TEXT,expires_at TEXT,consumed_at TEXT,created_at TEXT);
    CREATE TABLE agentport_oauth_tokens(token_hash TEXT PRIMARY KEY,client_id TEXT,tenant_id TEXT,developer_id TEXT,scopes_json TEXT,expires_at TEXT,revoked_at TEXT,created_at TEXT);
    CREATE TABLE agentport_oauth_refresh_tokens(token_hash TEXT PRIMARY KEY,client_id TEXT,tenant_id TEXT,developer_id TEXT,scopes_json TEXT,expires_at TEXT,revoked_at TEXT,replaced_by_hash TEXT,created_at TEXT);`);
  const prepare = (sql: string) => ({ bind: (...values: unknown[]) => ({
    first: async <T>() => db.prepare(sql).get(...values as never[]) as T | undefined,
    all: async <T>() => ({ results: db.prepare(sql).all(...values as never[]) as T[] }),
    run: async () => { const result = db.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
  }) });
  const PLATFORM_DB = { prepare, batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(statements.map(statement => statement.run())) } as unknown as D1Database;
  const env = { PLATFORM_DB, PLATFORM_SECRET: platformSecret, AGENTPORT_JWT_SECRET: jwtSecret, ENVIRONMENT: "test", AGENTPORT_ISSUER: "https://agentport.test" };
  return { db, env };
}
const challenge = async (verifier: string) => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

describe("AgentPort OAuth account linking", () => {
  it("uses standalone login, registered exact callbacks, PKCE, scoped tokens, rotation, and revocation", async () => {
    const { db, env } = fixture();
    const register = await app.fetch(new Request("https://agentport.test/v1/auth/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.2" }, body: JSON.stringify({ email: "owner@example.test", password: "a-secure-passphrase", org_name: "Owner" }) }), env);
    expect(register.status).toBe(201);
    const auth = await register.json() as { data: { token: string; user: { id: string }; organization: { id: string } } };
    const created = await app.fetch(new Request("https://agentport.test/v1/oauth/clients", { method: "POST", headers: { authorization: `Bearer ${auth.data.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Naelao", redirectUris: ["https://naelao.test/agentport/callback"] }) }), env);
    expect(created.status).toBe(201);
    const { client } = await created.json() as { client: { clientId: string } };
    const invalidCallback = await app.fetch(new Request("https://agentport.test/oauth/authorize?response_type=code&client_id=" + client.clientId + "&redirect_uri=https%3A%2F%2Fevil.test%2Fcallback&state=s&code_challenge=" + "a".repeat(43) + "&code_challenge_method=S256"), env);
    expect(invalidCallback.status).toBe(400);

    const verifier = "v".repeat(64); const codeChallenge = await challenge(verifier); const state = "csrf-state-value";
    const query = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: "https://naelao.test/agentport/callback", state, code_challenge: codeChallenge, code_challenge_method: "S256", scope: "agentport:read agentport:write offline_access" });
    const unauthenticated = await app.fetch(new Request(`https://agentport.test/oauth/authorize?${query}`), env);
    expect(unauthenticated.status).toBe(302);
    expect(unauthenticated.headers.get("location")).toContain("/auth?return_to=");
    const login = await app.fetch(new Request("https://agentport.test/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.3" }, body: JSON.stringify({ email: "owner@example.test", password: "a-secure-passphrase" }) }), env);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("agentport_session=");
    const consent = await app.fetch(new Request(`https://agentport.test/oauth/authorize?${query}`, { headers: { cookie: cookie! } }), env);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Messages, channel content, and provider account data remain with their providers.");
    const approve = new URLSearchParams(Object.fromEntries(query.entries())); approve.set("decision", "allow");
    const approved = await app.fetch(new Request("https://agentport.test/oauth/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie!, origin: "https://agentport.test" }, body: approve }), env);
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code")!;
    const tokenRequest = new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.clientId, redirect_uri: "https://naelao.test/agentport/callback", code_verifier: verifier });
    const tokenResponse = await app.fetch(new Request("https://agentport.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequest }), env);
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(token).toMatchObject({ token_type: "Bearer", access_token: expect.stringMatching(/^ap_oauth_/), refresh_token: expect.stringMatching(/^ap_refresh_/) });
    const me = await app.fetch(new Request("https://agentport.test/v1/auth/me", { headers: { authorization: `Bearer ${token.access_token}` } }), env);
    expect(await me.json()).toMatchObject({ user: { id: auth.data.user.id, email: "owner@example.test" }, scopes: ["agentport:read", "agentport:write", "offline_access"] });
    const delegatedClientManagement = await app.fetch(new Request("https://agentport.test/v1/oauth/clients", { headers: { authorization: `Bearer ${token.access_token}` } }), env);
    expect(delegatedClientManagement.status).toBe(403);
    const replay = await app.fetch(new Request("https://agentport.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequest }), env);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const refreshBody = new URLSearchParams({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: token.refresh_token });
    const refreshed = await app.fetch(new Request("https://agentport.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: refreshBody }), env);
    const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(refreshed.status).toBe(200);
    const oldRefresh = await app.fetch(new Request("https://agentport.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: refreshBody }), env);
    expect(await oldRefresh.json()).toMatchObject({ error: "invalid_grant" });
    const revokeClient = await app.fetch(new Request(`https://agentport.test/v1/oauth/clients/${client.clientId}`, { method: "DELETE", headers: { authorization: `Bearer ${auth.data.token}` } }), env);
    expect(await revokeClient.json()).toMatchObject({ revoked: true });
    const revokedUse = await app.fetch(new Request("https://agentport.test/v1/auth/me", { headers: { authorization: `Bearer ${rotated.access_token}` } }), env);
    expect(revokedUse.status).toBe(401);
    const logout = await app.fetch(new Request("https://agentport.test/v1/auth/logout", { method: "POST", headers: { cookie: cookie! } }), env);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const loggedOutOwner = await app.fetch(new Request("https://agentport.test/v1/oauth/clients", { headers: { authorization: `Bearer ${auth.data.token}` } }), env);
    expect(loggedOutOwner.status).toBe(401);
    db.close();
  });
});
