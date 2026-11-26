// MS-43: add-resource flow (resource-options, resource-quote, resource-provision) behind MANAGED_RESOURCES_PANEL_ENABLED.
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { provisionManagedResource } from "./managed-resource-add.js";
import { ProviderAdapterError, type ProviderAdapterV1, type ProvisionReq } from "./providers/contract.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";

const sql = (name: string) => readFileSync(new URL(`../../../../infra/migrations/${name}`, import.meta.url), "utf8");
const BASE = "/spaces/space/assistant-communications";
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

type Seed = { id: string; provider: string; rank: number; status?: string; regions?: string[]; components: unknown[]; modes?: string[]; strategies?: string[] };

function harness(plan = "growth") {
  const f = fixture();
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0292_managed_offering_testing_allowlist_and_telnyx_classification.sql",
    "0301_managed_service_subscriptions.sql", "0302_managed_service_offering_quotes.sql", "0158_agentport_registry.sql"]) f.db.db.exec(sql(name));
  f.db.db.exec("PRAGMA foreign_keys = OFF");
  f.db.db.prepare("UPDATE orgs SET plan_tier=? WHERE id='tenant'").run(plan);
  const billing: Array<{ action: string; body: Record<string, unknown> }> = [];
  const BILLING_WORKER = { fetch: async (request: Request) => {
    billing.push({ action: new URL(request.url).pathname.split("/").pop()!, body: await request.json() as Record<string, unknown> });
    return Response.json({ reservation_id: billing.at(-1)!.body.reservation_id, status: "held" });
  } } as unknown as Fetcher;
  Object.assign(f.env, { MANAGED_RESOURCES_PANEL_ENABLED: "true", MANAGED_OFFERINGS_ENABLED: "true", BILLING_WORKER });
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  const headers = async (user = "user") => ({ "x-naelao-tenant-id": "tenant", "x-naelao-user-id": user, "x-naelao-role": "product_end_user", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") });
  const get = async (query: string, user?: string) => app.request(`${BASE}?${query}`, { headers: await headers(user) }, f.env);
  const post = async (body: Record<string, unknown>, user?: string) =>
    app.request(BASE, { method: "POST", headers: { ...(await headers(user)), "content-type": "application/json" }, body: JSON.stringify(body) }, f.env);
  const seed = (o: Seed) => {
    const db = f.db.db;
    if (!db.prepare("SELECT 1 FROM managed_service_capability_versions WHERE provider=?").get(o.provider))
      db.prepare(`INSERT INTO managed_service_capability_versions(provider,service_id,version,category,status,operations_json,regions_json,account_modes_json,isolation_model,metering_json,
        verified_by,verified_at,valid_until,created_at,updated_at) VALUES(?,?,1,'email','verified','["provision"]','["us","eu"]','["naelao_managed","user_connected"]','x','{}','op','2026-01-01T00:00:00Z',?,1,1)`)
        .run(o.provider, o.provider, FUTURE);
    db.prepare(`INSERT INTO managed_service_offerings(id,provider,service_id,capability_version,resource_type,category,display_name,access_modes_json,strategies_json,regions_json,
      configuration_schema_json,charge_components_json,quote_policy,data_handling_json,preference_rank,status,created_at,updated_at)
      VALUES(?,?,?,1,'email_inbox','email',?,?,?,?,'{}',?,'required_for_recurring','{}',?,?,1,1)`)
      .run(o.id, o.provider, o.provider, `${o.provider} inbox`, JSON.stringify(o.modes ?? ["managed"]), JSON.stringify(o.strategies ?? ["managed_master"]),
        JSON.stringify(o.regions ?? ["us", "eu"]), JSON.stringify(o.components), o.rank, o.status ?? "available");
    db.prepare(`INSERT OR IGNORE INTO managed_service_commercial_agreements(id,provider,agreement_type,permitted_offering_ids_json,permits_managed_provisioning,permits_master_account_distribution,
      permits_subaccount_distribution,permits_shared_resources,permitted_regions_json,effective_from,verification_status,evidence_sha256,approved_by,approved_at,created_at,updated_at)
      VALUES(?,?,'reseller',?,1,1,0,0,'["*"]',1,'approved',?,'op',1,1,1)`).run(`ag-${o.provider}`, o.provider, JSON.stringify([o.id]), "a".repeat(64));
    db.prepare("UPDATE managed_service_commercial_agreements SET permitted_offering_ids_json=json_insert(permitted_offering_ids_json,'$[#]',?) WHERE provider=? AND permitted_offering_ids_json NOT LIKE ?")
      .run(o.id, o.provider, `%${o.id}%`);
  };
  const rental = (credits: number) => [{ kind: "setup", credits: 10 }, { kind: "rental", interval: "month", credits }];
  return { ...f, app, get, post, seed, rental, billing, db: f.db.db };
}

function seedStandard(h: ReturnType<typeof harness>) {
  h.seed({ id: "off-a", provider: "alpha", rank: 50, components: h.rental(200) });
  h.seed({ id: "off-b", provider: "beta", rank: 50, components: h.rental(100) });
  h.seed({ id: "off-c", provider: "gamma", rank: 10, status: "draft", components: h.rental(1) });
  h.seed({ id: "off-d", provider: "delta", rank: 5, regions: ["eu"], components: h.rental(1) });
  h.seed({ id: "off-e", provider: "epsilon", rank: 70, components: [{ kind: "usage", meter: "sends", included: 100, unit_credits_per: { qty: 1000, credits: 5 } }] });
}

describe("MS-43 resource options", () => {
  it("applies hard filters, then preference_rank, then minimum monthly price, and returns the reason", async () => {
    const h = harness(); seedStandard(h);
    const response = await h.get("action=resource-options&resource_type=email_inbox&access_mode=managed&region=us");
    expect(response.status).toBe(200);
    const body = await response.json() as { options: Array<Record<string, any>>; selectedOfferingId: string; reason: string; excluded: Record<string, number> };
    // c is a draft, d is eu only: both filtered. a and b tie on rank 50; b is cheaper. e (rank 70) is last.
    expect(body.options.map((o) => o.offeringId)).toEqual(["off-b", "off-a", "off-e"]);
    expect(body.selectedOfferingId).toBe("off-b");
    expect(body.reason).toContain("beta inbox");
    expect(body.reason).toContain("lowest minimum monthly cost (100 credits)");
    expect(body.excluded).toEqual({ plan: 0, unavailable: 2 });
    expect(body.options[0]).toMatchObject({ minMonthlyCredits: 100, initialCredits: 110, recurring: true });
    expect(JSON.stringify(body)).not.toMatch(/managed_master|strategy|provider_resource_ref/);
  });

  it("prefers the lower rank over a cheaper price", async () => {
    const h = harness();
    h.seed({ id: "off-a", provider: "alpha", rank: 10, components: h.rental(500) });
    h.seed({ id: "off-b", provider: "beta", rank: 20, components: h.rental(1) });
    const body = await (await h.get("action=resource-options&resource_type=email_inbox&region=us")).json() as { selectedOfferingId: string; reason: string };
    expect(body.selectedOfferingId).toBe("off-a");
    expect(body.reason).toContain("preferred option of 2");
  });

  it("filters by access mode: managed offerings are not Bring-your-own options", async () => {
    const h = harness(); seedStandard(h);
    h.seed({ id: "off-k", provider: "kappa", rank: 1, modes: ["byok"], strategies: ["customer_connection"], components: [] });
    const byok = await (await h.get("action=resource-options&resource_type=email_inbox&access_mode=byok&region=us")).json() as { options: Array<{ offeringId: string }> };
    expect(byok.options.map((o) => o.offeringId)).toEqual(["off-k"]);
    const managed = await (await h.get("action=resource-options&resource_type=email_inbox&access_mode=managed&region=us")).json() as { options: Array<{ offeringId: string }> };
    expect(managed.options.map((o) => o.offeringId)).not.toContain("off-k");
  });

  it("offers no recurring managed resource on Free and says why", async () => {
    const h = harness("free"); seedStandard(h);
    const body = await (await h.get("action=resource-options&resource_type=email_inbox&region=us")).json() as { options: Array<{ offeringId: string }>; excluded: Record<string, number> };
    expect(body.options.map((o) => o.offeringId)).toEqual(["off-e"]);
    expect(body.excluded.plan).toBe(2);
    const only = harness("free"); only.seed({ id: "off-a", provider: "alpha", rank: 1, components: only.rental(5) });
    const none = await (await only.get("action=resource-options&resource_type=email_inbox&region=us")).json() as { options: unknown[]; selectedOfferingId: null; reason: string };
    expect(none).toMatchObject({ options: [], selectedOfferingId: null, reason: "Recurring managed resources need a paid plan." });
  });
});

describe("MS-43 resource quote and provision", () => {
  it("shows every component and the minimum monthly cost, and Automatic picks the first option", async () => {
    const h = harness(); seedStandard(h);
    const response = await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" });
    expect(response.status).toBe(200);
    const body = await response.json() as { chosen: string; reason: string; quote: Record<string, any> };
    expect(body.chosen).toBe("automatic");
    expect(body.quote).toMatchObject({ offeringId: "off-b", minMonthlyCredits: 100, credits: 110, status: "quoted" });
    expect(body.quote.components).toEqual([{ kind: "setup", credits: 10 }, { kind: "rental", interval: "month", credits: 100 }]);
    expect(Date.parse(body.quote.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // Choosing a provider quotes that offering.
    const chosen = await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us", offering_id: "off-a" })).json() as { chosen: string; quote: { offeringId: string } };
    expect(chosen).toMatchObject({ chosen: "provider", quote: { offeringId: "off-a" } });
    // An offering that fails a hard filter cannot be quoted.
    const refused = await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us", offering_id: "off-c" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error_code: "offering_unavailable" });
  });

  it("refuses a recurring quote on Free", async () => {
    const h = harness("free"); h.seed({ id: "off-a", provider: "alpha", rank: 1, components: h.rental(5) });
    const response = await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "plan_not_eligible" });
  });

  it("does not quote a Bring-your-own connection (no adapter creates one)", async () => {
    const h = harness(); seedStandard(h);
    const response = await h.post({ action: "resource-quote", resource_type: "email_inbox", access_mode: "byok", region: "us" });
    expect(await response.json()).toEqual({ error_code: "capability_unsupported" });
  });

  it("passes spaceId and userId to the adapter with the Billing reservation, after approval of an unexpired quote", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us", local_part: "box" })).json() as { quote: { quoteId: string } }).quote;
    const seen: Array<{ req: ProvisionReq; op: { operation_id: string } }> = [];
    const adapter = { provider: "naelao", capabilities: () => [], lookup: async () => null, execute: async () => ({ operation: "x", data: null }),
      provision: async (req: ProvisionReq, op: { operation_id: string; idempotency_key: string }) => { seen.push({ req, op }); return { resource: { provider: "naelao", service_id: "naelao", resource_type: "email_inbox", provider_resource_ref: "inb_1", status: "active", address: "box@mail.test" }, offering_id: "off-n", capability_version: 1 }; } } as unknown as ProviderAdapterV1;
    const env = h.env as unknown as AgentsEnv;
    const result = await provisionManagedResource(env, { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" },
      { quoteId: quote.quoteId, offeringId: "off-n", region: "us", localPart: "box" }, { "naelao/naelao": adapter });
    expect(result).toMatchObject({ offeringId: "off-n", resource: { status: "active", address: "box@mail.test" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.req).toMatchObject({ tenantId: "tenant", spaceId: "space", userId: "user", offeringId: "off-n", region: "us", localPart: "box" });
    expect(seen[0]!.req.reservationId).toMatch(/:reserve$/);
    expect(h.billing.map((b) => b.action)).toEqual(["reserve", "settle"]);
    expect(h.billing[0]!.body).toMatchObject({ provider: "naelao", operation_name: "provision", credits: 110, payer_id: "tenant" });
    expect(h.db.prepare("SELECT status FROM managed_service_operations WHERE operation_id=?").get(result.operationId)).toEqual({ status: "complete" });
    // The quote is single use.
    await expect(provisionManagedResource(env, { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" },
      { quoteId: quote.quoteId, offeringId: "off-n", region: "us", localPart: "box" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "quote_already_used" });
    expect(seen).toHaveLength(1);
  });

  it("MS-47: registers the provisioned resource and an AgentPort account, so a named grant applies instead of deferring", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
    (h.env as unknown as { AGENTPORT_WORKER: Fetcher }).AGENTPORT_WORKER = { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace("/internal/agentport", "");
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : null;
      calls.push({ method: request.method, path, body });
      if (path === "/agents") return Response.json({ agent: { id: "agent-x" } }, { status: 201 });
      if (path === "/services") return Response.json({ service: { id: body?.id } }, { status: 201 });
      if (path.endsWith("/identity")) return Response.json({ identity: { principal: { id: "prn-org" } } });
      if (path === "/accounts") return Response.json({ account: { id: "acct-new", status: "pending" } }, { status: 201 });
      if (path.endsWith("/activate")) return Response.json({ account: { id: "acct-new", status: "active" } });
      return Response.json({ grant: { id: "grt" } }, { status: 201 });
    } } as unknown as Fetcher;
    const adapter = { provider: "naelao", capabilities: () => [], lookup: async () => null, execute: async () => ({ operation: "x", data: null }),
      provision: async () => ({ resource: { provider: "naelao", service_id: "naelao", resource_type: "email_inbox", provider_resource_ref: "inb_77", status: "active" as const, address: "box@mail.test" }, offering_id: "off-n", capability_version: 1 }) };
    const env = h.env as unknown as AgentsEnv;
    const scope = { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" as const };
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    const result = await provisionManagedResource(env, scope, { quoteId: quote.quoteId, offeringId: "off-n", region: "us" }, { "naelao/naelao": adapter });
    expect(result).toMatchObject({ agentPortLinked: true, resourceId: expect.stringMatching(/^msa_/) });
    expect(h.db.prepare(`SELECT provider_resource_ref,offering_id,access_mode,provisioning_strategy,tenant_id,space_id,agentport_account_id,agentport_link_status,lifecycle_state,resource_type
      FROM managed_service_accounts WHERE id=?`).get(result.resourceId)).toEqual({ provider_resource_ref: "inb_77", offering_id: "off-n", access_mode: "managed", provisioning_strategy: "first_party",
      tenant_id: "tenant", space_id: "space", agentport_account_id: "acct-new", agentport_link_status: "active", lifecycle_state: "active", resource_type: "email_inbox" });
    const account = calls.find((c) => c.path === "/accounts")!;
    expect(account.body).toMatchObject({ ownerType: "organization", ownerId: "tenant", externalAccountId: "inb_77", accountModel: "agent_native" });
    // No grant is made by registration itself.
    expect(calls.some((c) => c.path.endsWith("/grants"))).toBe(false);
    // The MS-44 grant now applies to the new resource.
    const db = h.db;
    const AT = new Date().toISOString();
    db.prepare("INSERT INTO agentport_principals(id,tenant_id,principal_type,external_id,created_at,updated_at) VALUES('prin-1','tenant','organization','tenant',?,?)").run(AT, AT);
    db.exec("ALTER TABLE agentport_agents ADD COLUMN host_resource_id TEXT");
    db.prepare(`INSERT INTO agentport_agents(id,tenant_id,principal_id,created_by,host_platform,host_resource_id,status,created_at,updated_at) VALUES('agent-1','tenant','prin-1','user','naelao','space-assistant:space','active',?,?)`).run(AT, AT);
    const granted = await h.post({ action: "resource-grant", resource_id: result.resourceId, agent_id: "agent-1", actions: ["email.send"] });
    expect(granted.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ path: "/accounts/acct-new/grants", body: { agentId: "agent-1", permissions: ["email.send"] } });
    // A replay of the registration reuses the row and the account.
    const { registerProvisionedResource } = await import("./managed-resource-registration.js");
    const again = await registerProvisionedResource(env, scope, { provider: "naelao", serviceId: "naelao", capabilityVersion: 1, offeringId: "off-n",
      resource: { provider: "naelao", service_id: "naelao", resource_type: "email_inbox", provider_resource_ref: "inb_77", status: "active" }, region: "us" });
    expect(again).toEqual({ resourceId: result.resourceId, agentPortAccountId: "acct-new" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM managed_service_accounts WHERE provider_resource_ref='inb_77'").get()).toEqual({ n: 1 });
  });

  it("MS-47: an AgentPort outage after the provider call keeps the resource, reports it unlinked and leaves grants deferred", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    (h.env as unknown as { AGENTPORT_WORKER: Fetcher }).AGENTPORT_WORKER = { fetch: async () => new Response("down", { status: 503 }) } as unknown as Fetcher;
    const adapter = { provider: "naelao", capabilities: () => [], lookup: async () => null, execute: async () => ({ operation: "x", data: null }),
      provision: async () => ({ resource: { provider: "naelao", service_id: "naelao", resource_type: "email_inbox", provider_resource_ref: "inb_78", status: "active" as const }, offering_id: "off-n", capability_version: 1 }) };
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    const result = await provisionManagedResource(h.env as unknown as AgentsEnv, { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" },
      { quoteId: quote.quoteId, offeringId: "off-n", region: "us" }, { "naelao/naelao": adapter });
    expect(result.agentPortLinked).toBe(false);
    expect(h.db.prepare("SELECT agentport_account_id FROM managed_service_accounts WHERE id=?").get(result.resourceId)).toEqual({ agentport_account_id: null });
  });

  it("refuses an expired quote without calling the adapter or Billing", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    h.db.prepare("UPDATE managed_service_operation_quotes SET expires_at=? WHERE quote_id=?").run(new Date(Date.now() - 1000).toISOString(), quote.quoteId);
    let called = 0;
    const adapter = { provider: "naelao", provision: async () => { called++; throw new Error("no"); } } as unknown as ProviderAdapterV1;
    await expect(provisionManagedResource(h.env as unknown as AgentsEnv, { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" },
      { quoteId: quote.quoteId, offeringId: "off-n", region: "us" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "quote_expired", status: 409 });
    expect(called).toBe(0);
    expect(h.billing).toHaveLength(0);
    const viaRoute = await h.post({ action: "resource-provision", quote_id: quote.quoteId, offering_id: "off-n", region: "us" });
    expect(viaRoute.status).toBe(501);
  });

  it("refuses a changed price and a binding mismatch", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    const adapter = { provider: "naelao", provision: async () => { throw new Error("must not run"); } } as unknown as ProviderAdapterV1;
    const scope = { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" };
    const env = h.env as unknown as AgentsEnv;
    await expect(provisionManagedResource(env, scope, { quoteId: quote.quoteId, offeringId: "off-n", region: "eu" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "quote_binding_mismatch" });
    await expect(provisionManagedResource(env, scope, { quoteId: quote.quoteId, offeringId: "off-n", region: "us", localPart: "other" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "quote_binding_mismatch" });
    await expect(provisionManagedResource(env, { ...scope, userId: "someone-else" }, { quoteId: quote.quoteId, offeringId: "off-n", region: "us" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "quote_not_found" });
    h.db.prepare("UPDATE managed_service_offerings SET charge_components_json=? WHERE id='off-n'").run(JSON.stringify(h.rental(150)));
    await expect(provisionManagedResource(env, scope, { quoteId: quote.quoteId, offeringId: "off-n", region: "us" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "quote_price_changed" });
  });

  it("refuses provision for a recurring offering when the plan is Free, even with a quote from a paid period", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    h.db.prepare("UPDATE orgs SET plan_tier='free' WHERE id='tenant'").run();
    const response = await h.post({ action: "resource-provision", quote_id: quote.quoteId, offering_id: "off-n", region: "us" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "plan_not_eligible" });
    expect(h.billing).toHaveLength(0);
  });

  it("answers capability_unsupported for a provider without an adapter and releases nothing it did not reserve", async () => {
    const h = harness(); h.seed({ id: "off-a", provider: "alpha", rank: 1, components: h.rental(100) });
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    const response = await h.post({ action: "resource-provision", quote_id: quote.quoteId, offering_id: "off-a", region: "us" });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error_code: "capability_unsupported" });
    expect(h.billing).toHaveLength(0);
    expect(h.db.prepare("SELECT status FROM managed_service_operation_quotes WHERE quote_id=?").get(quote.quoteId)).toEqual({ status: "quoted" });
  });

  it("marks an ambiguous provider outcome uncertain and keeps the hold", async () => {
    const h = harness(); h.seed({ id: "off-n", provider: "naelao", rank: 1, strategies: ["first_party"], components: h.rental(100) });
    h.db.prepare("UPDATE managed_service_commercial_agreements SET agreement_type='first_party' WHERE provider='naelao'").run();
    const quote = (await (await h.post({ action: "resource-quote", resource_type: "email_inbox", region: "us" })).json() as { quote: { quoteId: string } }).quote;
    const adapter = { provider: "naelao", provision: async () => { throw new ProviderAdapterError("outcome_unknown"); } } as unknown as ProviderAdapterV1;
    await expect(provisionManagedResource(h.env as unknown as AgentsEnv, { tenantId: "tenant", spaceId: "space", userId: "user", role: "owner" },
      { quoteId: quote.quoteId, offeringId: "off-n", region: "us" }, { "naelao/naelao": adapter })).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(h.billing.map((b) => b.action)).toEqual(["reserve", "uncertain"]);
    expect(h.db.prepare("SELECT status FROM managed_service_operations").get()).toEqual({ status: "uncertain" });
  });
});

describe("MS-43 route gating", () => {
  it("answers not-found for a non-owner, the flag off, and the wrong method on every action", async () => {
    const h = harness(); seedStandard(h);
    const queries = ["action=resource-options&resource_type=email_inbox&region=us"];
    for (const q of queries) {
      const member = await h.get(q, "other");
      expect(member.status).toBe(404);
      expect(await member.json()).toEqual({ error_code: "not_found" });
    }
    for (const body of [{ action: "resource-quote", resource_type: "email_inbox", region: "us" }, { action: "resource-provision", quote_id: `msq_${"a".repeat(32)}`, offering_id: "off-a", region: "us" }]) {
      const member = await h.post(body, "other");
      expect(member.status).toBe(404);
      expect(await member.json()).toEqual({ error_code: "not_found" });
    }
    expect((await h.get("action=resource-quote&resource_type=email_inbox")).status).toBe(404);
    (h.env as unknown as Record<string, string>).MANAGED_RESOURCES_PANEL_ENABLED = "false";
    expect((await h.get(queries[0]!)).status).toBe(404);
    expect((await h.post({ action: "resource-quote", resource_type: "email_inbox" })).status).toBe(404);
    expect(h.billing).toHaveLength(0);
  });

  it("rejects malformed input", async () => {
    const h = harness(); seedStandard(h);
    expect((await h.get("action=resource-options")).status).toBe(400);
    expect((await h.get("action=resource-options&resource_type=email_inbox&access_mode=weird")).status).toBe(400);
    expect((await h.post({ action: "resource-provision", quote_id: "nope", offering_id: "off-a", region: "us" })).status).toBe(400);
  });
});
