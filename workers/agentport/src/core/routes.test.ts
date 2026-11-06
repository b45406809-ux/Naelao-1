import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { verifyAgentCredentialLocal } from "./identity.js";
import { agentPortRoutes } from "./routes.js";
import { handleAgentPortEmail } from "../email.js";

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
  db.exec(readFileSync(new URL("../../../../infra/migrations/0168_agentport_client_neutral_host_resources.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0169_agentport_email_accounts.sql", import.meta.url), "utf8"));
  const platformDb = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async run() { const result = db.prepare(sql).run(...(values as never[])); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
      async first<T>() { return db.prepare(sql).get(...(values as never[])) as T | undefined; },
      async all<T>() { return { success: true, results: db.prepare(sql).all(...(values as never[])) as T[] }; },
    };
    return statement;
  }, async batch(statements: Array<{ run(): Promise<unknown> }>) { for (const statement of statements) await statement.run(); return []; } };
  return { db, platformDb };
}

describe("AgentPort internal registry API", () => {
  it("creates an idempotent platform-managed AgentPort principal only for a trusted host system", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const base = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (role: string) => agentPortRoutes.fetch(new Request("https://agentport.test/principals", {
      method: "POST", headers: { ...base, "x-agentport-actor-role": role }, body: JSON.stringify({ id: "prn-user:tenant-a:user-1", externalId: "user-1", organizationName: "Managed tenant" }),
    }), env);
    expect((await call("owner")).status).toBe(403);
    const created = await call("client_system");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ accountModel: "platform_managed", principal: { id: "prn-user:tenant-a:user-1", principal_type: "individual", external_id: "user-1" } });
    expect((await call("client_system")).status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agentport_principals WHERE tenant_id='tenant-a'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT name,owner_developer_id FROM agentport_organizations WHERE id='tenant-a'").get()).toEqual({ name: "Managed tenant", owner_developer_id: "platform-managed:tenant-a" });
    db.close();
  });

  it("requires an internal tenant token and registers services, agents, shared grants and durable events", async () => {
    const { db, platformDb } = fixture();
    const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body?: unknown, suppliedHeaders = headers) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, {
      method, headers: suppliedHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);

    const denied = await call("/services", "GET", undefined, { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": "invalid" });
    expect(denied.status).toBe(403);
    expect((await call("/apps", "GET")).status).toBe(404);
    const service = await call("/services", "POST", { id: "mail-provider", name: "Cloudflare Email", type: "managed", accountModels: ["agent_native"], capabilities: ["email.send", "email.read"], events: ["message.received"], connectionPurpose: "agent_resource", auth: { type: "provider_managed" }, billing: { model: "usage_reported" } });
    expect(service.status).toBe(201);
    expect(db.prepare("SELECT a.auth_json,s.billing_json FROM agentport_services s JOIN agentport_provider_auth a ON a.service_id=s.id WHERE s.id='mail-provider'").get()).toMatchObject({ auth_json: '{"type":"provider_managed"}', billing_json: '{"model":"usage_reported"}' });
    const agentResponse = await call("/agents", "POST", { principalId: "org-1", principalType: "organization", createdBy: "user-1", hostPlatform: "openclaw", hostResourceId: "resource-1" });
    const { agent } = await agentResponse.json() as { agent: { id: string } };
    expect(db.prepare("SELECT host_resource_id FROM agentport_agents WHERE id=?").get(agent.id)).toMatchObject({ host_resource_id: "resource-1" });
    const accountResponse = await call("/accounts", "POST", { serviceId: "mail-provider", accountModel: "agent_native", ownerType: "organization", ownerId: "org-1" });
    const { account } = await accountResponse.json() as { account: { id: string; status: string } };
    expect(account.status).toBe("pending");
    expect((await call(`/accounts/${account.id}/activate`, "POST")).status).toBe(200);
    const grant = await call(`/accounts/${account.id}/grants`, "POST", { agentId: agent.id, grantedBy: "user-1", permissions: ["email.read"] });
    expect(grant.status).toBe(201);
    const subscription = await call("/events/subscriptions", "POST", { agentId: agent.id, serviceId: "mail-provider", accountId: account.id, eventType: "message.received", deliveryMode: "poll", consumerGroup: "support" });
    expect(subscription.status).toBe(201);
    const accountMismatch = await call("/events", "POST", { serviceId: "mail-provider", accountId: "another-service-account", providerEventId: "provider-evt-mismatch", eventType: "message.received" });
    expect(accountMismatch.status).toBe(404);
    const event = await call("/events", "POST", { serviceId: "mail-provider", accountId: account.id, providerEventId: "provider-evt-1", eventType: "message.received", dataRef: "r2://provider-message/1" });
    expect(event.status).toBe(202);
    const { id: eventId } = await event.json() as { id: string };
    const pending = await call(`/events/pending?agentId=${agent.id}`, "GET");
    expect((await pending.json() as { events: unknown[] }).events).toHaveLength(1);
    expect((await (await call(`/events/pending?agentId=${agent.id}`, "GET")).json() as { events: Array<{ dataRef: string }> }).events[0]?.dataRef).toBe("r2://provider-message/1");
    const claim = await call(`/events/${eventId}/claim`, "POST", { agentId: agent.id, consumerId: "host:run-1", ttlSeconds: 60 });
    expect(claim.status).toBe(200);
    expect(await claim.clone().json()).toMatchObject({ event: { dataRef: "r2://provider-message/1" } });
    expect((await call(`/events/${eventId}/claim`, "POST", { agentId: agent.id, consumerId: "host:run-2" })).status).toBe(409);
    expect((await call(`/events/${eventId}/ack`, "POST", { agentId: agent.id, consumerId: "wrong-run", result: "delivered" })).status).toBe(404);
    expect((await call(`/events/${eventId}/ack`, "POST", { agentId: agent.id, consumerId: "host:run-1", result: "delivered" })).status).toBe(200);
    const retry = await call("/events", "POST", { serviceId: "mail-provider", providerEventId: "provider-evt-1", eventType: "message.received" });
    expect((await retry.json() as { duplicate: boolean }).duplicate).toBe(true);
    db.close();
  });

  it("stores channel/thread references and trust events while leaving message content with the provider", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a") };
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
    expect(db.prepare("SELECT COUNT(*) AS n FROM agentport_channel_message_refs WHERE provider_message_id IS NOT NULL").get()).toMatchObject({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agentport_events WHERE event_type='message.received'").get()).toMatchObject({ n: 2 });
    expect(db.prepare("SELECT payload_ref FROM agentport_events WHERE event_type='message.received' AND provider_event_id='provider-msg-1'").get()).toMatchObject({ payload_ref: "provider-msg-1" });
    expect(db.prepare("SELECT sender_role,trust_level FROM agentport_channel_message_refs WHERE provider_message_id='provider-msg-1'").get()).toMatchObject({ sender_role: "owner", trust_level: "verified" });
  });

  it("blocks provider models the manifest did not declare and unresolved provisioning cycles", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, body: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
    await call("/services", { id: "svc", name: "Service", type: "api", accountModels: ["agent_native"], capabilities: [], events: [], connectionPurpose: "agent_resource" });
    expect((await call("/accounts", { serviceId: "svc", accountModel: "user_parent", ownerType: "organization", ownerId: "org", parentAccountId: "parent" })).status).toBe(422);
    const agentResponse = await call("/agents", { principalId: "org", principalType: "organization", createdBy: "user", hostPlatform: "openclaw" });
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
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a") };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: platformDb } as never;
    const call = (path: string, method: string, body: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers, body: JSON.stringify(body) }), env);
    await call("/services", "POST", { id: "svc", name: "Mail", type: "managed", accountModels: ["agent_native"], capabilities: [], events: ["message.received"], connectionPurpose: "agent_resource" });
    const { agent } = await (await call("/agents", "POST", { principalId: "owner", principalType: "individual", createdBy: "user", hostPlatform: "external" })).json() as { agent: { id: string } };
    const { account } = await (await call("/accounts", "POST", { serviceId: "svc", accountModel: "agent_native", ownerType: "individual", ownerId: "owner" })).json() as { account: { id: string } };
    await call(`/accounts/${account.id}/activate`, "POST", {});
    const denied = await call("/events/subscriptions", "POST", { agentId: agent.id, serviceId: "svc", accountId: account.id, eventType: "message.received", deliveryMode: "poll" });
    expect(denied.status).toBe(403);
    expect((await call("/apps", "GET")).status).toBe(404);
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
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a"), "x-agentport-actor-role": "agentport_api", "x-agentport-owner-id": "owner-id", "x-agentport-owner-type": "individual" };
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

  it("provisions, sends, receives, idempotently tracks, and revokes content-free managed email accounts", async () => {
    const { db, platformDb } = fixture(); const secret = "test-platform-secret";
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "tenant-a", "x-agentport-internal-token": await mintInternalToken(secret, "tenant-a"), "x-agentport-actor-role": "agentport_api", "x-agentport-owner-id": "owner-1", "x-agentport-owner-type": "individual" };
    const send = vi.fn(async () => ({ messageId: "provider-send-1" }));
    const fetch = vi.fn().mockResolvedValueOnce(new Response("retry", { status: 503 })).mockResolvedValueOnce(new Response("accepted", { status: 202 }));
    const signingSecret = "agentport-test-signing-secret-which-is-long-enough-32";
    const configuredEnv = { PLATFORM_SECRET: secret, AGENTPORT_JWT_SECRET: signingSecret, AGENTPORT_ISSUER: "https://issuer.example", EMAIL: { send }, EMAIL_SENDING_DOMAIN: "mail.example.net", EMAIL_INGRESS_DOMAIN: "mail.example.net", EMAIL_PROVISIONING_ENABLED: "false", PLATFORM_DB: platformDb };
    const env = configuredEnv as never;
    const call = (path: string, method: string, body?: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    const registration = await call("/agents", "POST", { principalId: "owner-1", principalType: "individual", createdBy: "owner-1", hostPlatform: "external" });
    const { agent } = await registration.json() as { agent: { id: string } };
    expect((await call("/email/accounts", "POST", { agentId: agent.id, inboundWebhookUrl: "https://hooks.builder.com/mail", idempotencyKey: "disabled-1" })).status).toBe(503);
    configuredEnv.EMAIL_PROVISIONING_ENABLED = "true";
    const provision = await call("/email/accounts", "POST", { agentId: agent.id, inboundWebhookUrl: "https://hooks.builder.com/mail", idempotencyKey: "provision-1" });
    expect(provision.status).toBe(201);
    const created = await provision.json() as { account: { id: string; address: string }; channel: { id: string }; webhookSecret: string; contentStored: boolean };
    expect(created).toMatchObject({ account: { status: "active", address: expect.stringMatching(/^agent-[a-f0-9]+@mail\.example\.net$/) }, channel: { id: expect.stringMatching(/^chn_/) }, webhookSecret: expect.any(String), contentStored: false });
    const repeatedProvision = await call("/email/accounts", "POST", { agentId: agent.id, inboundWebhookUrl: "https://hooks.builder.com/mail", idempotencyKey: "provision-1" });
    expect(repeatedProvision.status).toBe(200);
    expect(await repeatedProvision.json()).toMatchObject({ webhookSecret: created.webhookSecret, idempotent: true });
    const emailSubscription = await call("/events/subscriptions", "POST", { agentId: agent.id, serviceId: "ap_email:tenant-a", accountId: created.account.id, eventType: "message.received", deliveryMode: "poll", consumerGroup: "naelao-wakeup" });
    expect(emailSubscription.status).toBe(201);
    const sendBody = { agentId: agent.id, to: "customer@example.org", subject: "A private subject", text: "Do not persist this body", idempotencyKey: "send-1" };
    const firstSend = await call(`/email/accounts/${created.account.id}/send`, "POST", sendBody);
    expect(firstSend.status).toBe(202);
    expect(await firstSend.json()).toMatchObject({ send: { status: "sent", providerMessageId: "provider-send-1" }, contentStored: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ from: created.account.address, to: sendBody.to, subject: sendBody.subject, text: sendBody.text });
    expect((await call(`/email/accounts/${created.account.id}/send`, "POST", sendBody)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const sendColumns = db.prepare("PRAGMA table_info(agentport_email_sends)").all() as Array<{ name: string }>;
    expect(sendColumns.map(column => column.name)).not.toEqual(expect.arrayContaining(["to", "subject", "text", "body", "attachments"]));
    const raw = new TextEncoder().encode("From: sender@example.org\r\nSubject: private inbound\r\n\r\nprivate body");
    const message = { from: "sender@example.org", to: created.account.address, rawSize: raw.byteLength, raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }), headers: new Headers({ "message-id": "provider-inbound-1" }), setReject: vi.fn() } as unknown as ForwardableEmailMessage;
    await handleAgentPortEmail(message, { PLATFORM_DB: platformDb as never, AGENTPORT_JWT_SECRET: signingSecret, EMAIL_INGRESS_DOMAIN: "mail.example.net", EMAIL_PROVISIONING_ENABLED: "true", fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    const callback = fetch.mock.calls[1]![1] as RequestInit;
    expect(callback.headers).toMatchObject({ "content-type": "message/rfc822", "x-agentport-account-id": created.account.id, "x-agentport-event-id": "provider-inbound-1" });
    expect(new TextDecoder().decode(callback.body as Uint8Array)).toBe(new TextDecoder().decode(raw));
    expect(message.setReject).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM agentport_channels WHERE account_id=? AND status='active'").get(created.account.id)).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agentport_channel_message_refs WHERE channel_id=? AND provider_message_id='provider-inbound-1'").get(created.channel.id)).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT event_type,payload_ref FROM agentport_events WHERE account_id=? AND provider_event_id='provider-inbound-1'").get(created.account.id)).toMatchObject({ event_type: "message.received", payload_ref: "provider-inbound-1" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agentport_event_deliveries WHERE agent_id=?").get(agent.id)).toMatchObject({ count: 1 });
    for (let index = 0; index < 9; index++) {
      const fakeId = `quota_acct_${index}`; const at = new Date().toISOString();
      db.prepare(`INSERT INTO agentport_accounts(id,tenant_id,service_id,account_model,owner_type,owner_id,metadata_json,status,created_at,updated_at)
        VALUES(?,?,'ap_email:tenant-a','agent_native','individual','owner-1','{}','active',?,?)`).run(fakeId, "tenant-a", at, at);
      db.prepare(`INSERT INTO agentport_email_accounts(account_id,tenant_id,agent_id,address,inbound_webhook_url,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,'https://hooks.builder.com/mail',?,?,?)`).run(fakeId, "tenant-a", agent.id, `quota-${index}@mail.example.net`, `quota-${index}`, at, at);
    }
    expect((await call("/email/accounts", "POST", { agentId: agent.id, inboundWebhookUrl: "https://hooks.builder.com/mail", idempotencyKey: "provision-over-limit" })).status).toBe(429);
    const revoked = await call(`/email/accounts/${created.account.id}/revoke`, "POST", {});
    expect(await revoked.json()).toMatchObject({ revoked: true });
    const rejectedMessage = { ...message, raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }), setReject: vi.fn() } as unknown as ForwardableEmailMessage;
    await handleAgentPortEmail(rejectedMessage, { PLATFORM_DB: platformDb as never, AGENTPORT_JWT_SECRET: signingSecret, EMAIL_INGRESS_DOMAIN: "mail.example.net", EMAIL_PROVISIONING_ENABLED: "true", fetch });
    expect(rejectedMessage.setReject).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT status FROM agentport_accounts WHERE id=?").get(created.account.id)).toMatchObject({ status: "revoked" });
    db.close();
  });
});
