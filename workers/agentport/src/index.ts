import { Hono, type Context } from "hono";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import { signJwt, verifyJwt } from "@naelao/auth";
import type { NaelaoJwtClaims } from "@naelao/types";
import { agentPortRoutes } from "./core/routes.js";

interface Env {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  AGENTPORT_JWT_SECRET: string;
  ENVIRONMENT: string;
  AGENTPORT_ISSUER?: string;
}
interface ApiKeyRow { id: string; tenant_id: string; owner_type: string; owner_id: string; scopes_json: string; expires_at: string | null; }
interface AuthContext { key?: ApiKeyRow; tenantId: string; ownerId: string; ownerType: string; scopes: string[]; userClaims?: NaelaoJwtClaims; }
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID().replaceAll("-", "");
const encoder = new TextEncoder();
async function digest(value: string) { const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function tokenSecret() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return [...bytes].map(x => x.toString(16).padStart(2, "0")).join(""); }
function tokenId() { return [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, "0")).join(""); }
const DUMMY_PASSWORD_HASH = JSON.stringify({ hash: "0".repeat(64), salt: "00".repeat(16), iterations: 100_000 });
async function hashPassword(password: string) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100_000 }, material, 256);
  const salt = [...saltBytes].map(x => x.toString(16).padStart(2, "0")).join("");
  const hash = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({ hash, salt, iterations: 100_000 });
}
async function verifyPassword(password: string, value: string) {
  let stored: { hash: string; salt: string; iterations: number };
  try { stored = JSON.parse(value); } catch { stored = JSON.parse(DUMMY_PASSWORD_HASH); }
  if (!/^[a-f0-9]{64}$/.test(stored.hash) || !/^[a-f0-9]{32}$/.test(stored.salt) || stored.iterations !== 100_000) stored = JSON.parse(DUMMY_PASSWORD_HASH);
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(stored.salt.match(/../g)!, x => Number.parseInt(x, 16)), iterations: stored.iterations }, material, 256);
  const candidate = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  let diff = candidate.length ^ stored.hash.length;
  for (let i = 0; i < Math.min(candidate.length, stored.hash.length); i++) diff |= candidate.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0 && value !== DUMMY_PASSWORD_HASH;
}
async function enforceRateLimit(db: D1Database, key: string, max: number, windowMs: number) {
  const current = Date.now(); const start = current - windowMs;
  const bucket = `rl:${await digest(key)}`;
  if (current % 60_000 < 1_000) await db.prepare("DELETE FROM agentport_auth_rate_limits WHERE window_started_ms<?").bind(current - 24 * 60 * 60_000).run();
  const row = await db.prepare(`INSERT INTO agentport_auth_rate_limits(bucket_key,window_started_ms,attempts,updated_at) VALUES(?,?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET attempts=CASE WHEN window_started_ms<=? THEN 1 ELSE attempts+1 END,
    window_started_ms=CASE WHEN window_started_ms<=? THEN excluded.window_started_ms ELSE window_started_ms END,updated_at=excluded.updated_at
    RETURNING attempts`).bind(bucket, current, now(), start, start).first<{ attempts: number }>();
  return !!row && row.attempts <= max;
}
async function authBody(c: { req: { raw: Request } }) {
  try { const value: unknown = await c.req.raw.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
async function issueDeveloperToken(env: Env, user: { id: string; tenant_id: string; email: string; role: string; token_version: number }) {
  return signJwt({ sub: user.id, tid: user.tenant_id, email: user.email, role: user.role as "owner" | "admin", scopes: ["api:access"], tv: user.token_version }, env.AGENTPORT_JWT_SECRET, 3600);
}

async function authenticate(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<AuthContext | null> {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer (ap_live_[a-f0-9]{24})\.([a-f0-9]{64})$/.exec(header);
  if (!match) return null;
  const keyId = match[1]!; const secret = match[2]!;
  const keyHash = await digest(secret);
  const key = await c.env.PLATFORM_DB.prepare(`SELECT id,tenant_id,owner_type,owner_id,scopes_json,expires_at FROM agentport_api_keys
    WHERE id=? AND key_hash=? AND status='active' AND (expires_at IS NULL OR expires_at>?)`).bind(keyId, keyHash, now()).first<ApiKeyRow>();
  if (!key) return null;
  const scopes = JSON.parse(key.scopes_json) as string[];
  c.env.PLATFORM_DB.prepare("UPDATE agentport_api_keys SET last_used_at=? WHERE id=? AND status='active'").bind(now(), key.id).run().catch(() => {});
  return { key, tenantId: key.tenant_id, ownerId: key.owner_id, ownerType: key.owner_type, scopes };
}
function requiredScope(method: string, path: string): string {
  if (path === "/v1/keys" || path.startsWith("/v1/keys/") || path === "/v1/account") return "agentport:admin";
  if (path.includes("/events/") || path.endsWith("/events") || path.includes("/activity/")) return "agentport:events";
  return method === "GET" ? "agentport:read" : "agentport:write";
}
function hasScope(granted: string[], required: string) { return granted.includes("agentport:admin") || granted.includes(required); }

app.get("/health", c => c.json({ service: "AgentPort", status: "ok", api: "v1", mcp: "streamable-http" }));
app.get("/.well-known/agentport/agents/:agentId/jwks.json", async c => {
  const agent = await c.env.PLATFORM_DB.prepare("SELECT id,status FROM agentport_agents WHERE id=? AND status='active'").bind(c.req.param("agentId")).first<{ id: string; status: string }>();
  if (!agent) return c.json({ error_code: "agent_unavailable" }, 404);
  const rows = await c.env.PLATFORM_DB.prepare("SELECT public_jwk_json FROM agentport_identity_keys WHERE agent_id=? AND status='active'").bind(agent.id).all<{ public_jwk_json: string }>();
  return c.json({ keys: (rows.results ?? []).map(row => JSON.parse(row.public_jwk_json)) }, 200, { "cache-control": "public, max-age=60" });
});
app.get("/.well-known/agentport/credentials/:jti/status", async c => {
  const row = await c.env.PLATFORM_DB.prepare("SELECT expires_at,revoked_at FROM agentport_issued_credentials WHERE jti=?").bind(c.req.param("jti")).first<{ expires_at: string; revoked_at: string | null }>();
  if (!row) return c.json({ status: "unknown" }, 404, { "cache-control": "no-store" });
  const valid = !row.revoked_at && Date.parse(row.expires_at) > Date.now();
  return c.json({ status: valid ? "active" : row.revoked_at ? "revoked" : "expired" }, 200, { "cache-control": "no-store" });
});
app.get("/auth", c => c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentPort · Sign in</title><style>body{font:16px system-ui;margin:4rem auto;max-width:42rem;padding:0 1rem;color:#18212f}h1{font-size:2rem}form{display:grid;gap:.8rem;margin:2rem 0}label{display:grid;gap:.3rem}input,button{font:inherit;padding:.7rem;border:1px solid #9aa4b2;border-radius:.4rem}button{cursor:pointer;background:#172c4c;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f4f7;padding:1rem;border-radius:.5rem}#key{display:none}.muted{color:#566274}</style><main><h1>AgentPort</h1><p class="muted">Independent identity, account and event infrastructure for agents.</p><form id="auth"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="12" required></label><label>Organization name (registration only)<input name="org_name" autocomplete="organization"></label><div><button type="submit" value="login">Sign in</button> <button type="submit" value="register">Create account</button></div></form><p id="status" role="status"></p><section id="key"><h2>Create your first API key</h2><button id="create-key" type="button">Create API key</button><p class="muted">The key is shown once. Copy it into your runtime's secret manager.</p><pre id="key-output"></pre></section></main><script>let token="";const form=document.querySelector("#auth");form.addEventListener("submit",async e=>{e.preventDefault();const mode=e.submitter?.value||"login";const values=Object.fromEntries(new FormData(form));delete values.mode;const res=await fetch("/v1/auth/"+mode,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(values)});const data=await res.json();document.querySelector("#status").textContent=res.ok?"Signed in. Create an API key to connect your agent.":(data.message||data.error_code||"Sign-in failed");if(res.ok){token=data.data.token;document.querySelector("#key").style.display="block"}});document.querySelector("#create-key").addEventListener("click",async()=>{const res=await fetch("/v1/keys",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({scopes:["agentport:read","agentport:write","agentport:events"]})});const data=await res.json();document.querySelector("#key-output").textContent=res.ok?data.apiKey:(data.message||data.error_code||"Key creation failed")});</script></html>`));
app.route("/internal/agentport", agentPortRoutes);
app.route("/spaces/:spaceId/agentport", agentPortRoutes);

// Key enrollment is a platform control-plane operation, protected by the same tenant HMAC used by Naelao.
app.post("/internal/v1/keys", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const body = await c.req.json<{ ownerType?: string; ownerId?: string; scopes?: string[]; expiresAt?: string }>().catch(() => null);
  if (!body) return c.json({ error_code: "invalid_api_key" }, 400);
  const allowedScopes = new Set(["agentport:read", "agentport:write", "agentport:events", "agentport:admin"]);
  if (!body?.ownerId || body.ownerId.length > 200 || !["individual", "organization", "platform"].includes(String(body.ownerType)) || !Array.isArray(body.scopes) || body.scopes.length < 1 || body.scopes.length > 4 || body.scopes.some(s => !allowedScopes.has(s)) || (body.expiresAt && (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))) return c.json({ error_code: "invalid_api_key" }, 400);
  const secret = tokenSecret(); const keyId = `ap_live_${tokenId()}`; const key = `${keyId}.${secret}`;
  await c.env.PLATFORM_DB.prepare(`INSERT INTO agentport_api_keys(id,tenant_id,owner_type,owner_id,key_hash,key_prefix,scopes_json,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(keyId, tenantId, body.ownerType, body.ownerId, await digest(secret), `${keyId.slice(0, 18)}…`, JSON.stringify([...new Set(body.scopes)]), body.expiresAt ?? null, now()).run();
  return c.json({ apiKey: key, id: keyId, tenantId, ownerType: body.ownerType, ownerId: body.ownerId, scopes: [...new Set(body.scopes)], expiresAt: body.expiresAt ?? null }, 201);
});

app.post("/v1/auth/register", async c => {
  const body = await authBody(c);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const normalizedEmail = email.toLowerCase();
  const password = typeof body?.password === "string" ? body.password : "";
  const orgName = typeof body?.org_name === "string" && body.org_name.trim() ? body.org_name.trim() : email.split("@")[0] ?? "AgentPort organization";
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 8 || encoder.encode(password).byteLength > 1024 || orgName.length > 120) return c.json({ error_code: "invalid_registration", message: "Provide a valid email, an organization name under 120 characters, and a password between 8 bytes and 1 KiB." }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const allowedIp = await enforceRateLimit(c.env.PLATFORM_DB, `register:ip:${ip}`, 20, 60 * 60_000);
  const allowedEmail = await enforceRateLimit(c.env.PLATFORM_DB, `register:email:${normalizedEmail}`, 5, 60 * 60_000);
  if (!allowedIp || !allowedEmail) return c.json({ error_code: "rate_limited" }, 429);
  const existing = await c.env.PLATFORM_DB.prepare("SELECT id FROM agentport_developers WHERE email_normalized=?").bind(normalizedEmail).first();
  if (existing) return c.json({ error_code: "registration_unavailable", message: "This email cannot be registered." }, 409);
  const userId = crypto.randomUUID(); const tenantId = crypto.randomUUID(); const at = now();
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("INSERT INTO agentport_organizations(id,name,owner_developer_id,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").bind(tenantId, orgName, userId, at, at),
    c.env.PLATFORM_DB.prepare("INSERT INTO agentport_developers(id,tenant_id,email,email_normalized,password_hash,role,status,token_version,created_at,updated_at) VALUES(?,?,?,?,?,'owner','active',0,?,?)").bind(userId, tenantId, email, normalizedEmail, await hashPassword(password), at, at),
  ]);
  const token = await issueDeveloperToken(c.env, { id: userId, tenant_id: tenantId, email, role: "owner", token_version: 0 });
  return c.json({ data: { token, user: { id: userId, email, role: "owner" }, organization: { id: tenantId, name: orgName } } }, 201);
});
app.post("/v1/auth/login", async c => {
  const body = await authBody(c);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const normalizedEmail = email.toLowerCase();
  const password = typeof body?.password === "string" ? body.password : "";
  if (encoder.encode(password).byteLength > 1024) return c.json({ error_code: "invalid_credentials", message: "Invalid email or password." }, 401);
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const allowedIp = await enforceRateLimit(c.env.PLATFORM_DB, `login:ip:${ip}`, 20, 15 * 60_000);
  const allowedEmail = await enforceRateLimit(c.env.PLATFORM_DB, `login:email:${normalizedEmail}`, 10, 15 * 60_000);
  if (!allowedIp || !allowedEmail) return c.json({ error_code: "rate_limited" }, 429);
  const user = await c.env.PLATFORM_DB.prepare(`SELECT d.id,d.tenant_id,d.email,d.password_hash,d.role,d.status,d.token_version,o.status AS organization_status
    FROM agentport_developers d JOIN agentport_organizations o ON o.id=d.tenant_id WHERE d.email_normalized=?`).bind(normalizedEmail).first<{ id: string; tenant_id: string; email: string; password_hash: string; role: string; status: string; token_version: number; organization_status: string }>();
  const passwordOk = await verifyPassword(password || "invalid", user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.status !== "active" || user.organization_status !== "active" || !passwordOk) return c.json({ error_code: "invalid_credentials", message: "Invalid email or password." }, 401);
  await c.env.PLATFORM_DB.prepare("UPDATE agentport_developers SET last_login_at=?,updated_at=? WHERE id=?").bind(now(), now(), user.id).run();
  const token = await issueDeveloperToken(c.env, user);
  return c.json({ data: { token, user: { id: user.id, email: user.email, role: user.role }, organization: { id: user.tenant_id } } });
});
app.post("/v1/auth/password", async c => {
  const auth = await authenticateHuman(c);
  if (!auth?.userClaims) return c.json({ error_code: "unauthorized" }, 401);
  const body = await authBody(c);
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 8 || encoder.encode(password).byteLength > 1024) return c.json({ error_code: "invalid_password" }, 400);
  const at = now();
  const changed = await c.env.PLATFORM_DB.prepare("UPDATE agentport_developers SET password_hash=?,token_version=token_version+1,updated_at=? WHERE id=? AND tenant_id=? AND status='active'")
    .bind(await hashPassword(password), at, auth.userClaims.sub, auth.userClaims.tid).run();
  if (!changed.meta.changes) return c.json({ error_code: "account_unavailable" }, 404);
  const user = await c.env.PLATFORM_DB.prepare("SELECT id,tenant_id,email,role,token_version FROM agentport_developers WHERE id=? AND tenant_id=?").bind(auth.userClaims.sub, auth.userClaims.tid).first<{ id: string; tenant_id: string; email: string; role: string; token_version: number }>();
  if (!user) return c.json({ error_code: "account_unavailable" }, 404);
  return c.json({ changed: true, token: await issueDeveloperToken(c.env, user) });
});

async function authenticateHuman(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<AuthContext | null> {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  try {
    const claims = await verifyJwt(match[1]!, c.env.AGENTPORT_JWT_SECRET);
    if (!["owner", "admin"].includes(claims.role) || !claims.scopes.includes("api:access")) return null;
    const current = await c.env.PLATFORM_DB.prepare(`SELECT d.status,d.tenant_id,d.token_version,d.role,o.status AS organization_status FROM agentport_developers d
      JOIN agentport_organizations o ON o.id=d.tenant_id WHERE d.id=? AND d.tenant_id=?`).bind(claims.sub, claims.tid).first<{ status: string; tenant_id: string; token_version: number; role: string; organization_status: string }>();
    if (!current || current.status !== "active" || current.organization_status !== "active" || (claims.tv ?? 0) !== (current.token_version ?? 0) || !["owner", "admin"].includes(current.role)) return null;
    return { tenantId: claims.tid, ownerId: claims.tid, ownerType: "organization", scopes: ["agentport:read", "agentport:write", "agentport:events", "agentport:admin"], userClaims: claims };
  } catch { return null; }
}

async function ownsAgent(db: D1Database, auth: AuthContext, agentId: string) {
  return !!await db.prepare(`SELECT a.id FROM agentport_agents a JOIN agentport_principals p
    ON p.id=a.principal_id AND p.tenant_id=a.tenant_id
    WHERE a.id=? AND a.tenant_id=? AND a.status='active' AND p.external_id=? AND p.principal_type=?`)
    .bind(agentId, auth.tenantId, auth.ownerId, auth.ownerType).first();
}

app.use("/v1/*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const auth = await authenticate(c);
  const human = !auth && pathname === "/v1/keys" && c.req.method === "POST" ? await authenticateHuman(c) : null;
  const selected = auth ?? human;
  if (!selected) return c.json({ error_code: "unauthorized", message: "Use an AgentPort API key or an authenticated organization owner/admin token." }, 401);
  if (human && pathname !== "/v1/keys") return c.json({ error_code: "unauthorized" }, 401);
  const scope = requiredScope(c.req.method, pathname);
  if (!hasScope(selected.scopes, scope)) return c.json({ error_code: "insufficient_scope", required: scope }, 403);
  c.set("auth", selected);
  return next();
});

app.post("/v1/keys", async c => {
  const auth = c.get("auth");
  const body = await c.req.json<{ scopes?: string[]; expiresAt?: string }>().catch(() => null);
  if (!body) return c.json({ error_code: "invalid_api_key" }, 400);
  const scopes = [...new Set(body.scopes ?? [])];
  if (!scopes.length || scopes.length > 4 || scopes.some(s => !auth.scopes.includes(s) && !auth.scopes.includes("agentport:admin")) || (body?.expiresAt && (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()))) return c.json({ error_code: "invalid_api_key" }, 400);
  const secret = tokenSecret(); const keyId = `ap_live_${tokenId()}`; const key = `${keyId}.${secret}`;
  await c.env.PLATFORM_DB.prepare(`INSERT INTO agentport_api_keys(id,tenant_id,owner_type,owner_id,key_hash,key_prefix,scopes_json,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(keyId, auth.tenantId, auth.ownerType, auth.ownerId, await digest(secret), `${keyId.slice(0, 18)}…`, JSON.stringify(scopes), body.expiresAt ?? null, now()).run();
  return c.json({ apiKey: key, id: keyId, scopes, expiresAt: body.expiresAt ?? null }, 201);
});
app.get("/v1/keys", async c => {
  const auth = c.get("auth");
  const rows = await c.env.PLATFORM_DB.prepare("SELECT id,key_prefix,scopes_json,status,expires_at,last_used_at,created_at FROM agentport_api_keys WHERE tenant_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 100").bind(auth.tenantId, auth.ownerId).all();
  return c.json({ keys: (rows.results ?? []).map(row => ({ ...row, scopes: JSON.parse(String(row.scopes_json)), scopes_json: undefined })) });
});
app.delete("/v1/keys/:keyId", async c => {
  const auth = c.get("auth");
  const result = await c.env.PLATFORM_DB.prepare("UPDATE agentport_api_keys SET status='revoked',revoked_at=? WHERE id=? AND tenant_id=? AND owner_id=? AND status='active'").bind(now(), c.req.param("keyId"), auth.tenantId, auth.ownerId).run();
  return c.json({ revoked: result.meta.changes > 0 });
});
app.delete("/v1/account", async c => {
  const auth = c.get("auth"); const tenantId = auth.tenantId;
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_activity_leases WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_event_deliveries WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_account_dependencies WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_account_grants WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_event_subscriptions WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_events WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_action_receipts WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_messages WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_threads WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_trusted_senders WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_channels WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_issued_credentials WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_identity_keys WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_accounts WHERE tenant_id=? AND parent_account_id IS NOT NULL").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_accounts WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_agents WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_principals WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_service_manifests WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_provider_auth WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_services WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_api_keys WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_developers WHERE tenant_id=?").bind(tenantId),
    c.env.PLATFORM_DB.prepare("DELETE FROM agentport_organizations WHERE id=?").bind(tenantId),
  ]);
  return c.json({ deleted: true });
});

async function forward(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>, path: string) {
  const auth = c.get("auth");
  const incoming = new URL(c.req.url);
  if (c.req.method === "GET" && path === "/agents") {
    incoming.searchParams.set("principalId", auth.ownerId);
    incoming.searchParams.set("principalType", auth.ownerType);
  }
  if (c.req.method === "GET" && path === "/accounts") {
    incoming.searchParams.set("ownerId", auth.ownerId);
    incoming.searchParams.set("ownerType", auth.ownerType);
  }
  if (c.req.method === "GET" && path === "/events/pending") {
    const agentId = incoming.searchParams.get("agentId");
    if (!agentId || !await ownsAgent(c.env.PLATFORM_DB, auth, agentId)) return json({ error_code: "agent_unavailable" }, 404);
  }
  // `agentPortRoutes` is invoked directly below, so address its route table at `/services`,
  // `/agents`, etc. The `/internal/agentport` prefix is only used when mounted in a Worker.
  const destination = new URL(`${path}${incoming.search}`, "https://agentport.internal");
  const headers = new Headers(c.req.raw.headers);
  headers.delete("authorization");
  headers.set("x-naelao-tenant-id", auth.tenantId);
  headers.set("x-naelao-internal-token", await mintInternalToken(c.env.PLATFORM_SECRET, auth.tenantId));
  headers.set("x-naelao-role", "agentport_api");
  headers.set("x-agentport-owner-id", auth.ownerId);
  headers.set("x-agentport-owner-type", auth.ownerType);
  headers.set("x-agentport-scopes", auth.scopes.join(" "));
  let body: ArrayBuffer | undefined;
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (c.req.method === "POST" && path === "/agents") {
      const input = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!input || typeof input.hostPlatform !== "string") return json({ error_code: "invalid_agent" }, 400);
      input.principalType = auth.ownerType;
      input.principalId = auth.ownerId;
      input.createdBy = auth.ownerId;
      input.hostPlatform = input.hostPlatform.slice(0, 120);
      delete input.hostSpaceId;
      body = encoder.encode(JSON.stringify(input)).buffer;
    } else if (c.req.method === "POST" && /\/accounts\/[^/]+\/grants$/.test(path)) {
      const input = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!input || typeof input.agentId !== "string" || !await ownsAgent(c.env.PLATFORM_DB, auth, input.agentId)) return json({ error_code: "agent_unavailable" }, 404);
      input.grantedBy = auth.ownerId;
      body = encoder.encode(JSON.stringify(input)).buffer;
    } else if (c.req.method === "POST" && path === "/accounts") {
      const input = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!input || !["individual", "organization", "agentport", "provider"].includes(String(input.ownerType))) return json({ error_code: "invalid_account" }, 400);
      if (["individual", "organization"].includes(String(input.ownerType)) && (input.ownerId !== auth.ownerId || input.ownerType !== auth.ownerType)) return json({ error_code: "account_owner_mismatch" }, 403);
      if (input.ownerType === "agentport") input.ownerId = auth.tenantId;
      body = encoder.encode(JSON.stringify(input)).buffer;
    } else if (c.req.method === "POST" && path === "/events/subscriptions") {
      const input = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!input || typeof input.agentId !== "string" || !await ownsAgent(c.env.PLATFORM_DB, auth, input.agentId)) return json({ error_code: "agent_unavailable" }, 404);
      body = encoder.encode(JSON.stringify(input)).buffer;
    } else if (c.req.method === "POST" && /\/events\/[^/]+\/(claim|ack)$/.test(path)) {
      const input = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!input || typeof input.agentId !== "string" || !await ownsAgent(c.env.PLATFORM_DB, auth, input.agentId)) return json({ error_code: "agent_unavailable" }, 404);
      body = encoder.encode(JSON.stringify(input)).buffer;
    } else if (c.req.method === "POST" && (path === "/activity/leases" || /\/activity\/leases\/[^/]+\/renew$/.test(path))) {
      const input = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!input || typeof input.agentId !== "string" || !await ownsAgent(c.env.PLATFORM_DB, auth, input.agentId)) return json({ error_code: "agent_unavailable" }, 404);
      body = encoder.encode(JSON.stringify(input)).buffer;
    } else {
      body = await c.req.raw.arrayBuffer();
    }
  }
  return agentPortRoutes.fetch(new Request(destination, { method: c.req.method, headers, ...(body === undefined ? {} : { body }) }), c.env);
}
app.all("/v1/*", c => forward(c, new URL(c.req.url).pathname.replace(/^\/v1/, "")));

// MCP Streamable HTTP endpoint. It uses the same bearer key and REST methods; subscriptions
// remain durable in AgentPort's inbox and do not rely on the lifetime of this HTTP connection.
app.post("/mcp", async c => {
  const auth = await authenticate(c);
  if (!auth) return c.json({ error_code: "unauthorized" }, 401);
  const request = await c.req.json<{ jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }>().catch(() => null);
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return c.json({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } }, 400);
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return new Response(null, { status: 202 });
  if (request.method === "initialize") {
    const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion = requested === "2025-11-25" ? requested : "2026-07-28";
    return c.json({ jsonrpc: "2.0", id: request.id ?? null, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "AgentPort", version: "1.0.0" } } });
  }
  if (request.method === "ping") return c.json({ jsonrpc: "2.0", id: request.id ?? null, result: {} });
  if (request.method === "tools/list") return c.json({ jsonrpc: "2.0", id: request.id ?? null, result: { tools: [
    { name: "agentport_search", description: "Discover registered providers and capabilities without loading their full schemas.", inputSchema: { type: "object", properties: { capability: { type: "string" }, type: { type: "string", enum: ["api", "mcp", "a2a", "channel", "managed"] }, accountModel: { type: "string", enum: ["agent_native", "user_parent", "agentport_parent", "delegated"] } } } },
    { name: "agentport_inspect", description: "Inspect one provider's declared provisioning modes, account models, events, billing metadata and capability schemas.", inputSchema: { type: "object", properties: { serviceId: { type: "string" } }, required: ["serviceId"] } },
    { name: "agentport_services_list", description: "List registered services and their declared account models and events.", inputSchema: { type: "object", properties: {} } },
    { name: "agentport_services_register", description: "Publish an existing API, MCP, A2A, channel, or managed service manifest. Providers cannot self-approve partnership status; provisioning metadata does not execute provider actions.", inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string", enum: ["api", "mcp", "a2a", "channel", "managed"] }, endpoint: { type: "string" }, accountModels: { type: "array", items: { type: "string" } }, capabilities: { type: "array", items: { type: "string" } }, events: { type: "array", items: { type: "string" } }, connectionPurpose: { type: "string", enum: ["user_delegation", "agent_resource", "parent_provisioning"] }, partnershipStatus: { type: "string", enum: ["unaffiliated", "restricted", "unavailable"] }, auth: { type: "object" }, provisioning: { type: "object" }, billing: { type: "object" } }, required: ["id", "name", "type", "accountModels", "capabilities", "events", "connectionPurpose"] } },
    { name: "agentport_agents_register", description: "Register a persistent agent identity under the API key owner.", inputSchema: { type: "object", properties: { hostPlatform: { type: "string" }, runtime: { type: "string" } }, required: ["hostPlatform"] } },
    { name: "agentport_accounts_create", description: "Register a provider resource after the provider has provisioned it using an authorized API, MCP server or other supported interface.", inputSchema: { type: "object", properties: { serviceId: { type: "string" }, accountModel: { type: "string", enum: ["agent_native", "user_parent", "agentport_parent", "delegated"] }, ownerType: { type: "string", enum: ["individual", "organization", "agentport", "provider"] }, ownerId: { type: "string" }, parentAccountId: { type: "string" }, externalAccountId: { type: "string" }, credentialRef: { type: "string" } }, required: ["serviceId", "accountModel", "ownerType", "ownerId"] } },
    { name: "agentport_accounts_grant", description: "Grant an agent scoped access to a registered account.", inputSchema: { type: "object", properties: { accountId: { type: "string" }, agentId: { type: "string" }, permissions: { type: "array", items: { type: "string" } }, expiresAt: { type: "string" } }, required: ["accountId", "agentId", "permissions"] } },
    { name: "agentport_channels_list", description: "List channel accounts available to an agent.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
    { name: "agentport_channels_register", description: "Register an existing provider channel under an active AgentPort account.", inputSchema: { type: "object", properties: { serviceId: { type: "string" }, accountId: { type: "string" }, agentId: { type: "string" }, providerChannelId: { type: "string" }, displayName: { type: "string" }, trustPolicy: { type: "object" } }, required: ["serviceId", "accountId", "agentId", "providerChannelId", "displayName"] } },
    { name: "agentport_threads_list", description: "List channel threads without binding them to a runtime session.", inputSchema: { type: "object", properties: { channelId: { type: "string" }, agentId: { type: "string" } }, required: ["channelId", "agentId"] } },
    { name: "agentport_threads_create", description: "Create a provider-thread record; an optional runtime session binding is opaque to AgentPort.", inputSchema: { type: "object", properties: { channelId: { type: "string" }, providerThreadId: { type: "string" }, participants: { type: "array", items: { type: "string" } }, sessionBinding: { type: "object" } }, required: ["channelId", "providerThreadId"] } },
    { name: "agentport_messages_list", description: "Read messages from a thread when the agent has messages.read permission.", inputSchema: { type: "object", properties: { threadId: { type: "string" }, agentId: { type: "string" } }, required: ["threadId", "agentId"] } },
    { name: "agentport_messages_send", description: "Queue an outbound message under the agent's messages.send grant. It is not reported as delivered until a provider adapter acknowledges it.", inputSchema: { type: "object", properties: { threadId: { type: "string" }, agentId: { type: "string" }, content: { type: "string" }, idempotencyKey: { type: "string" } }, required: ["threadId", "agentId", "content", "idempotencyKey"] } },
    { name: "agentport_events_subscribe", description: "Subscribe an agent to a provider-declared event. This stores delivery intent; a runtime must still poll or receive a configured webhook.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, serviceId: { type: "string" }, accountId: { type: "string" }, eventType: { type: "string" }, deliveryMode: { type: "string", enum: ["webhook", "poll", "naelao", "mcp"] }, consumerGroup: { type: "string" } }, required: ["agentId", "serviceId", "eventType", "deliveryMode"] } },
    { name: "agentport_events_pending", description: "Read pending event notifications for an agent.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
    { name: "agentport_events_claim", description: "Claim a pending delivery with an expiring lease for one consumer.", inputSchema: { type: "object", properties: { eventId: { type: "string" }, agentId: { type: "string" }, consumerId: { type: "string" }, ttlSeconds: { type: "integer" } }, required: ["eventId", "agentId", "consumerId"] } },
    { name: "agentport_events_ack", description: "Acknowledge, retry, or dead-letter an event delivery claimed by this consumer.", inputSchema: { type: "object", properties: { eventId: { type: "string" }, agentId: { type: "string" }, consumerId: { type: "string" }, result: { type: "string", enum: ["delivered", "retry", "dead_letter"] } }, required: ["eventId", "agentId", "consumerId", "result"] } },
    { name: "agentport_activity_acquire", description: "Acquire or renew an expiring lease showing this consumer is handling a subscription. It does not lock the account.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, subscriptionId: { type: "string" }, consumerId: { type: "string" }, ttlSeconds: { type: "integer" } }, required: ["agentId", "subscriptionId", "consumerId"] } },
  ] } });
  if (request.method !== "tools/call") return c.json({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Method not found" } }, 404);
  const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
  const args = params?.arguments ?? {}; let path = ""; let method = "GET";
  switch (params?.name) {
    case "agentport_search": path = `/services?${new URLSearchParams(Object.entries(args).filter((entry): entry is [string, string] => typeof entry[1] === "string"))}`; break;
    case "agentport_inspect": path = `/services/${encodeURIComponent(String(args.serviceId ?? ""))}`; break;
    case "agentport_services_list": path = "/services"; break;
    case "agentport_services_register": method = "POST"; path = "/services"; break;
    case "agentport_agents_register": method = "POST"; path = "/agents"; args.hostPlatform = args.hostPlatform ?? "external"; break;
    case "agentport_accounts_create": method = "POST"; path = "/accounts"; break;
    case "agentport_accounts_grant": method = "POST"; path = `/accounts/${encodeURIComponent(String(args.accountId ?? ""))}/grants`; delete args.accountId; break;
    case "agentport_channels_list": path = `/channels?agentId=${encodeURIComponent(String(args.agentId ?? ""))}`; break;
    case "agentport_channels_register": method = "POST"; path = "/channels"; break;
    case "agentport_threads_list": path = `/channels/${encodeURIComponent(String(args.channelId ?? ""))}/threads?agentId=${encodeURIComponent(String(args.agentId ?? ""))}`; break;
    case "agentport_threads_create": method = "POST"; path = `/channels/${encodeURIComponent(String(args.channelId ?? ""))}/threads`; delete args.channelId; break;
    case "agentport_messages_list": path = `/threads/${encodeURIComponent(String(args.threadId ?? ""))}/messages?agentId=${encodeURIComponent(String(args.agentId ?? ""))}`; break;
    case "agentport_messages_send": method = "POST"; path = `/threads/${encodeURIComponent(String(args.threadId ?? ""))}/messages`; delete args.threadId; break;
    case "agentport_events_subscribe": method = "POST"; path = "/events/subscriptions"; break;
    case "agentport_events_pending": path = `/events/pending?agentId=${encodeURIComponent(String(args.agentId ?? ""))}`; break;
    case "agentport_events_claim": method = "POST"; path = `/events/${encodeURIComponent(String(args.eventId ?? ""))}/claim`; delete args.eventId; break;
    case "agentport_events_ack": method = "POST"; path = `/events/${encodeURIComponent(String(args.eventId ?? ""))}/ack`; delete args.eventId; break;
    case "agentport_activity_acquire": method = "POST"; path = "/activity/leases"; break;
    default: return c.json({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "Unknown AgentPort tool" } }, 400);
  }
  const required = requiredScope(method, `/v1${path.split("?")[0]}`);
  if (!hasScope(auth.scopes, required)) return c.json({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32003, message: `Missing scope ${required}` } }, 403);
  const url = new URL(`/v1${path}`, c.req.url);
  const headers = new Headers({ authorization: c.req.header("authorization") ?? "" });
  if (method !== "GET") headers.set("content-type", "application/json");
  const result = await app.fetch(new Request(url, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(args) }) }), c.env);
  const text = await result.text();
  return c.json({ jsonrpc: "2.0", id: request.id ?? null, result: { content: [{ type: "text", text }], isError: !result.ok } });
});
app.get("/mcp", c => c.json({ error_code: "method_not_allowed", message: "MCP Streamable HTTP uses POST requests." }, 405));

app.notFound(c => c.json({ error_code: "not_found" }, 404));
export default app;
