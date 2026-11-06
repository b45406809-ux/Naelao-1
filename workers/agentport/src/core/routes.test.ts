import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { verifyAgentCredentialLocal } from "./identity.js";
import { agentPortRoutes } from "./routes.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE agentport_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_developer_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,created_by TEXT)");
  db.exec("CREATE TABLE agent_email_addresses(address_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE project_agent_email_addresses(address_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)");
  db.exec(readFileSync(new URL("../../../../infra/migrations/0158_agentport_registry.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0161_agentport_channels_threads.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0162_agentport_signed_identity.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0163_agentport_provider_auth.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0164_agentport_channel_message_refs.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0167_agentport_apps_capabilities.sql", import.meta.url), "utf8"));
  const platformDb = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async run() { const result = db.prepare(sql).run(...(values as never[])); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
      async first<T>() { return db.prepare(sql).get(...(values as never[])) as T | undefined; },
      async all<T>() { return { success: true, results: db.prepare(sql).all(...(values as never[])) as T[] }; },
    };
    return statement;
  } };
  return { db, platformDb };
}

describe("AgentPort internal registry API", () => {
  it("creates an idempotent managed AgentPort principal only for Naelao system signup", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const base = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (role: string) => agentPortRoutes.fetch(new Request("https://agentport.test/principals", {
      method: "POST", headers: { ...base, "x-naelao-role": role }, body: JSON.stringify({ id: "prn-user:tenant-a:user-1", externalId: "user-1", organizationName: "Managed tenant" }),
    }), env);
    expect((await call("owner")).status).toBe(403);
    const created = await call("system");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ accountModel: "naelao_managed", principal: { id: "prn-user:tenant-a:user-1", principal_type: "individual", external_id: "user-1" } });
    expect((await call("system")).status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agentport_principals WHERE tenant_id='tenant-a'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT name,owner_developer_id FROM agentport_organizations WHERE id='tenant-a'").get()).toEqual({ name: "Managed tenant", owner_developer_id: "naelao-managed:tenant-a" });
    db.close();
  });

  it("creates isolated microapps, provisions phased capability handles, and enforces idempotent usage budgets", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-role": "agentport_api", "x-agentport-owner-id": "owner-1", "x-agentport-owner-type": "organization" };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body?: unknown, customHeaders = headers) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    const secretManifest = await call("/services", "POST", { id: "leaky", name: "Leaky service", type: "api", accountModels: ["delegated"], capabilities: ["ai.image.generate"], events: [], connectionPurpose: "agent_resource", auth: { type: "oauth2", client_secret: "must-not-persist" } }, { ...headers, "x-naelao-role": "owner" });
    expect(secretManifest.status).toBe(400);
    const registered = await call("/services", "POST", { id: "images", name: "Image API", type: "api", accountModels: ["agent_native", "delegated"], capabilities: ["ai.image.generate"], events: [], connectionPurpose: "agent_resource", auth: { type: "oauth2", scopes: ["images:write"] }, provisioning: { mode: "self_service" } }, { ...headers, "x-naelao-role": "owner" });
    expect(registered.status).toBe(201);
    expect((await call("/apps", "POST", { name: "Unbudgeted app", ownerType: "organization", ownerId: "owner-1", billing: "byok" })).status).toBe(400);
    const created = await call("/apps", "POST", { name: "RestaurantReels", ownerType: "organization", ownerId: "owner-1", billing: "byok", budget: { monthlyUSD: 1 } });
    expect(created.status).toBe(201);
    const { app } = await created.json() as { app: { id: string } };
    const wrongOwner = await call(`/apps/${app.id}`, "GET", undefined, { ...headers, "x-agentport-owner-id": "other" });
    expect(wrongOwner.status).toBe(404);
    expect((await call(`/apps/${app.id}`, "GET", undefined, { ...headers, "x-naelao-role": "owner", "x-naelao-user-id": "other-user" })).status).toBe(404);
    const { account } = await (await call("/accounts", "POST", { serviceId: "images", accountModel: "agent_native", ownerType: "organization", ownerId: "owner-1" }, { ...headers, "x-naelao-role": "owner" })).json() as { account: { id: string } };
    // Modelled external account activation occurs only after the provider's existing authorized workflow succeeds.
    await call(`/accounts/${account.id}/activate`, "POST", {}, { ...headers, "x-naelao-role": "owner" });
    const provisioned = await call(`/apps/${app.id}/capabilities/provision`, "POST", { capability: "ai.image.generate", serviceId: "images", authorization: "byok", accountId: account.id, phase: "build_time", limits: { perCustomer: 3, monthlyUSD: 0.5 } });
    expect(provisioned.status).toBe(201);
    const customerAppResponse = await call("/apps", "POST", { name: "Customer connected app", ownerType: "organization", ownerId: "owner-1", billing: "customer", budget: { monthlyUSD: 20 } });
    const { app: customerApp } = await customerAppResponse.json() as { app: { id: string } };
    const customerCapability = await call(`/apps/${customerApp.id}/capabilities/provision`, "POST", { capability: "ai.image.generate", serviceId: "images", accountId: account.id });
    expect(customerCapability.status).toBe(201);
    expect(await customerCapability.json()).toMatchObject({ capability: { authorization: "customer_oauth", status: "active" } });
    const { capability } = await provisioned.json() as { capability: { id: string; status: string } };
    const record = { idempotencyKey: "request-1", customerRef: "private-customer-42", quantity: 2, reportedCostUSD: 0.4 };
    expect((await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", record)).status).toBe(201);
    expect(await (await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", record)).json()).toMatchObject({ recorded: true, duplicate: true });
    expect((await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", { ...record, quantity: 1 })).status).toBe(409);
    expect((await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", { idempotencyKey: "missing-cost", customerRef: "new-customer", quantity: 1 })).status).toBe(400);
    const overCustomerCap = await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", { ...record, idempotencyKey: "request-2", quantity: 2, reportedCostUSD: 0 });
    expect(overCustomerCap.status).toBe(409);
    const overCapabilityBudget = await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", { ...record, customerRef: "other-customer", idempotencyKey: "request-3", quantity: 1, reportedCostUSD: 0.2 });
    expect(overCapabilityBudget.status).toBe(409);
    const usage = await call(`/apps/${app.id}/usage`, "GET");
    expect(await usage.json()).toMatchObject({ usage: [{ capabilityId: capability.id, quantity: 2, reportedCostUSD: 0.4, settlement: "app_reported_estimate" }] });
    expect(db.prepare("SELECT customer_ref_hash FROM agentport_usage_records WHERE capability_handle_id=?").get(capability.id)).toMatchObject({ customer_ref_hash: expect.not.stringContaining("private-customer-42") });
    const managed = await call(`/apps/${app.id}/capabilities/provision`, "POST", { capability: "ai.image.generate", serviceId: "images", authorization: "managed" });
    expect(managed.status).toBe(422);
    db.prepare("UPDATE agentport_services SET partnership_status='approved' WHERE id='images'").run();
    db.prepare("INSERT INTO agentport_accounts(id,tenant_id,service_id,account_model,owner_type,owner_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("managed-image-account", "tenant-a", "images", "agent_native", "agentport", "tenant-a", "active", "2026-01-01", "2026-01-01");
    const managedAppResponse = await call("/apps", "POST", { name: "Managed app", ownerType: "organization", ownerId: "owner-1", billing: "managed", budget: { monthlyUSD: 5 } });
    const { app: managedApp } = await managedAppResponse.json() as { app: { id: string } };
    const gatedManaged = await call(`/apps/${managedApp.id}/capabilities/provision`, "POST", { capability: "ai.image.generate", provider: "auto", authorization: "managed", limits: { monthlyUSD: 5 } });
    expect(gatedManaged.status).toBe(202);
    expect(await gatedManaged.json()).toMatchObject({ capability: { status: "adapter_unavailable" } });
    db.close();
  });

  it("lets a Naelao agent request provisioning only for its owner and holds actions for owner approval", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const base = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const ownerHeaders = { ...base, "x-naelao-role": "owner", "x-naelao-user-id": "owner-1" };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body?: unknown, headers = ownerHeaders) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    await call("/services", "POST", { id: "image-api", name: "Image API", type: "api", accountModels: ["agent_native"], capabilities: ["ai.image.generate"], events: [], connectionPurpose: "agent_resource" });
    const { agent } = await (await call("/agents", "POST", { principalId: "owner-1", principalType: "individual", createdBy: "owner-1", hostPlatform: "naelao", hostSpaceId: "space-1" })).json() as { agent: { id: string } };
    const { account } = await (await call("/accounts", "POST", { serviceId: "image-api", accountModel: "agent_native", ownerType: "individual", ownerId: "owner-1" })).json() as { account: { id: string } };
    await call(`/accounts/${account.id}/activate`, "POST", {});
    const agentHeaders = { ...base, "x-naelao-role": "agent", "x-naelao-user-id": agent.id };
    const appResponse = await call("/apps", "POST", { name: "Owner app", ownerType: "individual", ownerId: "owner-1", billing: "byok", budget: { monthlyUSD: 25 } }, agentHeaders);
    expect(appResponse.status).toBe(201);
    const { app } = await appResponse.json() as { app: { id: string } };
    expect(await (await call("/apps", "GET", undefined, agentHeaders)).json()).toMatchObject({ apps: [{ id: app.id }] });
    expect((await call(`/apps/${app.id}`, "GET", undefined, agentHeaders)).status).toBe(200);
    const requested = await call(`/apps/${app.id}/capabilities/provision`, "POST", { capability: "ai.image.generate", serviceId: "image-api", authorization: "byok", accountId: account.id }, agentHeaders);
    expect(requested.status).toBe(202);
    const { capability } = await requested.json() as { capability: { id: string; status: string } };
    expect(capability.status).toBe("owner_approval_required");
    expect((await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", { idempotencyKey: "job-1", quantity: 1 }, agentHeaders)).status).toBe(409);
    const ownerApiHeaders = { ...base, "x-naelao-role": "agentport_api", "x-agentport-owner-id": "owner-1", "x-agentport-owner-type": "individual" };
    expect((await call(`/apps/${app.id}/capabilities/${capability.id}/approve`, "POST", {}, ownerApiHeaders)).status).toBe(200);
    expect((await call(`/apps/${app.id}/capabilities/${capability.id}/usage`, "POST", { idempotencyKey: "job-1", quantity: 1, reportedCostUSD: 0.01 }, agentHeaders)).status).toBe(201);
    const otherAgent = await call("/agents", "POST", { principalId: "intruder", principalType: "individual", createdBy: "intruder", hostPlatform: "naelao", hostSpaceId: "space-1" });
    const { agent: intruder } = await otherAgent.json() as { agent: { id: string } };
    const intruderHeaders = { ...base, "x-naelao-role": "agent", "x-naelao-user-id": intruder.id };
    expect((await call("/apps", "GET", undefined, intruderHeaders)).status).toBe(200);
    expect(await (await call("/apps", "GET", undefined, intruderHeaders)).json()).toMatchObject({ apps: [] });
    expect((await call(`/apps/${app.id}`, "GET", undefined, intruderHeaders)).status).toBe(404);
    expect((await call(`/apps/${app.id}/capabilities/provision`, "POST", { capability: "ai.image.generate", serviceId: "image-api", authorization: "byok", accountId: account.id }, intruderHeaders)).status).toBe(403);
    const orgAppResponse = await call("/apps", "POST", { name: "Organization app", ownerType: "organization", ownerId: "tenant-a", billing: "managed", budget: { monthlyUSD: 10 } });
    const { app: orgApp } = await orgAppResponse.json() as { app: { id: string } };
    const orgAdminHeaders = { ...base, "x-naelao-role": "owner", "x-naelao-user-id": "org-admin" };
    expect((await call("/apps", "GET", undefined, orgAdminHeaders)).status).toBe(200);
    expect(await (await call("/apps", "GET", undefined, orgAdminHeaders)).json()).toMatchObject({ apps: [{ id: orgApp.id }] });
    expect((await call(`/apps/${orgApp.id}`, "GET", undefined, orgAdminHeaders)).status).toBe(200);
    db.close();
  });

  it("requires an internal tenant token and registers services, agents, shared grants and durable events", async () => {
    const { db, platformDb } = fixture();
    const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body?: unknown, suppliedHeaders = headers) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, {
      method, headers: suppliedHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);

    const denied = await call("/services", "GET", undefined, { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": "invalid" });
    expect(denied.status).toBe(403);
    const service = await call("/services", "POST", { id: "mail-provider", name: "Cloudflare Email", type: "managed", accountModels: ["agent_native"], capabilities: ["email.send", "email.read"], events: ["message.received"], connectionPurpose: "agent_resource", auth: { type: "provider_managed" }, billing: { model: "usage_reported" } });
    expect(service.status).toBe(201);
    expect(db.prepare("SELECT a.auth_json,s.billing_json FROM agentport_services s JOIN agentport_provider_auth a ON a.service_id=s.id WHERE s.id='mail-provider'").get()).toMatchObject({ auth_json: '{"type":"provider_managed"}', billing_json: '{"model":"usage_reported"}' });
    const agentResponse = await call("/agents", "POST", { principalId: "org-1", principalType: "organization", createdBy: "user-1", hostPlatform: "naelao", hostSpaceId: "space-1" });
    const { agent } = await agentResponse.json() as { agent: { id: string } };
    const accountResponse = await call("/accounts", "POST", { serviceId: "mail-provider", accountModel: "agent_native", ownerType: "organization", ownerId: "org-1" });
    const { account } = await accountResponse.json() as { account: { id: string; status: string } };
    expect(account.status).toBe("pending");
    expect((await call(`/accounts/${account.id}/activate`, "POST")).status).toBe(200);
    const grant = await call(`/accounts/${account.id}/grants`, "POST", { agentId: agent.id, grantedBy: "user-1", permissions: ["email.read"] });
    expect(grant.status).toBe(201);
    const subscription = await call("/events/subscriptions", "POST", { agentId: agent.id, serviceId: "mail-provider", accountId: account.id, eventType: "message.received", deliveryMode: "naelao", consumerGroup: "support" });
    expect(subscription.status).toBe(201);
    const accountMismatch = await call("/events", "POST", { serviceId: "mail-provider", accountId: "another-service-account", providerEventId: "provider-evt-mismatch", eventType: "message.received" });
    expect(accountMismatch.status).toBe(404);
    const event = await call("/events", "POST", { serviceId: "mail-provider", accountId: account.id, providerEventId: "provider-evt-1", eventType: "message.received", dataRef: "r2://provider-message/1" });
    expect(event.status).toBe(202);
    const { id: eventId } = await event.json() as { id: string };
    const pending = await call(`/events/pending?agentId=${agent.id}`, "GET");
    expect((await pending.json() as { events: unknown[] }).events).toHaveLength(1);
    expect((await (await call(`/events/pending?agentId=${agent.id}`, "GET")).json() as { events: Array<{ dataRef: string }> }).events[0]?.dataRef).toBe("r2://provider-message/1");
    const claim = await call(`/events/${eventId}/claim`, "POST", { agentId: agent.id, consumerId: "naelao:run-1", ttlSeconds: 60 });
    expect(claim.status).toBe(200);
    expect(await claim.clone().json()).toMatchObject({ event: { dataRef: "r2://provider-message/1" } });
    expect((await call(`/events/${eventId}/claim`, "POST", { agentId: agent.id, consumerId: "naelao:run-2" })).status).toBe(409);
    expect((await call(`/events/${eventId}/ack`, "POST", { agentId: agent.id, consumerId: "wrong-run", result: "delivered" })).status).toBe(404);
    expect((await call(`/events/${eventId}/ack`, "POST", { agentId: agent.id, consumerId: "naelao:run-1", result: "delivered" })).status).toBe(200);
    const retry = await call("/events", "POST", { serviceId: "mail-provider", providerEventId: "provider-evt-1", eventType: "message.received" });
    expect((await retry.json() as { duplicate: boolean }).duplicate).toBe(true);
    db.close();
  });

  it("stores channel/thread references and trust events while leaving message content with the provider", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body?: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    await call("/services", "POST", { id: "chat-provider", name: "Chat Provider", type: "channel", accountModels: ["agent_native"], capabilities: ["channels", "messages.read", "messages.send"], events: ["message.received", "message.send_requested"], connectionPurpose: "agent_resource" });
    const agentResponse = await call("/agents", "POST", { principalId: "owner-1", principalType: "individual", createdBy: "owner-1", hostPlatform: "external" });
    const { agent } = await agentResponse.json() as { agent: { id: string } };
    const accountResponse = await call("/accounts", "POST", { serviceId: "chat-provider", accountModel: "agent_native", ownerType: "individual", ownerId: "owner-1" });
    const { account } = await accountResponse.json() as { account: { id: string } };
    await call(`/accounts/${account.id}/activate`, "POST", {});
    await call(`/accounts/${account.id}/grants`, "POST", { agentId: agent.id, grantedBy: "owner-1", permissions: ["channels.manage", "messages.read", "messages.send"] });
    const channelResponse = await call("/channels", "POST", { serviceId: "chat-provider", accountId: account.id, agentId: agent.id, providerChannelId: "external-channel-1", displayName: "Support" });
    expect(channelResponse.status).toBe(201);
    const { channel } = await channelResponse.json() as { channel: { id: string } };
    await call(`/channels/${channel.id}/trusted-senders`, "POST", { providerSenderId: "owner-handle", principalId: "owner-1", role: "owner", allowedActions: ["messages.send"] });
    const rejectedContent = await call(`/channels/${channel.id}/message-events/inbound`, "POST", { providerMessageId: "provider-msg-with-body", providerThreadId: "customer-1", senderId: "owner-handle", content: "Hello" });
    expect(rejectedContent.status).toBe(400);
    expect((await call("/events", "POST", { serviceId: "chat-provider", providerEventId: "body-event", eventType: "message.received", text: "Hello" })).status).toBe(400);
    const inbound = await call(`/channels/${channel.id}/message-events/inbound`, "POST", { providerMessageId: "provider-msg-1", providerThreadId: "customer-1", senderId: "owner-handle" });
    expect(inbound.status).toBe(202);
    expect(await inbound.json()).toMatchObject({ messageReference: { providerMessageId: "provider-msg-1", senderRole: "owner", trustLevel: "verified" }, contentLocation: "channel_provider" });
    const threadRows = db.prepare("SELECT id,session_binding_json FROM agentport_threads WHERE channel_id=?").all(channel.id) as Array<{ id: string; session_binding_json: string | null }>;
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0]?.session_binding_json).toBeNull();
    const externalInbound = await call(`/channels/${channel.id}/message-events/inbound`, "POST", { providerMessageId: "provider-msg-2", providerThreadId: "customer-1", senderId: "untrusted-user" });
    expect(externalInbound.status).toBe(202);
    expect(await externalInbound.json()).toMatchObject({ messageReference: { providerMessageId: "provider-msg-2", senderRole: "external", trustLevel: "unverified" }, contentLocation: "channel_provider" });
    const refs = await call(`/threads/${threadRows[0]!.id}/message-references?agentId=${agent.id}`, "GET");
    expect(refs.status).toBe(200);
    expect(await refs.json()).toMatchObject({ contentLocation: "channel_provider", messageReferences: expect.arrayContaining([expect.objectContaining({ providerMessageId: "provider-msg-1" })]) });
    const authorized = await call(`/threads/${threadRows[0]!.id}/actions/authorize`, "POST", { agentId: agent.id, action: "messages.send", idempotencyKey: "send-1" });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ decision: "allow", providerChannelId: "external-channel-1", providerThreadId: "customer-1", contentLocation: "channel_provider" });
    expect((await call(`/threads/${threadRows[0]!.id}/actions/authorize`, "POST", { agentId: agent.id, action: "messages.send", idempotencyKey: "send-with-body", text: "Hello" })).status).toBe(400);
    expect((await call(`/threads/${threadRows[0]!.id}/messages`, "GET")).status).toBe(404);
    db.prepare(`INSERT INTO agentport_messages(id,tenant_id,channel_id,thread_id,provider_message_id,direction,sender_id,sender_role,trust_level,content_text,content_ref,attachments_json,status,occurred_at,created_at)
      VALUES('legacy-msg-1','tenant-a',?,?,'legacy-provider-msg-1','inbound','owner-handle','owner','verified','old body','r2://old-content','["r2://old-file"]','received','2026-01-01','2026-01-01'),
      ('legacy-msg-2','tenant-a',?,?,'legacy-provider-msg-2','outbound','agent-a','provider','verified','queued body',NULL,'["r2://queued-file"]','queued','2026-01-01','2026-01-01')`)
      .run(channel.id, threadRows[0]!.id, channel.id, threadRows[0]!.id);
    db.exec(readFileSync(new URL("../../../../infra/migrations/0164_agentport_channel_message_refs.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../../../../infra/migrations/0166_drop_agentport_message_store.sql", import.meta.url), "utf8"));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agentport_messages'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agentport_channel_message_refs WHERE provider_message_id IS NOT NULL").get()).toMatchObject({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agentport_events WHERE event_type='message.received'").get()).toMatchObject({ n: 2 });
    expect(db.prepare("SELECT payload_ref FROM agentport_events WHERE event_type='message.received' AND provider_event_id='provider-msg-1'").get()).toMatchObject({ payload_ref: "provider-msg-1" });
    expect(db.prepare("SELECT sender_role,trust_level FROM agentport_channel_message_refs WHERE provider_message_id='provider-msg-1'").get()).toMatchObject({ sender_role: "owner", trust_level: "verified" });
  });

  it("blocks provider models the manifest did not declare and unresolved provisioning cycles", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, body: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
    await call("/services", { id: "svc", name: "Service", type: "api", accountModels: ["agent_native"], capabilities: [], events: [], connectionPurpose: "agent_resource" });
    expect((await call("/accounts", { serviceId: "svc", accountModel: "user_parent", ownerType: "organization", ownerId: "org", parentAccountId: "parent" })).status).toBe(422);
    const agentResponse = await call("/agents", { principalId: "org", principalType: "organization", createdBy: "user", hostPlatform: "naelao" });
    const { agent } = await agentResponse.json() as { agent: { id: string } };
    const accountIds: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const response = await call("/accounts", { serviceId: "svc", accountModel: "agent_native", ownerType: "organization", ownerId: name });
      accountIds.push(((await response.json()) as { account: { id: string } }).account.id);
      await call(`/accounts/${accountIds.at(-1)}/activate`, {});
    }
    await call(`/accounts/${accountIds[0]}/dependencies`, { dependsOnAccountId: accountIds[1], type: "provisioning" });
    await call(`/accounts/${accountIds[1]}/dependencies`, { dependsOnAccountId: accountIds[2], type: "provisioning" });
    const cycle = await call(`/accounts/${accountIds[2]}/dependencies`, { dependsOnAccountId: accountIds[0], type: "provisioning" });
    expect(cycle.status).toBe(409);
    expect((await cycle.json() as { error_code: string }).error_code).toBe("provisioning_dependency_cycle");
    expect(agent.id).toBeTruthy();
    db.close();
  });

  it("requires a live account grant before subscribing and dead-letters after eight claims", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers, body: JSON.stringify(body) }), env);
    await call("/services", "POST", { id: "svc", name: "Mail", type: "managed", accountModels: ["agent_native"], capabilities: [], events: ["message.received"], connectionPurpose: "agent_resource" });
    const { agent } = await (await call("/agents", "POST", { principalId: "owner", principalType: "individual", createdBy: "user", hostPlatform: "external" })).json() as { agent: { id: string } };
    const { account } = await (await call("/accounts", "POST", { serviceId: "svc", accountModel: "agent_native", ownerType: "individual", ownerId: "owner" })).json() as { account: { id: string } };
    await call(`/accounts/${account.id}/activate`, "POST", {});
    const denied = await call("/events/subscriptions", "POST", { agentId: agent.id, serviceId: "svc", accountId: account.id, eventType: "message.received", deliveryMode: "poll" });
    expect(denied.status).toBe(403);
    await call(`/accounts/${account.id}/grants`, "POST", { agentId: agent.id, grantedBy: "user", permissions: ["mail.read"] });
    expect((await call("/events/subscriptions", "POST", { agentId: agent.id, serviceId: "svc", accountId: account.id, eventType: "message.received", deliveryMode: "poll" })).status).toBe(201);
    const { id: eventId } = await (await call("/events", "POST", { serviceId: "svc", accountId: account.id, providerEventId: "evt", eventType: "message.received" })).json() as { id: string };
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect((await call(`/events/${eventId}/claim`, "POST", { agentId: agent.id, consumerId: `consumer-${attempt}` })).status).toBe(200);
      const ack = await call(`/events/${eventId}/ack`, "POST", { agentId: agent.id, consumerId: `consumer-${attempt}`, result: "retry" });
      const payload = await ack.json() as { status: string };
      if (attempt < 8) {
        expect(payload.status).toBe("pending");
        db.prepare("UPDATE agentport_event_deliveries SET available_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").run(eventId);
      } else expect(payload.status).toBe("dead_letter");
    }
    db.close();
  }, 30000);

  it("issues an audience-bound signed mandate only for the owning principal and supports revocation", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-role": "agentport_api", "x-agentport-owner-id": "owner-id", "x-agentport-owner-type": "individual" };
    const signingSecret = "agentport-test-signing-secret-which-is-long-enough-32";
    const env = { PLATFORM_SECRET: secret, AGENTPORT_JWT_SECRET: signingSecret, AGENTPORT_ISSUER: "https://issuer.example", PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body?: unknown, customHeaders = headers) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    const registration = await call("/agents", "POST", { principalId: "owner-id", principalType: "individual", createdBy: "owner-id", hostPlatform: "external" });
    expect(registration.status).toBe(201);
    const { agent } = await registration.json() as { agent: { id: string; identity: { publicJwk: JsonWebKey & { kid?: string; alg?: string } } } };
    const issuance = await call(`/agents/${agent.id}/credentials`, "POST", { audience: "https://service.example/api", actions: ["mail.send"], ttlSeconds: 500 });
    expect(issuance.status).toBe(201);
    const issued = await issuance.json() as { credential: string; jti: string };
    const verified = await verifyAgentCredentialLocal({ credential: issued.credential, audience: "https://service.example", trustedIssuer: "https://issuer.example", jwks: { keys: [agent.identity.publicJwk] } });
    expect(verified).toMatchObject({ valid: true, claims: { sub: agent.id, scope: ["mail.send"] } });
    const denied = await call(`/agents/${agent.id}/credentials`, "POST", { audience: "https://service.example", actions: ["mail.send"] }, { ...headers, "x-agentport-owner-id": "someone-else" });
    expect(denied.status).toBe(404);
    const revoked = await call(`/agents/${agent.id}/credentials/${issued.jti}/revoke`, "POST", {});
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(db.prepare("SELECT revoked_at FROM agentport_issued_credentials WHERE jti=?").get(issued.jti)).toMatchObject({ revoked_at: expect.any(String) });
    db.close();
  }, 30000);
});
