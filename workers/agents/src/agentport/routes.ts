import { Hono } from "hono";
import { verifyInternalToken } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { accountModelRequiresParent, inspectDependencyGraph, leaseExpiry, validateServiceRegistration, type AccountModel, type AccountDependency, type DependencyType } from "./core.js";

const routes = new Hono<{ Bindings: AgentsEnv; Variables: { tenantId: string } }>();
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
      (id,tenant_id,name,service_type,endpoint,account_models_json,capabilities_json,events_json,connection_purpose,partnership_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(service.id, tenantId, service.name, service.type, service.endpoint ?? null,
      JSON.stringify(service.accountModels), JSON.stringify(service.capabilities), JSON.stringify(service.events), service.connectionPurpose,
      service.partnershipStatus, at, at).run();
  } catch { return c.json({ error_code: "service_registration_conflict" }, 409); }
  return c.json({ service }, 201);
});

routes.get("/services", async (c) => {
  const rows = await c.env.PLATFORM_DB.prepare("SELECT id,name,service_type,endpoint,account_models_json,capabilities_json,events_json,connection_purpose,partnership_status FROM agentport_services WHERE tenant_id=? AND status='active' ORDER BY name LIMIT 200").bind(c.get("tenantId")).all();
  return c.json({ services: (rows.results ?? []).map((row) => ({ ...row, account_models: JSON.parse(String(row.account_models_json)), capabilities: JSON.parse(String(row.capabilities_json)), events: JSON.parse(String(row.events_json)) })) });
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
  return c.json({ agent: { id: agentId, principalId: principal.id, hostPlatform: body.hostPlatform, status: "active" } }, 201);
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
  const body = await c.req.json<{ id?: string; serviceId?: string; accountId?: string; providerEventId?: string; eventType?: string; threadRef?: string; payloadRef?: string }>().catch(() => null);
  if (!body?.serviceId || !body.eventType || !body.providerEventId) return c.json({ error_code: "invalid_event" }, 400);
  const tenantId = c.get("tenantId"); const service = await c.env.PLATFORM_DB.prepare("SELECT events_json FROM agentport_services WHERE id=? AND tenant_id=? AND status='active'").bind(body.serviceId, tenantId).first<{ events_json: string }>();
  if (!service || !(JSON.parse(service.events_json) as string[]).includes(body.eventType)) return c.json({ error_code: "event_not_supported" }, 422);
  if (body.accountId) {
    const account = await c.env.PLATFORM_DB.prepare("SELECT id FROM agentport_accounts WHERE id=? AND tenant_id=? AND service_id=? AND status='active'").bind(body.accountId, tenantId, body.serviceId).first();
    if (!account) return c.json({ error_code: "account_service_mismatch" }, 404);
  }
  const eventId = body.id ?? id("evt"); const at = stamp();
  try { await c.env.PLATFORM_DB.prepare(`INSERT INTO agentport_events(id,tenant_id,service_id,account_id,provider_event_id,event_type,thread_ref,payload_ref,available_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(eventId, tenantId, body.serviceId, body.accountId ?? null, body.providerEventId, body.eventType, body.threadRef ?? null, body.payloadRef ?? null, at, at).run(); }
  catch { return c.json({ accepted: true, duplicate: true }); }
  const subscriptions = await c.env.PLATFORM_DB.prepare(`SELECT s.id,s.agent_id FROM agentport_event_subscriptions s
    WHERE s.tenant_id=? AND s.service_id=? AND s.event_type=? AND s.status='active'
      AND (s.account_id IS NULL OR s.account_id=?)`).bind(tenantId, body.serviceId, body.eventType, body.accountId ?? null).all<{ id: string; agent_id: string }>();
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
  return c.json({ events: rows.results ?? [] });
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

export const agentPortRoutes = routes;
