import { Hono, type Context } from "hono";
import { verifyInternalToken } from "@naelao/http";
import { accountModelRequiresParent, inspectDependencyGraph, leaseExpiry, validateServiceRegistration, type AccountModel, type AccountDependency, type DependencyType } from "./core.js";
import { createSealedAgentKey, signAgentCredential } from "./identity.js";

interface AgentPortEnv { PLATFORM_DB: D1Database; PLATFORM_SECRET: string; AGENTPORT_JWT_SECRET?: string; AGENTPORT_ISSUER?: string; }
const routes = new Hono<{ Bindings: AgentPortEnv; Variables: { tenantId: string } }>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stamp = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

routes.use("*", async (c, next) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))) return c.json({ error_code: "forbidden" }, 403);
  const spaceId = c.req.param("spaceId") ?? /^\/spaces\/([^/]+)\/agentport(?:\/|$)/.exec(new URL(c.req.url).pathname)?.[1];
  const actorId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "";
  if (spaceId) {
    const activeSpace = await c.env.PLATFORM_DB.prepare(`SELECT s.created_by FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first<{ created_by: string }>();
    if (!activeSpace) return c.json({ error_code: "space_unavailable" }, 404);
    if (role === "agent") {
      const agent = await c.env.PLATFORM_DB.prepare("SELECT id FROM agentport_agents WHERE id=? AND tenant_id=? AND host_space_id=? AND status='active'").bind(actorId, tenantId, spaceId).first();
      const path = new URL(c.req.url).pathname;
      const agentOperation = c.req.method === "GET" && (path.endsWith("/events/pending") || path.endsWith("/services")) ||
        c.req.method === "POST" && (/\/events\/[^/]+\/(claim|ack)$/.test(path) || /\/activity\/leases(?:\/[^/]+\/renew)?$/.test(path) || /\/events\/subscriptions$/.test(path)) ||
        c.req.method === "DELETE" && /\/activity\/leases\/[^/]+$/.test(path);
      if (!agent || !agentOperation) return c.json({ error_code: "forbidden" }, 403);
    } else if (actorId !== activeSpace.created_by) {
      if (role === "product_end_user") {
        const membership = await c.env.PLATFORM_DB.prepare("SELECT role FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL")
          .bind(spaceId, tenantId, actorId).first<{ role: string }>();
        if (!membership || !["admin", "owner", "moderator"].includes(membership.role)) return c.json({ error_code: "space_admin_required" }, 403);
      } else if (!["owner", "admin", "editor"].includes(role)) {
        return c.json({ error_code: "space_membership_required" }, 403);
      }
    }
  }
  c.set("tenantId", tenantId);
  return next();
});

routes.post("/services", async (c) => {
  const service = validateServiceRegistration(await c.req.json().catch(() => null));
  if (!service) return c.json({ error_code: "invalid_service_manifest" }, 400);
  const db = c.env.PLATFORM_DB;
  const tenantId = c.get("tenantId");
  const at = stamp();
  try {
    await db.prepare(`INSERT INTO agentport_services
      (id,tenant_id,name,service_type,endpoint,account_models_json,capabilities_json,events_json,connection_purpose,partnership_status,billing_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(service.id, tenantId, service.name, service.type, service.endpoint ?? null,
      JSON.stringify(service.accountModels), JSON.stringify(service.capabilities), JSON.stringify(service.events), service.connectionPurpose,
      service.partnershipStatus, JSON.stringify(service.billing ?? {}), at, at).run();
    await db.prepare("INSERT INTO agentport_provider_auth(tenant_id,service_id,auth_json,updated_at) VALUES(?,?,?,?)")
      .bind(tenantId, service.id, JSON.stringify(service.auth ?? {}), at).run();
    await db.prepare(`INSERT INTO agentport_service_manifests(tenant_id,service_id,provisioning_json,capability_schemas_json,updated_at) VALUES(?,?,?,?,?)`)
      .bind(tenantId, service.id, JSON.stringify(service.provisioning ?? {}), JSON.stringify(service.capabilitySchemas ?? {}), at).run();
  } catch { return c.json({ error_code: "service_registration_conflict" }, 409); }
  return c.json({ service }, 201);
});

routes.get("/services", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT s.id,s.name,s.service_type,s.endpoint,s.account_models_json,s.capabilities_json,s.events_json,s.connection_purpose,s.partnership_status,s.auth_json,s.billing_json,
    a.auth_json,m.provisioning_json,m.capability_schemas_json FROM agentport_services s LEFT JOIN agentport_provider_auth a ON a.service_id=s.id AND a.tenant_id=s.tenant_id LEFT JOIN agentport_service_manifests m ON m.service_id=s.id AND m.tenant_id=s.tenant_id WHERE s.tenant_id=? AND s.status='active' ORDER BY s.name LIMIT 200`).bind(c.get("tenantId")).all();
  const type = c.req.query("type"); const capability = c.req.query("capability"); const accountModel = c.req.query("accountModel");
  const services: Array<Record<string, unknown>> = (rows.results ?? []).map((row) => ({ ...row, account_models: JSON.parse(String(row.account_models_json)), capabilities: JSON.parse(String(row.capabilities_json)), events: JSON.parse(String(row.events_json)), auth: JSON.parse(String(row.auth_json ?? "{}")), provisioning: JSON.parse(String(row.provisioning_json ?? "{}")), capability_schemas: JSON.parse(String(row.capability_schemas_json ?? "{}")), billing: JSON.parse(String(row.billing_json ?? "{}")) }));
  const filtered = services
    .filter(service => (!type || String(service.service_type) === type) && (!capability || (service.capabilities as string[]).includes(capability)) && (!accountModel || (service.account_models as string[]).includes(accountModel)));
  return c.json({ services: filtered });
});

routes.get("/services/:serviceId", async (c) => {
  const result = await c.env.PLATFORM_DB.prepare(`SELECT s.id,s.name,s.service_type,s.endpoint,s.account_models_json,s.capabilities_json,s.events_json,s.connection_purpose,s.partnership_status,a.auth_json,s.billing_json,s.status,
    m.provisioning_json,m.capability_schemas_json FROM agentport_services s LEFT JOIN agentport_provider_auth a ON a.service_id=s.id AND a.tenant_id=s.tenant_id LEFT JOIN agentport_service_manifests m ON m.service_id=s.id AND m.tenant_id=s.tenant_id WHERE s.tenant_id=? AND s.id=?`)
    .bind(c.get("tenantId"), c.req.param("serviceId")).first<Record<string, unknown>>();
  if (!result) return c.json({ error_code: "service_unavailable" }, 404);
  return c.json({ service: { ...result, account_models: JSON.parse(String(result.account_models_json)), capabilities: JSON.parse(String(result.capabilities_json)), events: JSON.parse(String(result.events_json)), auth: JSON.parse(String(result.auth_json ?? "{}")), provisioning: JSON.parse(String(result.provisioning_json ?? "{}")), capability_schemas: JSON.parse(String(result.capability_schemas_json ?? "{}")), billing: JSON.parse(String(result.billing_json ?? "{}")) } });
});

routes.get("/agents", async (c) => {
  const tenantId = c.get("tenantId");
  const principalId = c.req.query("principalId");
  const principalType = c.req.query("principalType");
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT a.id,a.principal_id,a.created_by,a.host_platform,a.host_space_id,a.runtime,a.status,a.created_at,p.principal_type,p.verification_level
    FROM agentport_agents a JOIN agentport_principals p ON p.id=a.principal_id AND p.tenant_id=a.tenant_id
    WHERE a.tenant_id=? AND (? IS NULL OR (p.external_id=? AND p.principal_type=?)) ORDER BY a.created_at DESC LIMIT 200`)
    .bind(tenantId, c.req.header("x-naelao-role") === "agentport_api" ? principalId : null, principalId, principalType).all();
  return c.json({ agents: rows.results ?? [] });
});

routes.post("/agents", async (c) => {
  const body = await c.req.json<{ id?: string; principalId?: string; principalType?: "individual" | "organization" | "platform"; createdBy?: string; hostPlatform?: string; hostSpaceId?: string; runtime?: string; publicKeySet?: string }>().catch(() => null);
  if (!body?.principalId || !body.createdBy || !body.hostPlatform || body.hostPlatform.length > 120 || !["individual", "organization", "platform"].includes(String(body.principalType))) return c.json({ error_code: "invalid_agent" }, 400);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB; const at = stamp();
  const principalId = body.principalId;
  await db.prepare(`INSERT OR IGNORE INTO agentport_principals (id,tenant_id,principal_type,external_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(id("prn"), tenantId, body.principalType, principalId, at, at).run();
  const principal = await db.prepare("SELECT id FROM agentport_principals WHERE tenant_id=? AND principal_type=? AND external_id=?").bind(tenantId, body.principalType, principalId).first<{ id: string }>();
  if (!principal) return c.json({ error_code: "principal_registry_unavailable" }, 503);
  const agentId = body.id || id("agt");
  try {
    await db.prepare(`INSERT INTO agentport_agents (id,tenant_id,principal_id,created_by,host_platform,host_space_id,runtime,public_key_set,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(agentId, tenantId, principal.id, body.createdBy, body.hostPlatform, body.hostSpaceId ?? null, body.runtime ?? null, body.publicKeySet ?? null, at, at).run();
  } catch { return c.json({ error_code: "agent_registration_conflict" }, 409); }
  let identity: { kid: string; publicJwk: string } | undefined;
  if (c.env.AGENTPORT_JWT_SECRET) {
    try {
      const issuer = c.env.AGENTPORT_ISSUER ?? "https://agentport.naelao.com";
      const existingKey = await db.prepare("SELECT id,public_jwk_json FROM agentport_identity_keys WHERE tenant_id=? AND agent_id=? AND status='active' LIMIT 1").bind(tenantId, agentId).first<{ id: string; public_jwk_json: string }>();
      if (existingKey) identity = { kid: existingKey.id, publicJwk: existingKey.public_jwk_json };
      else {
        const key = await createSealedAgentKey(c.env.AGENTPORT_JWT_SECRET, agentId, issuer);
        await db.prepare(`INSERT INTO agentport_identity_keys(id,tenant_id,agent_id,public_jwk_json,private_key_ciphertext,private_key_iv,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
          .bind(key.id, tenantId, agentId, key.publicJwk, key.ciphertext, key.iv, at, at).run();
        identity = { kid: key.id, publicJwk: key.publicJwk };
      }
    } catch {
      await db.prepare("UPDATE agentport_agents SET status='suspended',updated_at=? WHERE id=? AND tenant_id=?").bind(stamp(), agentId, tenantId).run();
      return c.json({ error_code: "agent_identity_key_unavailable" }, 503);
    }
  }
  return c.json({ agent: { id: agentId, principalId: principal.id, hostPlatform: body.hostPlatform, status: "active", ...(identity ? { identity: { kid: identity.kid, publicJwk: JSON.parse(identity.publicJwk) } } : {}) } }, 201);
});

routes.get("/agents/:agentId/identity", async c => {
  const tenantId = c.get("tenantId"); const agentId = c.req.param("agentId");
  const row = await c.env.PLATFORM_DB.prepare(`SELECT a.id,a.status,a.host_platform,a.host_space_id,a.created_at,p.principal_type,p.verification_level,k.id AS kid,k.public_jwk_json
    FROM agentport_agents a JOIN agentport_principals p ON p.id=a.principal_id AND p.tenant_id=a.tenant_id
    LEFT JOIN agentport_identity_keys k ON k.agent_id=a.id AND k.tenant_id=a.tenant_id AND k.status='active'
    WHERE a.id=? AND a.tenant_id=?`).bind(agentId, tenantId).first<Record<string, unknown>>();
  if (!row) return c.json({ error_code: "agent_unavailable" }, 404);
  return c.json({ identity: { id: row.id, status: row.status, host: { platform: row.host_platform, spaceId: row.host_space_id }, principal: { type: row.principal_type, verificationLevel: row.verification_level }, createdAt: row.created_at, publicKey: row.public_jwk_json ? JSON.parse(String(row.public_jwk_json)) : null } });
});

routes.post("/agents/:agentId/credentials", async c => {
  const body = await c.req.json<{ audience?: string; actions?: string[]; ttlSeconds?: number }>().catch(() => null);
  if (!body?.audience || body.audience.length > 512 || !body.actions?.length || body.actions.length > 100 || body.actions.some(action => typeof action !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(action))) return c.json({ error_code: "invalid_mandate" }, 400);
  let audience: URL;
  try { audience = new URL(body.audience); } catch { return c.json({ error_code: "invalid_audience" }, 400); }
  if (audience.protocol !== "https:" || audience.username || audience.password || audience.hash) return c.json({ error_code: "invalid_audience" }, 400);
  const tenantId = c.get("tenantId"); const agentId = c.req.param("agentId"); const db = c.env.PLATFORM_DB;
  const role = c.req.header("x-naelao-role");
  const ownerId = c.req.header("x-agentport-owner-id") ?? c.req.header("x-naelao-user-id") ?? "";
  const ownerType = c.req.header("x-agentport-owner-type") ?? "";
  const agent = await db.prepare(`SELECT a.id,a.status,a.host_platform,a.host_space_id,p.external_id,p.principal_type,p.verification_level
    FROM agentport_agents a JOIN agentport_principals p ON p.id=a.principal_id AND p.tenant_id=a.tenant_id WHERE a.id=? AND a.tenant_id=?`)
    .bind(agentId, tenantId).first<{ id: string; status: string; host_platform: string; host_space_id: string | null; external_id: string; principal_type: string; verification_level: string }>();
  if (!agent || agent.status !== "active") return c.json({ error_code: "agent_unavailable" }, 404);
  if (role === "agentport_api" && (agent.external_id !== ownerId || agent.principal_type !== ownerType)) return c.json({ error_code: "agent_unavailable" }, 404);
  if (role === "agent") return c.json({ error_code: "owner_authorization_required" }, 403);
  const key = await db.prepare("SELECT id,private_key_ciphertext,private_key_iv FROM agentport_identity_keys WHERE tenant_id=? AND agent_id=? AND status='active' LIMIT 1")
    .bind(tenantId, agentId).first<{ id: string; private_key_ciphertext: string; private_key_iv: string }>();
  if (!key || !c.env.AGENTPORT_JWT_SECRET) return c.json({ error_code: "identity_key_unavailable" }, 503);
  const ttlSeconds = Math.max(60, Math.min(900, Math.floor(body.ttlSeconds ?? 300)));
  const credential = await signAgentCredential({
    secret: c.env.AGENTPORT_JWT_SECRET, agentId, kid: key.id, ciphertext: key.private_key_ciphertext, iv: key.private_key_iv,
    issuer: c.env.AGENTPORT_ISSUER ?? "https://agentport.naelao.com", audience: audience.origin,
    principal: { id: agent.external_id, type: agent.principal_type, verificationLevel: agent.verification_level },
    host: { platform: agent.host_platform, spaceId: agent.host_space_id }, actions: [...new Set(body.actions)], ttlSeconds,
  });
  await db.prepare("INSERT INTO agentport_issued_credentials(jti,tenant_id,agent_id,audience,issued_at,expires_at) VALUES(?,?,?,?,?,?)")
    .bind(credential.jti, tenantId, agentId, audience.origin, stamp(), credential.expiresAt).run();
  return c.json({ ...credential, credentialType: "agentport_mandate_v1", audience: audience.origin, actions: [...new Set(body.actions)] }, 201);
});

routes.post("/agents/:agentId/credentials/:jti/revoke", async c => {
  if (c.req.header("x-naelao-role") === "agent") return c.json({ error_code: "owner_authorization_required" }, 403);
  const tenantId = c.get("tenantId"); const agentId = c.req.param("agentId"); const jti = c.req.param("jti");
  const agent = await c.env.PLATFORM_DB.prepare("SELECT a.id,p.external_id,p.principal_type FROM agentport_agents a JOIN agentport_principals p ON p.id=a.principal_id AND p.tenant_id=a.tenant_id WHERE a.id=? AND a.tenant_id=?")
    .bind(agentId, tenantId).first<{ id: string; external_id: string; principal_type: string }>();
  if (!agent) return c.json({ error_code: "agent_unavailable" }, 404);
  if (c.req.header("x-naelao-role") === "agentport_api" && (agent.external_id !== c.req.header("x-agentport-owner-id") || agent.principal_type !== c.req.header("x-agentport-owner-type"))) return c.json({ error_code: "agent_unavailable" }, 404);
  const revoked = await c.env.PLATFORM_DB.prepare("UPDATE agentport_issued_credentials SET reason_code='owner_revoked',revoked_at=? WHERE jti=? AND tenant_id=? AND agent_id=? AND revoked_at IS NULL AND expires_at>?")
    .bind(stamp(), jti, tenantId, agentId, stamp()).run();
  return c.json({ revoked: revoked.meta.changes > 0 });
});

routes.post("/accounts", async (c) => {
  const body = await c.req.json<{ serviceId?: string; accountModel?: AccountModel; ownerType?: "individual" | "organization" | "agentport" | "provider"; ownerId?: string; parentAccountId?: string; externalAccountId?: string; credentialRef?: string; metadata?: unknown }>().catch(() => null);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB;
  if (!body?.serviceId || !body.ownerId || !body.ownerType || !body.accountModel || !["agent_native", "user_parent", "agentport_parent", "delegated"].includes(body.accountModel)) return c.json({ error_code: "invalid_account" }, 400);
  if (accountModelRequiresParent(body.accountModel) && !body.parentAccountId) return c.json({ error_code: "parent_account_required" }, 400);
  if (!accountModelRequiresParent(body.accountModel) && body.parentAccountId) return c.json({ error_code: "unexpected_parent_account" }, 400);
  const service = await db.prepare("SELECT account_models_json FROM agentport_services WHERE id=? AND tenant_id=? AND status='active'").bind(body.serviceId, tenantId).first<{ account_models_json: string }>();
  if (!service || !(JSON.parse(service.account_models_json) as string[]).includes(body.accountModel)) return c.json({ error_code: "account_model_not_supported" }, 422);
  if (body.parentAccountId) {
    const parent = await db.prepare("SELECT id FROM agentport_accounts WHERE id=? AND tenant_id=? AND status='active'").bind(body.parentAccountId, tenantId).first();
    if (!parent) return c.json({ error_code: "parent_account_unavailable" }, 422);
  }
  const accountId = id("acct"); const at = stamp();
  await db.prepare(`INSERT INTO agentport_accounts (id,tenant_id,service_id,account_model,owner_type,owner_id,parent_account_id,external_account_id,credential_ref,metadata_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).bind(accountId, tenantId, body.serviceId, body.accountModel, body.ownerType, body.ownerId, body.parentAccountId ?? null,
    body.externalAccountId ?? null, body.credentialRef ?? null, JSON.stringify(body.metadata ?? {}), at, at).run();
  return c.json({ account: { id: accountId, serviceId: body.serviceId, model: body.accountModel, status: "pending" } }, 201);
});

routes.get("/accounts", async (c) => {
  const tenantId = c.get("tenantId");
  const ownerId = c.req.query("ownerId");
  const ownerType = c.req.query("ownerType");
  const apiOwner = c.req.header("x-naelao-role") === "agentport_api";
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT a.id,a.service_id,a.account_model,a.owner_type,a.owner_id,a.parent_account_id,a.external_account_id,a.status,a.metadata_json,a.created_at
    FROM agentport_accounts a WHERE a.tenant_id=? AND (?=0 OR (a.owner_id=? AND a.owner_type=?) OR (a.owner_type='agentport' AND a.owner_id=?) OR EXISTS (
      SELECT 1 FROM agentport_account_grants g JOIN agentport_agents ag ON ag.id=g.agent_id AND ag.tenant_id=g.tenant_id
      JOIN agentport_principals p ON p.id=ag.principal_id AND p.tenant_id=ag.tenant_id
      WHERE g.account_id=a.id AND g.tenant_id=a.tenant_id AND g.status='active' AND p.external_id=? AND p.principal_type=?))
    ORDER BY a.created_at DESC LIMIT 200`).bind(tenantId, apiOwner ? 1 : 0, ownerId, ownerType, tenantId, ownerId, ownerType).all<Record<string, unknown>>();
  return c.json({ accounts: (rows.results ?? []).map(row => ({ ...row, metadata: JSON.parse(String(row.metadata_json)), metadata_json: undefined })) });
});

routes.post("/accounts/:accountId/activate", async (c) => {
  const changed = await c.env.PLATFORM_DB.prepare("UPDATE agentport_accounts SET status='active',updated_at=? WHERE id=? AND tenant_id=? AND status='pending'").bind(stamp(), c.req.param("accountId"), c.get("tenantId")).run();
  return changed.meta.changes ? c.json({ active: true }) : c.json({ error_code: "account_not_pending" }, 409);
});

routes.post("/accounts/:accountId/grants", async (c) => {
  const body = await c.req.json<{ agentId?: string; grantedBy?: string; permissions?: string[]; expiresAt?: string }>().catch(() => null);
  if (!body?.agentId || !body.grantedBy || !Array.isArray(body.permissions) || body.permissions.length < 1 || body.permissions.length > 100 || body.permissions.some(p => typeof p !== "string" || p.length > 160)) return c.json({ error_code: "invalid_grant" }, 400);
  if (body.expiresAt && (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now())) return c.json({ error_code: "invalid_grant_expiry" }, 400);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB; const at = stamp();
  const [account, agent] = await Promise.all([
    db.prepare("SELECT id FROM agentport_accounts WHERE id=? AND tenant_id=? AND status='active'").bind(c.req.param("accountId"), tenantId).first(),
    db.prepare("SELECT id FROM agentport_agents WHERE id=? AND tenant_id=? AND status='active'").bind(body.agentId, tenantId).first(),
  ]);
  if (!account || !agent) return c.json({ error_code: "account_or_agent_unavailable" }, 404);
  const grantId = id("grt");
  try { await db.prepare("INSERT INTO agentport_account_grants(id,tenant_id,account_id,agent_id,granted_by,permissions_json,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(grantId, tenantId, c.req.param("accountId"), body.agentId, body.grantedBy, JSON.stringify([...new Set(body.permissions)]), body.expiresAt ?? null, at, at).run();
  } catch { return c.json({ error_code: "grant_conflict" }, 409); }
  return c.json({ grant: { id: grantId, accountId: c.req.param("accountId"), agentId: body.agentId, permissions: [...new Set(body.permissions)], expiresAt: body.expiresAt ?? null } }, 201);
});

routes.delete("/grants/:grantId", async (c) => {
  const result = await c.env.PLATFORM_DB.prepare("UPDATE agentport_account_grants SET status='revoked',updated_at=? WHERE id=? AND tenant_id=? AND status='active'").bind(stamp(), c.req.param("grantId"), c.get("tenantId")).run();
  return c.json({ revoked: result.meta.changes > 0 });
});

routes.post("/accounts/:accountId/dependencies", async (c) => {
  const body = await c.req.json<{ dependsOnAccountId?: string; type?: DependencyType }>().catch(() => null);
  if (!body?.dependsOnAccountId || !["provisioning", "authentication", "billing", "recovery", "runtime"].includes(String(body.type))) return c.json({ error_code: "invalid_dependency" }, 400);
  const dependencyType = body.type as DependencyType;
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB; const accountId = c.req.param("accountId");
  const rows = await db.prepare("SELECT account_id,depends_on_account_id,dependency_type FROM agentport_account_dependencies WHERE tenant_id=?").bind(tenantId).all<{ account_id: string; depends_on_account_id: string; dependency_type: DependencyType }>();
  const edges: AccountDependency[] = [...(rows.results ?? []).map(row => ({ accountId: row.account_id, dependsOnAccountId: row.depends_on_account_id, type: row.dependency_type })), { accountId, dependsOnAccountId: body.dependsOnAccountId, type: dependencyType }];
  const inspection = inspectDependencyGraph(edges);
  if (dependencyType === "provisioning" && inspection.provisioningCycles.length) return c.json({ error_code: "provisioning_dependency_cycle", cycles: inspection.provisioningCycles }, 409);
  const at = stamp();
  try { await db.prepare("INSERT INTO agentport_account_dependencies(tenant_id,account_id,depends_on_account_id,dependency_type,created_at) VALUES(?,?,?,?,?)").bind(tenantId, accountId, body.dependsOnAccountId, dependencyType, at).run(); }
  catch { return c.json({ error_code: "dependency_conflict" }, 409); }
  return c.json({ added: true, warnings: inspection.warnings });
});

routes.post("/events/subscriptions", async (c) => {
  const body = await c.req.json<{ agentId?: string; serviceId?: string; accountId?: string; eventType?: string; deliveryMode?: "webhook" | "poll" | "naelao" | "mcp"; consumerGroup?: string; routing?: unknown }>().catch(() => null);
  if (!body?.agentId || !body.serviceId || !body.eventType || !body.deliveryMode || !["webhook", "poll", "naelao", "mcp"].includes(body.deliveryMode)) return c.json({ error_code: "invalid_subscription" }, 400);
  if (c.req.header("x-naelao-role") === "agent" && body.agentId !== c.req.header("x-naelao-user-id")) return c.json({ error_code: "agent_identity_mismatch" }, 403);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB;
  const [agent, service] = await Promise.all([
    db.prepare("SELECT id FROM agentport_agents WHERE id=? AND tenant_id=? AND status='active'").bind(body.agentId, tenantId).first(),
    db.prepare("SELECT events_json FROM agentport_services WHERE id=? AND tenant_id=? AND status='active'").bind(body.serviceId, tenantId).first<{ events_json: string }>(),
  ]);
  if (!agent || !service || !(JSON.parse(service.events_json) as string[]).includes(body.eventType)) return c.json({ error_code: "event_not_supported" }, 422);
  if (body.accountId) {
    const account = await db.prepare("SELECT id FROM agentport_accounts WHERE id=? AND tenant_id=? AND service_id=? AND status='active'").bind(body.accountId, tenantId, body.serviceId).first();
    if (!account) return c.json({ error_code: "account_unavailable" }, 404);
    const grant = await db.prepare(`SELECT 1 FROM agentport_account_grants WHERE tenant_id=? AND account_id=? AND agent_id=? AND status='active'
      AND (expires_at IS NULL OR expires_at>?)`).bind(tenantId, body.accountId, body.agentId, stamp()).first();
    if (!grant) return c.json({ error_code: "account_grant_required" }, 403);
  }
  const subId = id("sub"); const at = stamp();
  try { await db.prepare(`INSERT INTO agentport_event_subscriptions(id,tenant_id,agent_id,service_id,account_id,event_type,delivery_mode,consumer_group,routing_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(subId, tenantId, body.agentId, body.serviceId, body.accountId ?? null, body.eventType, body.deliveryMode,
    body.consumerGroup ?? "default", JSON.stringify(body.routing ?? {}), at, at).run(); }
  catch { return c.json({ error_code: "subscription_conflict" }, 409); }
  return c.json({ subscription: { id: subId, agentId: body.agentId, serviceId: body.serviceId, eventType: body.eventType, deliveryMode: body.deliveryMode } }, 201);
});

routes.post("/events", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body && Object.keys(body).some(key => !["id", "serviceId", "accountId", "providerEventId", "eventType", "threadRef", "dataRef"].includes(key))) return c.json({ error_code: "event_content_must_remain_with_provider" }, 400);
  const { id: eventIdInput, serviceId, accountId, providerEventId, eventType, threadRef, dataRef } = (body ?? {}) as {
    id?: string; serviceId?: string; accountId?: string; providerEventId?: string; eventType?: string; threadRef?: string; dataRef?: string;
  };
  if (!serviceId || !eventType || !providerEventId || (dataRef !== undefined && (typeof dataRef !== "string" || dataRef.length > 1024))) return c.json({ error_code: "invalid_event" }, 400);
  const tenantId = c.get("tenantId"); const service = await c.env.PLATFORM_DB.prepare("SELECT events_json FROM agentport_services WHERE id=? AND tenant_id=? AND status='active'").bind(serviceId, tenantId).first<{ events_json: string }>();
  if (!service || !(JSON.parse(service.events_json) as string[]).includes(eventType)) return c.json({ error_code: "event_not_supported" }, 422);
  if (accountId) {
    const account = await c.env.PLATFORM_DB.prepare("SELECT id FROM agentport_accounts WHERE id=? AND tenant_id=? AND service_id=? AND status='active'").bind(accountId, tenantId, serviceId).first();
    if (!account) return c.json({ error_code: "account_service_mismatch" }, 404);
  }
  const eventId = eventIdInput ?? id("evt"); const at = stamp();
  try { await c.env.PLATFORM_DB.prepare(`INSERT INTO agentport_events(id,tenant_id,service_id,account_id,provider_event_id,event_type,thread_ref,payload_ref,available_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(eventId, tenantId, serviceId, accountId ?? null, providerEventId, eventType, threadRef ?? null, dataRef ?? null, at, at).run(); }
  catch { return c.json({ accepted: true, duplicate: true }); }
  const subscriptions = await c.env.PLATFORM_DB.prepare(`SELECT s.id,s.agent_id FROM agentport_event_subscriptions s
    WHERE s.tenant_id=? AND s.service_id=? AND s.event_type=? AND s.status='active'
      AND (s.account_id IS NULL OR s.account_id=?)`).bind(tenantId, serviceId, eventType, accountId ?? null).all<{ id: string; agent_id: string }>();
  for (const sub of subscriptions.results ?? []) await c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO agentport_event_deliveries
    (id,tenant_id,event_id,subscription_id,agent_id,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id("dlv"), tenantId, eventId, sub.id, sub.agent_id, at, at, at).run();
  return c.json({ accepted: true, duplicate: false, id: eventId }, 202);
});

routes.get("/events/pending", async (c) => {
  const agentId = c.req.query("agentId"); if (!agentId) return c.json({ error_code: "agent_id_required" }, 400);
  if (c.req.header("x-naelao-role") === "agent" && agentId !== c.req.header("x-naelao-user-id")) return c.json({ error_code: "agent_identity_mismatch" }, 403);
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT d.id AS delivery_id,e.id,e.service_id,e.account_id,e.event_type,e.thread_ref,e.payload_ref,d.attempts,d.available_at
    FROM agentport_event_deliveries d JOIN agentport_events e ON e.id=d.event_id AND e.tenant_id=d.tenant_id
    JOIN agentport_event_subscriptions s ON s.id=d.subscription_id AND s.tenant_id=d.tenant_id
    WHERE d.tenant_id=? AND d.agent_id=? AND s.status='active' AND d.status='pending' AND d.available_at<=?
      AND (e.account_id IS NULL OR EXISTS (SELECT 1 FROM agentport_account_grants g WHERE g.tenant_id=d.tenant_id AND g.account_id=e.account_id AND g.agent_id=d.agent_id AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?)))
    ORDER BY d.created_at LIMIT 100`)
    .bind(c.get("tenantId"), agentId, stamp(), stamp()).all();
  return c.json({ events: (rows.results ?? []).map(({ payload_ref, ...event }) => ({ ...event, dataRef: payload_ref })) });
});

routes.post("/events/:eventId/claim", async (c) => {
  const body = await c.req.json<{ agentId?: string; consumerId?: string; ttlSeconds?: number }>().catch(() => null);
  if (!body?.agentId || !body.consumerId || body.consumerId.length > 200) return c.json({ error_code: "invalid_claim" }, 400);
  if (c.req.header("x-naelao-role") === "agent" && body.agentId !== c.req.header("x-naelao-user-id")) return c.json({ error_code: "agent_identity_mismatch" }, 403);
  const tenantId = c.get("tenantId"); const at = stamp();
  const claimExpiry = new Date(leaseExpiry(Date.now(), body.ttlSeconds ?? 60)).toISOString();
  await c.env.PLATFORM_DB.prepare(`UPDATE agentport_event_deliveries SET status='dead_letter',claim_owner=NULL,claim_expires_at=NULL,updated_at=?
    WHERE event_id=? AND tenant_id=? AND agent_id=? AND status='claimed' AND attempts>=8 AND claim_expires_at<=?`)
    .bind(at, c.req.param("eventId"), tenantId, body.agentId, at).run();
  const result = await c.env.PLATFORM_DB.prepare(`UPDATE agentport_event_deliveries SET status='claimed',claim_owner=?,claim_expires_at=?,attempts=attempts+1,updated_at=?
    WHERE event_id=? AND tenant_id=? AND agent_id=? AND (status='pending' OR (status='claimed' AND claim_expires_at<=?))
    AND attempts<8 AND available_at<=? AND EXISTS (SELECT 1 FROM agentport_event_subscriptions s WHERE s.id=subscription_id AND s.status='active')
    AND EXISTS (SELECT 1 FROM agentport_events e WHERE e.id=event_id AND e.tenant_id=agentport_event_deliveries.tenant_id AND (e.account_id IS NULL OR EXISTS
      (SELECT 1 FROM agentport_account_grants g WHERE g.tenant_id=e.tenant_id AND g.account_id=e.account_id AND g.agent_id=agentport_event_deliveries.agent_id AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?))))`)
    .bind(body.consumerId, claimExpiry, at, c.req.param("eventId"), tenantId, body.agentId, at, at, at).run();
  if (!result.meta.changes) return c.json({ error_code: "event_unavailable" }, 409);
  const event = await c.env.PLATFORM_DB.prepare(`SELECT e.id,e.service_id,e.account_id,e.event_type,e.thread_ref,e.payload_ref,d.id AS delivery_id,d.attempts,d.claim_expires_at
    FROM agentport_event_deliveries d JOIN agentport_events e ON e.id=d.event_id AND e.tenant_id=d.tenant_id WHERE d.event_id=? AND d.tenant_id=? AND d.agent_id=? AND d.claim_owner=?`)
    .bind(c.req.param("eventId"), tenantId, body.agentId, body.consumerId).first();
  if (event && "payload_ref" in event) {
    const { payload_ref, ...rest } = event as Record<string, unknown>;
    return c.json({ claimed: true, event: { ...rest, dataRef: payload_ref } });
  }
  return c.json({ claimed: true, event });
});

routes.post("/events/:eventId/ack", async (c) => {
  const body = await c.req.json<{ agentId?: string; consumerId?: string; result?: "delivered" | "retry" | "dead_letter" }>().catch(() => null);
  if (!body?.agentId || !body.consumerId || !["delivered", "retry", "dead_letter"].includes(String(body.result))) return c.json({ error_code: "invalid_ack" }, 400);
  if (c.req.header("x-naelao-role") === "agent" && body.agentId !== c.req.header("x-naelao-user-id")) return c.json({ error_code: "agent_identity_mismatch" }, 403);
  const retryAt = new Date(Date.now() + 5000).toISOString();
  const result = await c.env.PLATFORM_DB.prepare(`UPDATE agentport_event_deliveries SET
    status=CASE WHEN ?='retry' AND attempts>=8 THEN 'dead_letter' WHEN ?='retry' THEN 'pending' ELSE ? END,
    claim_owner=NULL,claim_expires_at=NULL,available_at=?,updated_at=?
    WHERE event_id=? AND tenant_id=? AND agent_id=? AND claim_owner=? AND status='claimed' AND claim_expires_at>?`)
    .bind(body.result, body.result, body.result, retryAt, stamp(), c.req.param("eventId"), c.get("tenantId"), body.agentId, body.consumerId, stamp()).run();
  if (!result.meta.changes) return c.json({ error_code: "event_unavailable" }, 404);
  const delivery = await c.env.PLATFORM_DB.prepare("SELECT status FROM agentport_event_deliveries WHERE event_id=? AND tenant_id=? AND agent_id=?").bind(c.req.param("eventId"), c.get("tenantId"), body.agentId).first<{ status: string }>();
  return c.json({ acknowledged: true, status: delivery?.status ?? "unavailable" });
});

routes.post("/activity/leases", async (c) => {
  const body = await c.req.json<{ agentId?: string; subscriptionId?: string; consumerId?: string; ttlSeconds?: number }>().catch(() => null);
  if (!body?.agentId || !body.subscriptionId || !body.consumerId || body.consumerId.length > 200) return c.json({ error_code: "invalid_activity_lease" }, 400);
  if (c.req.header("x-naelao-role") === "agent" && body.agentId !== c.req.header("x-naelao-user-id")) return c.json({ error_code: "agent_identity_mismatch" }, 403);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB;
  const subscription = await db.prepare("SELECT id FROM agentport_event_subscriptions WHERE id=? AND tenant_id=? AND agent_id=? AND status='active'").bind(body.subscriptionId, tenantId, body.agentId).first();
  if (!subscription) return c.json({ error_code: "subscription_unavailable" }, 404);
  const leaseId = id("lea"); const at = stamp(); const expiry = new Date(leaseExpiry(Date.now(), body.ttlSeconds ?? 60)).toISOString();
  await db.prepare(`INSERT INTO agentport_activity_leases(id,tenant_id,agent_id,subscription_id,consumer_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,subscription_id,consumer_id) DO UPDATE SET id=excluded.id,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .bind(leaseId, tenantId, body.agentId, body.subscriptionId, body.consumerId, expiry, at, at).run();
  return c.json({ lease: { id: leaseId, subscriptionId: body.subscriptionId, consumerId: body.consumerId, expiresAt: expiry } }, 201);
});

routes.post("/activity/leases/:leaseId/renew", async (c) => {
  const body = await c.req.json<{ agentId?: string; ttlSeconds?: number }>().catch(() => null);
  if (!body?.agentId) return c.json({ error_code: "agent_id_required" }, 400);
  if (c.req.header("x-naelao-role") === "agent" && body.agentId !== c.req.header("x-naelao-user-id")) return c.json({ error_code: "agent_identity_mismatch" }, 403);
  const expiry = new Date(leaseExpiry(Date.now(), body.ttlSeconds ?? 60)).toISOString();
  const result = await c.env.PLATFORM_DB.prepare("UPDATE agentport_activity_leases SET expires_at=?,updated_at=? WHERE id=? AND tenant_id=? AND agent_id=? AND expires_at>? AND EXISTS (SELECT 1 FROM agentport_event_subscriptions s WHERE s.id=subscription_id AND s.status='active')")
    .bind(expiry, stamp(), c.req.param("leaseId"), c.get("tenantId"), body.agentId, stamp()).run();
  return result.meta.changes ? c.json({ renewed: true, expiresAt: expiry }) : c.json({ error_code: "lease_expired_or_unavailable" }, 409);
});

routes.delete("/activity/leases/:leaseId", async (c) => {
  const agentId = c.req.header("x-naelao-role") === "agent" ? c.req.header("x-naelao-user-id") : null;
  const result = await c.env.PLATFORM_DB.prepare("DELETE FROM agentport_activity_leases WHERE id=? AND tenant_id=? AND (? IS NULL OR agent_id=?)")
    .bind(c.req.param("leaseId"), c.get("tenantId"), agentId, agentId).run();
  return c.json({ released: result.meta.changes > 0 });
});

function channelPermissionDenied(c: Context<{ Bindings: AgentPortEnv; Variables: { tenantId: string } }>, message: string) {
  return c.json({ error_code: "channel_access_denied", message }, 403);
}

async function channelGrant(db: D1Database, tenantId: string, channelId: string, agentId: string, permission: string) {
  return db.prepare(`SELECT 1 FROM agentport_channels ch JOIN agentport_accounts a ON a.id=ch.account_id AND a.tenant_id=ch.tenant_id
    JOIN agentport_agents ag ON ag.tenant_id=ch.tenant_id AND ag.id=? AND ag.status='active'
    JOIN agentport_account_grants g ON g.tenant_id=ch.tenant_id AND g.account_id=a.id AND g.agent_id=ag.id AND g.status='active'
    WHERE ch.id=? AND ch.tenant_id=? AND ch.status='active' AND a.status='active'
      AND (g.expires_at IS NULL OR g.expires_at>?) AND EXISTS (
        SELECT 1 FROM json_each(g.permissions_json) p WHERE p.value=? OR p.value='*'
          OR (?='messages.read' AND p.value IN ('email.read','email.receive'))
          OR (?='messages.send' AND p.value='email.send'))`)
    .bind(agentId, channelId, tenantId, stamp(), permission, permission, permission).first();
}

routes.post("/channels", async (c) => {
  const body = await c.req.json<{ id?: string; serviceId?: string; accountId?: string; agentId?: string; providerChannelId?: string; displayName?: string; trustPolicy?: Record<string, unknown> }>().catch(() => null);
  if (!body?.serviceId || !body.accountId || !body.agentId || !body.providerChannelId || !body.displayName || body.displayName.length > 160 || body.providerChannelId.length > 512) return c.json({ error_code: "invalid_channel" }, 400);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB;
  const [service, account, agent] = await Promise.all([
    db.prepare("SELECT id,service_type,capabilities_json FROM agentport_services WHERE id=? AND tenant_id=? AND status='active'").bind(body.serviceId, tenantId).first<{ id: string; service_type: string; capabilities_json: string }>(),
    db.prepare("SELECT id,service_id,status FROM agentport_accounts WHERE id=? AND tenant_id=?").bind(body.accountId, tenantId).first<{ id: string; service_id: string; status: string }>(),
    db.prepare("SELECT id FROM agentport_agents WHERE id=? AND tenant_id=? AND status='active'").bind(body.agentId, tenantId).first(),
  ]);
  if (!service || !account || account.service_id !== service.id || account.status !== "active" || !agent) return c.json({ error_code: "channel_resource_unavailable" }, 404);
  if (!JSON.parse(service.capabilities_json).some((capability: unknown) => ["channels", "channel.read", "channel.send", "email.read", "email.send"].includes(String(capability)))) return c.json({ error_code: "channel_capability_not_declared" }, 422);
  const managementGrant = await db.prepare(`SELECT 1 FROM agentport_account_grants WHERE tenant_id=? AND account_id=? AND agent_id=? AND status='active'
    AND (expires_at IS NULL OR expires_at>?) AND EXISTS (SELECT 1 FROM json_each(permissions_json) p WHERE p.value IN ('channels.manage','*'))`)
    .bind(tenantId, account.id, body.agentId, stamp()).first();
  if (!managementGrant) return channelPermissionDenied(c, "The agent needs an explicit channels.manage grant before this channel can be attached.");
  const channelId = body.id ?? id("chn"); const at = stamp();
  const inputPolicy = body.trustPolicy ?? {};
  const trustPolicy = {
    publicReplies: inputPolicy.publicReplies === true,
    publicMemoryUpdates: false,
    commandMode: ["owner_only", "owner_and_delegates", "public_conversation"].includes(String(inputPolicy.commandMode)) ? inputPolicy.commandMode : "owner_only",
    authenticationMode: ["basic", "stepup", "strict"].includes(String(inputPolicy.authenticationMode)) ? inputPolicy.authenticationMode : "basic",
    alwaysRequireApprovalFor: Array.isArray(inputPolicy.alwaysRequireApprovalFor) ? inputPolicy.alwaysRequireApprovalFor.filter((x): x is string => typeof x === "string" && x.length <= 120).slice(0, 100) : ["payments.transfer", "account.security.change"],
  };
  try {
    await db.prepare(`INSERT INTO agentport_channels(id,tenant_id,service_id,account_id,provider_channel_id,display_name,trust_policy_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(channelId, tenantId, service.id, account.id, body.providerChannelId, body.displayName.trim(), JSON.stringify(trustPolicy), at, at).run();
  } catch { return c.json({ error_code: "channel_conflict" }, 409); }
  return c.json({ channel: { id: channelId, serviceId: service.id, accountId: account.id, displayName: body.displayName.trim(), status: "active", trustPolicy } }, 201);
});

routes.get("/channels", async (c) => {
  const agentId = c.req.query("agentId"); const tenantId = c.get("tenantId");
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT ch.id,ch.service_id,ch.account_id,ch.provider_channel_id,ch.display_name,ch.trust_policy_json,ch.status,ch.created_at
    FROM agentport_channels ch WHERE ch.tenant_id=? AND ch.status='active' AND (? IS NULL OR EXISTS (
      SELECT 1 FROM agentport_account_grants g WHERE g.tenant_id=ch.tenant_id AND g.account_id=ch.account_id AND g.agent_id=? AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?)))
    ORDER BY ch.created_at DESC LIMIT 200`).bind(tenantId, agentId ?? null, agentId ?? null, stamp()).all();
  return c.json({ channels: (rows.results ?? []).map(row => ({ ...row, trust_policy: JSON.parse(String(row.trust_policy_json)) })) });
});

routes.post("/channels/:channelId/trusted-senders", async (c) => {
  const body = await c.req.json<{ providerSenderId?: string; role?: "owner" | "delegate"; principalId?: string; authenticationMode?: "basic" | "stepup" | "strict"; allowedActions?: string[] }>().catch(() => null);
  if (!body?.providerSenderId || body.providerSenderId.length > 512 || !body.principalId || body.principalId.length > 160 || !["owner", "delegate"].includes(String(body.role))) return c.json({ error_code: "invalid_trusted_sender" }, 400);
  if (c.req.header("x-naelao-role") === "agent") return channelPermissionDenied(c, "Only a trusted owner or administrator can configure channel trust.");
  const tenantId = c.get("tenantId"); const channelId = c.req.param("channelId");
  const channel = await c.env.PLATFORM_DB.prepare("SELECT id FROM agentport_channels WHERE id=? AND tenant_id=? AND status='active'").bind(channelId, tenantId).first();
  if (!channel) return c.json({ error_code: "channel_unavailable" }, 404);
  const at = stamp(); const senderId = id("snd");
  const actions = [...new Set((body.allowedActions ?? []).filter(x => typeof x === "string" && x.length <= 120))].slice(0, 100);
  try { await c.env.PLATFORM_DB.prepare(`INSERT INTO agentport_trusted_senders(id,tenant_id,channel_id,provider_sender_id,role,principal_id,authentication_mode,allowed_actions_json,verified_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(senderId, tenantId, channelId, body.providerSenderId, body.role, body.principalId,
      ["basic", "stepup", "strict"].includes(String(body.authenticationMode)) ? body.authenticationMode : "basic", JSON.stringify(actions), at, at).run(); }
  catch { return c.json({ error_code: "trusted_sender_conflict" }, 409); }
  return c.json({ trustedSender: { id: senderId, providerSenderId: body.providerSenderId, role: body.role, principalId: body.principalId, authenticationMode: body.authenticationMode ?? "basic", allowedActions: actions } }, 201);
});

routes.post("/channels/:channelId/threads", async (c) => {
  const body = await c.req.json<{ providerThreadId?: string; participants?: string[]; metadata?: Record<string, unknown>; sessionBinding?: Record<string, unknown> }>().catch(() => null);
  if (!body?.providerThreadId || body.providerThreadId.length > 512) return c.json({ error_code: "invalid_thread" }, 400);
  const tenantId = c.get("tenantId"); const channelId = c.req.param("channelId");
  const channel = await c.env.PLATFORM_DB.prepare("SELECT id FROM agentport_channels WHERE id=? AND tenant_id=? AND status='active'").bind(channelId, tenantId).first();
  if (!channel) return c.json({ error_code: "channel_unavailable" }, 404);
  const threadId = id("thr"); const at = stamp();
  try { await c.env.PLATFORM_DB.prepare(`INSERT INTO agentport_threads(id,tenant_id,channel_id,provider_thread_id,participants_json,metadata_json,session_binding_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(threadId, tenantId, channelId, body.providerThreadId,
      JSON.stringify((body.participants ?? []).filter(x => typeof x === "string").slice(0, 100)), JSON.stringify(body.metadata ?? {}), body.sessionBinding ? JSON.stringify(body.sessionBinding) : null, at, at).run(); }
  catch { return c.json({ error_code: "thread_conflict" }, 409); }
  return c.json({ thread: { id: threadId, channelId, providerThreadId: body.providerThreadId, sessionBinding: body.sessionBinding ?? null, status: "active" } }, 201);
});

routes.get("/channels/:channelId/threads", async (c) => {
  const tenantId = c.get("tenantId"); const agentId = c.req.query("agentId"); const channelId = c.req.param("channelId");
  if (agentId && !await channelGrant(c.env.PLATFORM_DB, tenantId, channelId, agentId, "messages.read")) return channelPermissionDenied(c, "The agent does not have message-read access to this channel.");
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT id,provider_thread_id,participants_json,metadata_json,session_binding_json,status,last_message_at,created_at
    FROM agentport_threads WHERE tenant_id=? AND channel_id=? AND status!='closed' ORDER BY last_message_at DESC LIMIT 100`).bind(tenantId, channelId).all();
  return c.json({ threads: (rows.results ?? []).map(row => ({ ...row, participants: JSON.parse(String(row.participants_json)), metadata: JSON.parse(String(row.metadata_json)), sessionBinding: row.session_binding_json ? JSON.parse(String(row.session_binding_json)) : null })) });
});

routes.get("/threads/:threadId/message-references", async (c) => {
  const tenantId = c.get("tenantId"); const agentId = c.req.query("agentId"); const threadId = c.req.param("threadId");
  const thread = await c.env.PLATFORM_DB.prepare("SELECT channel_id FROM agentport_threads WHERE id=? AND tenant_id=?").bind(threadId, tenantId).first<{ channel_id: string }>();
  if (!thread) return c.json({ error_code: "thread_unavailable" }, 404);
  if (agentId && !await channelGrant(c.env.PLATFORM_DB, tenantId, thread.channel_id, agentId, "messages.read")) return channelPermissionDenied(c, "The agent does not have message-read access to this thread.");
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT provider_message_id,direction,sender_id,sender_role,trust_level,status,occurred_at
    FROM agentport_channel_message_refs WHERE tenant_id=? AND thread_id=? ORDER BY occurred_at DESC LIMIT 100`).bind(tenantId, threadId).all();
  return c.json({ messageReferences: (rows.results ?? []).reverse().map(row => ({ providerMessageId: row.provider_message_id,
    direction: row.direction, senderId: row.sender_id, senderRole: row.sender_role, trustLevel: row.trust_level, status: row.status, occurredAt: row.occurred_at })), contentLocation: "channel_provider" });
});

// Provider adapters post references and trust metadata only. Message text, attachments and
// conversation history remain in the channel provider and are fetched through its authorized API.
routes.post("/channels/:channelId/message-events/inbound", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body && Object.keys(body).some(key => !["providerMessageId", "providerThreadId", "senderId", "occurredAt"].includes(key))) return c.json({ error_code: "message_content_must_remain_with_provider" }, 400);
  const { providerMessageId, providerThreadId, senderId, occurredAt } = (body ?? {}) as { providerMessageId?: string; providerThreadId?: string; senderId?: string; occurredAt?: string };
  if (!providerMessageId || !providerThreadId || !senderId || providerMessageId.length > 512 || providerThreadId.length > 512 || senderId.length > 512) return c.json({ error_code: "invalid_message_event" }, 400);
  const tenantId = c.get("tenantId"); const channelId = c.req.param("channelId"); const db = c.env.PLATFORM_DB;
  const channel = await db.prepare(`SELECT ch.service_id,ch.account_id,s.events_json FROM agentport_channels ch JOIN agentport_services s ON s.id=ch.service_id AND s.tenant_id=ch.tenant_id
    WHERE ch.id=? AND ch.tenant_id=? AND ch.status='active' AND s.status='active'`).bind(channelId, tenantId).first<{ service_id: string; account_id: string; events_json: string }>();
  if (!channel) return c.json({ error_code: "channel_unavailable" }, 404);
  if (!(JSON.parse(channel.events_json) as string[]).includes("message.received")) return c.json({ error_code: "event_not_supported" }, 422);
  const at = stamp(); const messageAt = occurredAt && Number.isFinite(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : at;
  const threadId = id("thr");
  await db.prepare(`INSERT OR IGNORE INTO agentport_threads(id,tenant_id,channel_id,provider_thread_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(threadId, tenantId, channelId, providerThreadId, at, at).run();
  const thread = await db.prepare("SELECT id FROM agentport_threads WHERE tenant_id=? AND channel_id=? AND provider_thread_id=?").bind(tenantId, channelId, providerThreadId).first<{ id: string }>();
  if (!thread) return c.json({ error_code: "thread_store_unavailable" }, 503);
  const sender = await db.prepare("SELECT role FROM agentport_trusted_senders WHERE tenant_id=? AND channel_id=? AND provider_sender_id=? AND status='active'").bind(tenantId, channelId, senderId).first<{ role: "owner" | "delegate" }>();
  const senderRole = sender?.role ?? "external"; const trustLevel = sender ? "verified" : "unverified"; const messageRefId = id("mref");
  try { await db.prepare(`INSERT INTO agentport_channel_message_refs(id,tenant_id,channel_id,thread_id,provider_message_id,direction,sender_id,sender_role,trust_level,status,occurred_at,created_at)
    VALUES(?,?,?,?,?,'inbound',?,?,?,'received',?,?)`).bind(messageRefId, tenantId, channelId, thread.id, providerMessageId, senderId, senderRole, trustLevel, messageAt, at).run(); }
  catch { return c.json({ accepted: true, duplicate: true }); }
  await db.prepare("UPDATE agentport_threads SET last_message_at=?,updated_at=? WHERE id=? AND tenant_id=?").bind(messageAt, at, thread.id, tenantId).run();
  const eventId = id("evt");
  await db.prepare(`INSERT INTO agentport_events(id,tenant_id,service_id,account_id,provider_event_id,event_type,thread_ref,payload_ref,available_at,created_at)
    VALUES(?,?,?,?,?,'message.received',?,?,?,?)`).bind(eventId, tenantId, channel.service_id, channel.account_id, providerMessageId, thread.id, providerMessageId, at, at).run();
  const subscriptions = await db.prepare(`SELECT id,agent_id FROM agentport_event_subscriptions WHERE tenant_id=? AND service_id=? AND event_type='message.received' AND status='active' AND (account_id IS NULL OR account_id=?)`)
    .bind(tenantId, channel.service_id, channel.account_id).all<{ id: string; agent_id: string }>();
  for (const sub of subscriptions.results ?? []) await db.prepare(`INSERT OR IGNORE INTO agentport_event_deliveries(id,tenant_id,event_id,subscription_id,agent_id,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id("dlv"), tenantId, eventId, sub.id, sub.agent_id, at, at, at).run();
  return c.json({ accepted: true, duplicate: false, messageReference: { providerMessageId, threadId: thread.id, senderRole, trustLevel }, eventId, contentLocation: "channel_provider" }, 202);
});

// Runtimes send/read through the channel provider's own authorized API/MCP connector. AgentPort
// provides a grant decision and provider resource references but never accepts message content.
routes.post("/threads/:threadId/actions/authorize", async (c) => {
  const body = await c.req.json<{ agentId?: string; action?: "messages.read" | "messages.send"; resourceRef?: string; idempotencyKey?: string }>().catch(() => null);
  if (body && Object.keys(body).some(key => !["agentId", "action", "resourceRef", "idempotencyKey"].includes(key))) return c.json({ error_code: "message_content_must_remain_with_provider" }, 400);
  if (!body?.agentId || !["messages.read", "messages.send"].includes(String(body.action)) || (body.resourceRef && body.resourceRef.length > 512) || !body.idempotencyKey || body.idempotencyKey.length > 200) return c.json({ error_code: "invalid_channel_action" }, 400);
  const tenantId = c.get("tenantId"); const db = c.env.PLATFORM_DB; const threadId = c.req.param("threadId");
  const thread = await db.prepare(`SELECT t.id,t.channel_id,t.provider_thread_id,ch.service_id,ch.provider_channel_id,ch.account_id FROM agentport_threads t
    JOIN agentport_channels ch ON ch.id=t.channel_id AND ch.tenant_id=t.tenant_id JOIN agentport_accounts a ON a.id=ch.account_id AND a.tenant_id=ch.tenant_id
    WHERE t.id=? AND t.tenant_id=? AND t.status='active' AND ch.status='active' AND a.status='active'`).bind(threadId, tenantId)
    .first<{ id: string; channel_id: string; provider_thread_id: string; service_id: string; provider_channel_id: string; account_id: string }>();
  if (!thread) return c.json({ error_code: "thread_unavailable" }, 404);
  if (!await channelGrant(db, tenantId, thread.channel_id, body.agentId, body.action!)) return channelPermissionDenied(c, "The agent does not have the requested channel permission.");
  const prior = await db.prepare("SELECT id,outcome,action,resource_ref,channel_id,provider_id FROM agentport_action_receipts WHERE tenant_id=? AND agent_id=? AND authorization_ref=?")
    .bind(tenantId, body.agentId, body.idempotencyKey).first<{ id: string; outcome: string; action: string; resource_ref: string | null; channel_id: string | null; provider_id: string | null }>();
  if (prior) {
    if (prior.action !== body.action || prior.resource_ref !== (body.resourceRef ?? thread.provider_thread_id) || prior.channel_id !== thread.channel_id || prior.provider_id !== thread.service_id) return c.json({ error_code: "idempotency_conflict" }, 409);
    return c.json({ decision: prior.outcome === "allowed" ? "allow" : "deny", authorizationId: prior.id, serviceId: thread.service_id,
      providerChannelId: thread.provider_channel_id, providerThreadId: thread.provider_thread_id, ...(body.resourceRef ? { providerMessageId: body.resourceRef } : {}), contentLocation: "channel_provider" });
  }
  const receiptId = id("rcpt"); const at = stamp();
  await db.prepare(`INSERT OR IGNORE INTO agentport_action_receipts(id,tenant_id,agent_id,account_id,channel_id,action,resource_ref,authorization_ref,provider_id,outcome,details_json,receipt_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'allowed',?,?,?)`).bind(receiptId, tenantId, body.agentId, thread.account_id, thread.channel_id, body.action!, body.resourceRef ?? thread.provider_thread_id,
      body.idempotencyKey, thread.service_id, JSON.stringify({ threadId, contentStored: false }), await hashReceipt(`${tenantId}:${receiptId}:${body.agentId}:${body.action}:${body.idempotencyKey}`), at).run();
  const receipt = await db.prepare("SELECT id,outcome FROM agentport_action_receipts WHERE tenant_id=? AND agent_id=? AND authorization_ref=?").bind(tenantId, body.agentId, body.idempotencyKey).first<{ id: string; outcome: string }>();
  return c.json({ decision: "allow", authorizationId: receipt?.id ?? receiptId, serviceId: thread.service_id, providerChannelId: thread.provider_channel_id,
    providerThreadId: thread.provider_thread_id, ...(body.resourceRef ? { providerMessageId: body.resourceRef } : {}), contentLocation: "channel_provider" });
});

async function hashReceipt(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export const agentPortRoutes = routes;
