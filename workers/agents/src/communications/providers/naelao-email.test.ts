// MS-35: Naelao Email adapter, plus the local end-to-end proof that one inbox can be created (a) directly through the Naelao Email
// API, (b) through AgentPort /email/accounts and (c) through the Agents adapter after offering admission and a Billing reservation.
// Everything is local: the NAELAO_EMAIL "service binding" is the real Naelao Email Hono app over an in-memory SQLite database, the
// Billing worker is a recording fake, and no network is used.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import emailApp from "../../../../email/src/index.js";
import { call as emailCall, createInbox, fixture as emailFixture, seedTenant, SECRET, type Fixture as EmailFixture } from "../../../../email/src/test-helpers.js";
import { agentPortRoutes } from "../../../../agentport/src/core/routes.js";
import { fixture as commsFixture, scope } from "../../../../../tests/fixtures/assistant-communications.js";
import { reserveManagedServiceCredits } from "../managed-service-billing.js";
import type { AgentsEnv } from "../../index.js";
import { createNaelaoEmailAdapter, NAELAO_EMAIL_OPERATIONS, redactSecrets } from "./naelao-email.js";
import { ProviderAdapterError } from "./contract.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const migration = (name: string) => readFileSync(new URL(`../../../../../infra/migrations/${name}`, import.meta.url), "utf8");
const SEED = readFileSync(new URL("../../../../../docs/operations/managed-offerings-seed.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-26T12:00:00Z");

/** The `NAELAO_EMAIL` service binding: the real Naelao Email app, counting every request it receives. */
function emailBinding(f: EmailFixture) {
  const seen: Array<{ method: string; path: string }> = [];
  return { seen, binding: { fetch: async (request: Request) => { const u = new URL(request.url); seen.push({ method: request.method, path: u.pathname }); return emailApp.fetch(request, f.env as never); } } as unknown as Fetcher };
}

function agentPortFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE agentport_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_developer_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,created_by TEXT)");
  db.exec("CREATE TABLE agent_email_addresses(address_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE project_agent_email_addresses(address_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)");
  for (const m of ["0158_agentport_registry", "0161_agentport_channels_threads", "0162_agentport_signed_identity", "0163_agentport_provider_auth", "0164_agentport_channel_message_refs",
    "0229_agentport_sender_principal_refs", "0167_agentport_apps_capabilities", "0168_agentport_client_neutral_host_resources", "0169_agentport_email_accounts",
    "0171_agentport_event_notifications", "0299_agentport_naelao_email_link"]) db.exec(migration(`${m}.sql`));
  const platformDb = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async run() { const result = db.prepare(sql).run(...(values as never[])); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
      async first<T>() { return db.prepare(sql).get(...(values as never[])) as T | undefined; },
      async all<T>() { return { success: true, results: db.prepare(sql).all(...(values as never[])) as T[] }; },
    };
    return statement;
  }, async batch(statements: Array<{ run(): Promise<unknown> }>) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; } };
  return { db, platformDb };
}

/** Agents environment with the MS-28 tables, the MS-35 key table and the operator seed applied (all rows draft/unverified). */
function agentsHarness(email: EmailFixture, flag = "true") {
  const f = commsFixture();
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0292_managed_offering_testing_allowlist_and_telnyx_classification.sql", "0300_managed_naelao_email_tenants.sql"]) f.db.db.exec(migration(name));
  f.db.db.exec(SEED);
  const billing: Array<{ action: string; body: Record<string, unknown> }> = [];
  const BILLING_WORKER = { fetch: async (request: Request) => {
    billing.push({ action: new URL(request.url).pathname.split("/").pop()!, body: await request.json() as Record<string, unknown> });
    return Response.json({ reservation_id: billing.at(-1)!.body.reservation_id, status: "held" }, { status: 200 });
  } } as unknown as Fetcher;
  const bound = emailBinding(email);
  const env = Object.assign(f.env, { PLATFORM_SECRET: SECRET, MANAGED_OFFERINGS_ENABLED: flag, NAELAO_EMAIL: bound.binding, BILLING_WORKER }) as unknown as AgentsEnv;
  const sql = f.db.db;
  /** What an operator does: verify the capability version, approve the agreement, admit the tenant to the testing offering. */
  const operatorApproves = (tenantIds: string[] = [scope.tenantId]) => {
    sql.prepare("UPDATE managed_service_capability_versions SET status='verified',verified_by='op-1',verified_at='2026-11-26T00:00:00Z',valid_until=?,evidence_json=? WHERE provider='naelao' AND service_id='email' AND version=1")
      .run(new Date(NOW + 30 * 86_400_000).toISOString(), '[{"url":"https://example.test/evidence","checkedAt":"2026-11-26T00:00:00Z"}]');
    sql.prepare("UPDATE managed_service_commercial_agreements SET verification_status='approved',approved_by='op-1',approved_at=1795651200000,evidence_sha256=? WHERE id='agreement-naelao-email-first-party'").run("a".repeat(64));
    sql.prepare("UPDATE managed_service_offerings SET testing_tenant_ids_json=? WHERE id='off_naelao_email_inbox_v1'").run(JSON.stringify(tenantIds));
  };
  return { ...f, env, sql, billing, seen: bound.seen, operatorApproves, adapter: createNaelaoEmailAdapter(env, () => new Date(NOW)) };
}

const op = (n: number) => ({ operation_id: `op-${n}`, idempotency_key: `idem-${n}` });
const REQ = { tenantId: scope.tenantId, region: "global", reservationId: "res-1" };

describe("Naelao Email seed rows (docs/operations/managed-offerings-seed.sql)", () => {
  it("insert the offering as testing, the agreement as unverified and the capability as draft, with the OD-3 charge components", () => {
    const h = agentsHarness(emailFixture());
    const offering = h.sql.prepare("SELECT status,quote_policy,strategies_json,charge_components_json,testing_tenant_ids_json,capability_version FROM managed_service_offerings WHERE id='off_naelao_email_inbox_v1'").get() as Record<string, string | number>;
    expect(offering).toMatchObject({ status: "testing", quote_policy: "required_for_recurring", strategies_json: '["first_party"]', testing_tenant_ids_json: "[]", capability_version: 1 });
    expect(JSON.parse(offering.charge_components_json as string)).toEqual([
      { kind: "rental", interval: "month", credits: 100, included_sends: 1000 },
      { kind: "usage", meter: "email.message.sent", included: 1000, unit_credits_per: { qty: 1000, credits: 10 } },
    ]);
    expect(h.sql.prepare("SELECT agreement_type,verification_status,approved_by FROM managed_service_commercial_agreements WHERE id='agreement-naelao-email-first-party'").get()).toMatchObject({ agreement_type: "first_party", verification_status: "unverified", approved_by: null });
    expect(h.sql.prepare("SELECT status,verified_by FROM managed_service_capability_versions WHERE provider='naelao' AND service_id='email'").get()).toMatchObject({ status: "draft", verified_by: null });
    // Re-running the seed changes nothing.
    h.sql.exec(SEED);
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_offerings WHERE id='off_naelao_email_inbox_v1'").get()).toEqual({ n: 1 });
  });
});

describe("Naelao Email adapter contract", () => {
  it("lists exactly the capability operations the seeded capability version declares", () => {
    const h = agentsHarness(emailFixture());
    expect(h.adapter.capabilities().map(c => c.operation)).toEqual([...NAELAO_EMAIL_OPERATIONS]);
    const declared = JSON.parse((h.sql.prepare("SELECT operations_json FROM managed_service_capability_versions WHERE provider='naelao' AND service_id='email'").get() as { operations_json: string }).operations_json) as string[];
    expect(declared).toEqual(h.adapter.capabilities().map(c => c.operation));
  });

  it("fails closed with the flag off or the binding missing, before any upstream call", async () => {
    const email = emailFixture();
    const off = agentsHarness(email, "false");
    off.operatorApproves();
    await expect(off.adapter.provision!(REQ, op(1))).rejects.toMatchObject({ code: "offering_unavailable" });
    await expect(off.adapter.lookup({ tenantId: scope.tenantId, provider_resource_ref: "inb_x" })).rejects.toMatchObject({ code: "offering_unavailable" });
    await expect(off.adapter.execute({ tenantId: scope.tenantId, operation: "send", provider_resource_ref: "inb_x", params: {} }, op(2))).rejects.toMatchObject({ code: "offering_unavailable" });
    expect(off.seen).toHaveLength(0);
    const on = agentsHarness(email);
    const noBinding = createNaelaoEmailAdapter({ ...on.env, NAELAO_EMAIL: undefined } as never);
    await expect(noBinding.provision!(REQ, op(3))).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("throws capability_unsupported for every operation outside send and read, and never succeeds silently", async () => {
    const h = agentsHarness(emailFixture());
    for (const operation of ["search", "threads", "attachments", "renew", "suspend", "forward", ""]) {
      await expect(h.adapter.execute({ tenantId: scope.tenantId, operation, provider_resource_ref: "inb_x" }, op(4))).rejects.toMatchObject({ code: "capability_unsupported" });
    }
    expect(h.seen).toHaveLength(0);
    expect("suspend" in h.adapter).toBe(false);
  });

  it("requires a reservation and an operation context", async () => {
    const h = agentsHarness(emailFixture());
    h.operatorApproves();
    await expect(h.adapter.provision!({ ...REQ, reservationId: "" }, op(5))).rejects.toMatchObject({ code: "reservation_required" });
    await expect(h.adapter.provision!(REQ, { operation_id: "", idempotency_key: "" })).rejects.toMatchObject({ code: "invalid_operation_context" });
    expect(h.seen).toHaveLength(0);
  });

  it("redacts keys, webhook secrets and bearer values from error text", async () => {
    expect(redactSecrets(`bad nem_${"a".repeat(30)} and whsec_${"b".repeat(30)} Bearer abc.def`)).toBe("bad [redacted] and [redacted] Bearer [redacted]");
    const email = emailFixture();
    const h = agentsHarness(email);
    h.operatorApproves();
    const key = `nem_${"z".repeat(40)}`;
    // An upstream that echoes the credential in its error message must not leak it through the adapter error.
    const leaky = createNaelaoEmailAdapter({ ...h.env, NAELAO_EMAIL: { fetch: async (r: Request) => new URL(r.url).pathname === "/internal/v1/tenants"
      ? Response.json({ data: { api_key: key } }, { status: 201 })
      : Response.json({ error_code: "domain_not_available", message: `rejected ${key}` }, { status: 400 }) } } as never, () => new Date(NOW));
    const error = await leaky.provision!(REQ, op(6)).catch(e => e as ProviderAdapterError);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain("naelao_email_domain_not_available");
    // The stored envelope never contains the plaintext key.
    expect(JSON.stringify(h.sql.prepare("SELECT * FROM managed_naelao_email_tenants").all())).not.toContain(key);
  });

  it("treats a transport failure on create as outcome_unknown and never retries it", async () => {
    const email = emailFixture();
    email.db.prepare("INSERT INTO orgs(id) VALUES(?)").run(scope.tenantId);
    const h = agentsHarness(email);
    h.operatorApproves();
    let creates = 0;
    const flaky = createNaelaoEmailAdapter({ ...h.env, NAELAO_EMAIL: { fetch: async (r: Request) => {
      const path = new URL(r.url).pathname;
      if (path === "/internal/v1/tenants") return emailApp.fetch(r, email.env as never);
      creates++; throw new Error("socket closed");
    } } } as never, () => new Date(NOW));
    await expect(flaky.provision!(REQ, op(7))).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(creates).toBe(1);
  });
});

describe("one Naelao Email inbox, three ways (local, mocked bindings)", () => {
  it("(a) directly through the Naelao Email API", async () => {
    const f = emailFixture();
    const key = await seedTenant(f, "direct-tenant");
    const res = await emailCall(f, "POST", "/v1/inboxes", key, { local_part: "direct-box" }, { "idempotency-key": "k-1" });
    expect(res.status).toBe(201);
    expect(f.db.prepare("SELECT address,status FROM nemail_inboxes WHERE nemail_tenant_id='direct-tenant'").all()).toEqual([{ address: "direct-box@mail.naelao.test", status: "active" }]);
  });

  it("(b) through AgentPort /email/accounts over the NAELAO_EMAIL binding", async () => {
    const email = emailFixture();
    const { db, platformDb } = agentPortFixture();
    const bound = emailBinding(email);
    const env = { PLATFORM_SECRET: SECRET, AGENTPORT_JWT_SECRET: "agentport-test-signing-secret-which-is-long-enough-32", AGENTPORT_ISSUER: "https://issuer.example", NAELAO_EMAIL: bound.binding, EMAIL_PROVISIONING_ENABLED: "true", PLATFORM_DB: platformDb } as never;
    const headers = { "content-type": "application/json", "x-agentport-tenant-id": "ap-tenant", "x-agentport-internal-token": await mintInternalToken(SECRET, "ap-tenant"), "x-agentport-actor-role": "agentport_api", "x-agentport-owner-id": "owner-1", "x-agentport-owner-type": "individual" };
    const ap = (path: string, body: unknown) => agentPortRoutes.fetch(new Request(`https://agentport.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
    const { agent } = await (await ap("/agents", { principalId: "owner-1", principalType: "individual", createdBy: "owner-1", hostPlatform: "external" })).json() as { agent: { id: string } };
    const res = await ap("/email/accounts", { agentId: agent.id, inboundWebhookUrl: "https://hooks.builder.com/mail", idempotencyKey: "provision-1" });
    expect(res.status).toBe(201);
    const created = await res.json() as { account: { id: string; address: string }; webhookSecret: string };
    // The inbox, the tenant and the inbox-scoped webhook all exist in Naelao Email, under the AgentPort tenant's own tenant id.
    expect(email.db.prepare("SELECT nemail_tenant_id,address,status FROM nemail_inboxes").all()).toEqual([{ nemail_tenant_id: "agentport-ap-tenant", address: created.account.address, status: "active" }]);
    expect(email.db.prepare("SELECT url,inbox_id IS NOT NULL AS scoped FROM nemail_webhooks WHERE status='active'").all()).toEqual([{ url: "https://hooks.builder.com/mail", scoped: 1 }]);
    expect(created.webhookSecret).toMatch(/^whsec_/);
    const sent = await ap(`/email/accounts/${created.account.id}/send`, { agentId: agent.id, to: "customer@example.org", subject: "Hello", text: "Body", idempotencyKey: "send-1" });
    expect(sent.status).toBe(202);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ from: created.account.address, to: "customer@example.org" });
    expect(email.db.prepare("SELECT meter FROM nemail_usage").all()).toEqual([{ meter: "email.message.sent" }]);
    // The tenant key lives only as sealed ciphertext on the AgentPort side.
    expect(JSON.stringify(db.prepare("SELECT * FROM agentport_naelao_email_tenants").all())).not.toMatch(/nem_/);
  });

  it("(c) through the Agents adapter after offering admission and a Billing reservation", async () => {
    const email = emailFixture();
    email.db.prepare("INSERT INTO orgs(id) VALUES(?)").run(scope.tenantId);
    const h = agentsHarness(email);
    h.operatorApproves();
    // Reservation first (Billing is a recording fake here; the reserve route's own admission is covered by the billing suite).
    await reserveManagedServiceCredits(h.env, scope, { reservationId: "res-naelao-1", operationId: "op-1", provider: "naelao", serviceId: "email", operationName: "provision", region: "global", credits: 100, priceVersion: "off_naelao_email_inbox_v1:1" });
    expect(h.billing).toHaveLength(1);
    expect(h.billing[0]!.body).toMatchObject({ provider: "naelao", service_id: "email", operation_name: "provision", credits: 100, payer_id: scope.tenantId });
    const result = await h.adapter.provision!({ ...REQ, reservationId: "res-naelao-1", localPart: "managed-box" }, op(10));
    expect(result).toMatchObject({ offering_id: "off_naelao_email_inbox_v1", capability_version: 1, resource: { provider: "naelao", service_id: "email", status: "active", address: "managed-box@mail.naelao.test" } });
    expect(email.db.prepare("SELECT nemail_tenant_id,address FROM nemail_inboxes").all()).toEqual([{ nemail_tenant_id: `naelao-${scope.tenantId}`, address: "managed-box@mail.naelao.test" }]);
    expect(email.db.prepare("SELECT org_id FROM nemail_tenants WHERE id=?").get(`naelao-${scope.tenantId}`)).toEqual({ org_id: scope.tenantId });
    // The key is sealed, and a second call reuses it (one tenant creation only).
    expect(h.sql.prepare("SELECT key_envelope_json FROM managed_naelao_email_tenants").all()).toHaveLength(1);
    const ref = result.resource.provider_resource_ref;
    // A replay with the same idempotency key returns the same inbox and creates nothing new.
    expect((await h.adapter.provision!({ ...REQ, reservationId: "res-naelao-1", localPart: "managed-box" }, op(10))).resource.provider_resource_ref).toBe(ref);
    expect(email.db.prepare("SELECT COUNT(*) AS n FROM nemail_inboxes").get()).toEqual({ n: 1 });
    expect(h.seen.filter(r => r.path === "/internal/v1/tenants")).toHaveLength(1);
    expect(await h.adapter.lookup({ tenantId: scope.tenantId, provider_resource_ref: ref })).toMatchObject({ provider_resource_ref: ref, address: "managed-box@mail.naelao.test" });
    expect(await h.adapter.lookup({ tenantId: scope.tenantId, provider_resource_ref: "inb_missing" })).toBeNull();
    const sent = await h.adapter.execute({ tenantId: scope.tenantId, operation: "send", provider_resource_ref: ref, params: { to: ["customer@example.org"], subject: "Hi", text: "Body" } }, op(11));
    expect(sent).toMatchObject({ operation: "send", data: { status: "sent" } });
    expect(email.sent).toHaveLength(1);
    const read = await h.adapter.execute({ tenantId: scope.tenantId, operation: "read", provider_resource_ref: ref, params: { limit: 10 } }, op(12));
    expect((read.data as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);
    await h.adapter.deprovision!({ tenantId: scope.tenantId, provider_resource_ref: ref }, op(13));
    expect(await h.adapter.lookup({ tenantId: scope.tenantId, provider_resource_ref: ref })).toBeNull();
    await h.adapter.deprovision!({ tenantId: scope.tenantId, provider_resource_ref: ref }, op(14));
  });

  it("(c, refused) admission refuses an unapproved tenant, an unverified agreement and an unverified capability, with no upstream call", async () => {
    const email = emailFixture();
    const h = agentsHarness(email);
    // Nothing approved yet: the capability version is still a draft.
    await expect(h.adapter.provision!(REQ, op(20))).rejects.toMatchObject({ code: "offering_unavailable" });
    h.operatorApproves(["some-other-tenant"]);
    await expect(h.adapter.provision!(REQ, op(21))).rejects.toMatchObject({ code: "offering_unavailable" });
    h.operatorApproves();
    h.sql.prepare("UPDATE managed_service_commercial_agreements SET verification_status='unverified' WHERE id='agreement-naelao-email-first-party'").run();
    await expect(h.adapter.provision!(REQ, op(22))).rejects.toMatchObject({ code: "provider_not_approved" });
    h.operatorApproves();
    h.sql.prepare("UPDATE managed_service_capability_versions SET status='draft' WHERE provider='naelao'").run();
    await expect(h.adapter.provision!(REQ, op(23))).rejects.toMatchObject({ code: "capability_unsupported" });
    h.operatorApproves();
    await expect(h.adapter.provision!({ ...REQ, region: "us" }, op(24))).rejects.toMatchObject({ code: "offering_unavailable" });
    expect(h.seen).toHaveLength(0);
    expect(email.db.prepare("SELECT COUNT(*) AS n FROM nemail_inboxes").get()).toEqual({ n: 0 });
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_naelao_email_tenants").get()).toEqual({ n: 0 });
    // Once everything is approved the same call succeeds.
    email.db.prepare("INSERT INTO orgs(id) VALUES(?)").run(scope.tenantId);
    await expect(h.adapter.provision!(REQ, op(25))).resolves.toMatchObject({ resource: { status: "active" } });
  });
});
