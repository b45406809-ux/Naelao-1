import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import type { AgentsEnv } from "../index.js";
import { registerCommunicationRoutes } from "./routes.js";
import { managedResourcesPanelEnabled } from "./managed-resources.js";
import { fixture } from "../../../../tests/fixtures/assistant-communications.js";

const sql = (name: string) => readFileSync(new URL(`../../../../infra/migrations/${name}`, import.meta.url), "utf8");
const AT = new Date().toISOString();
const NOW = Date.now();
const PATH = "/spaces/space/assistant-communications?action=managed-resources";

function harness(flag: string | null = "true") {
  const f = fixture();
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0301_managed_service_subscriptions.sql", "0158_agentport_registry.sql"]) f.db.db.exec(sql(name));
  f.db.db.exec("PRAGMA foreign_keys = OFF");
  const app = new Hono<{ Bindings: AgentsEnv }>();
  registerCommunicationRoutes(app);
  if (flag !== null) (f.env as unknown as Record<string, string>).MANAGED_RESOURCES_PANEL_ENABLED = flag;
  const headers = async (user = "user", role = "product_end_user", tenant = "tenant") =>
    ({ "x-naelao-tenant-id": tenant, "x-naelao-user-id": user, "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken("secret", tenant) });
  const get = async (path = PATH, h?: Record<string, string>) => app.request(path, { headers: h ?? await headers() }, f.env);
  const db = f.db.db;
  const insertAccount = (id: string, extra: { tenant?: string; space?: string; mode?: string; account?: string | null; offering?: string | null; state?: string; sub?: string | null } = {}) =>
    db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,credential_ref,
      agentport_account_id,owner_type,owner_id,provider_payer_type,lifecycle_state,created_at,updated_at,offering_id,subscription_id,
      provisioning_strategy,access_mode,display_name)
      VALUES(?,?,?,'agentmail','agentmail',?,'secret-provider-ref','vault-credential-ref',?,'user','user','user',?,?,?,?,?,'managed_master',?,'Support inbox')`)
      .run(id, extra.tenant ?? "tenant", extra.space ?? "space", extra.mode ?? "naelao_managed", extra.account ?? null, extra.state ?? "active", AT, AT,
        extra.offering ?? null, extra.sub ?? null, (extra.mode ?? "naelao_managed") === "user_connected" ? "byok" : "managed");
  return { ...f, app, headers, get, db, insertAccount };
}

function seedManaged(h: ReturnType<typeof harness>) {
  h.db.exec("INSERT INTO managed_service_capability_versions(provider,service_id,version,category,status,operations_json,regions_json,account_modes_json,isolation_model,metering_json,created_at,updated_at) SELECT 'agentmail','agentmail',1,'email','verified','[]','[]','[]','x','{}',1,1 WHERE NOT EXISTS(SELECT 1 FROM managed_service_capability_versions WHERE provider='agentmail')");
  h.db.prepare(`INSERT INTO managed_service_offerings(id,provider,service_id,capability_version,resource_type,category,display_name,access_modes_json,strategies_json,
    regions_json,configuration_schema_json,charge_components_json,quote_policy,data_handling_json,preference_rank,status,created_at,updated_at)
    VALUES('off-1','agentmail','agentmail',1,'email_inbox','email','AgentMail inbox','["managed"]','["managed_master"]','["us"]','{}',?,'required_for_recurring','{}',100,'available',1,1)`)
    .run(JSON.stringify([{ kind: "rental", interval: "month", credits: 100 }]));
  h.insertAccount("res-1", { account: "ap-acct-1", offering: "off-1", sub: "sub-1" });
  h.db.prepare(`INSERT INTO managed_service_subscriptions(id,tenant_id,resource_id,subscription_type,offering_id,price_version,interval,current_period_start,current_period_end,
    renewal_state,grace_days,cancel_at_period_end,created_at,updated_at) VALUES('sub-1','tenant','res-1','naelao_email_inbox','off-1','pv1','month',?,?,'active',7,1,1,1)`)
    .run(NOW - 86_400_000, NOW + 20 * 86_400_000);
  h.db.prepare("INSERT INTO agentport_account_grants(id,tenant_id,account_id,agent_id,granted_by,permissions_json,status,created_at,updated_at) VALUES('g1','tenant','ap-acct-1','agent-a','user','[]','active',?,?)").run(AT, AT);
  h.db.prepare("INSERT INTO agentport_account_grants(id,tenant_id,account_id,agent_id,granted_by,permissions_json,status,created_at,updated_at) VALUES('g2','tenant','ap-acct-1','agent-b','user','[]','revoked',?,?)").run(AT, AT);
  h.db.prepare(`INSERT INTO managed_service_operations(operation_id,tenant_id,space_id,account_id,provider,service_id,operation_name,idempotency_key,request_sha256,status,created_at,updated_at)
    VALUES('op-1','tenant','space','res-1','agentmail','agentmail','send','i1',?,'complete',?,?)`).run("a".repeat(64), AT, AT);
  h.db.prepare(`INSERT INTO managed_service_credit_reservations(id,org_id,space_id,region,operation_id,provider,service_id,operation_name,payer_id,credits,settled_credits,price_version,status,created_at,updated_at)
    VALUES('hold-1','tenant','space','us','op-1','agentmail','agentmail','send','tenant',5,4,'pv1','settled',?,?)`).run(AT, AT);
}

describe("MS-42 managed resources route", () => {
  it("is off unless the flag is exactly true and answers the not-found shape", async () => {
    expect(managedResourcesPanelEnabled({})).toBe(false);
    expect(managedResourcesPanelEnabled({ MANAGED_RESOURCES_PANEL_ENABLED: "false" })).toBe(false);
    for (const flag of [null, "false", "TRUE"]) {
      const h = harness(flag);
      const response = await h.get();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error_code: "not_found" });
    }
  });

  it("lists resources with provider, mode, agents, usage, price and renewal for an owner", async () => {
    const h = harness(); seedManaged(h);
    h.insertAccount("res-byok", { mode: "user_connected" });
    const response = await h.get();
    expect(response.status).toBe(200);
    const body = await response.json() as { resources: Array<Record<string, any>> };
    const managed = body.resources.find((r) => r.id === "res-1")!;
    expect(managed).toMatchObject({
      providerName: "AgentMail inbox", mode: "managed", status: "active", displayName: "Support inbox",
      assignedAgents: [{ agentId: "agent-a" }],
      usage: { operations: 1, settledCredits: 4, heldCredits: 0 },
      price: { credits: 100, interval: "month" },
      renewal: { state: "active", cancelAtPeriodEnd: true },
    });
    expect(body.resources.find((r) => r.id === "res-byok")).toMatchObject({ mode: "byok", providerName: "AgentMail", price: null, renewal: null, assignedAgents: [] });
  });

  it("never exposes internal strategy names, provider refs, credential refs or offering ids", async () => {
    const h = harness(); seedManaged(h);
    const text = JSON.stringify(await (await h.get()).json());
    for (const secret of ["managed_master", "provisioning_strategy", "secret-provider-ref", "vault-credential-ref", "credential_ref", "provider_resource_ref",
      "ap-acct-1", "off-1", "first_party", "native_subaccount", "customer_connection"]) expect(text).not.toContain(secret);
  });

  it("is limited to the caller's tenant and Space", async () => {
    const h = harness(); seedManaged(h);
    h.insertAccount("other-space", { space: "space-2" });
    h.insertAccount("other-tenant", { tenant: "tenant-2" });
    const ids = ((await (await h.get()).json()) as { resources: Array<{ id: string }> }).resources.map((r) => r.id);
    expect(ids).toEqual(["res-1"]);
  });

  it("returns the same not-found shape to a plain member as when the feature is off", async () => {
    const h = harness(); seedManaged(h);
    const member = await h.get(PATH, await h.headers("other"));
    expect(member.status).toBe(404);
    expect(await member.json()).toEqual({ error_code: "not_found" });
    const unknown = await h.get(PATH, await h.headers("stranger"));
    expect([403, 404]).toContain(unknown.status);
    const post = await h.app.request(PATH, { method: "POST", headers: { ...(await h.headers()), "content-type": "application/json" }, body: JSON.stringify({ action: "managed-resources" }) }, h.env);
    expect(post.status).toBe(404);
  });

  it("allows a Space admin", async () => {
    const h = harness(); seedManaged(h);
    h.db.prepare("UPDATE space_members SET role='admin' WHERE end_user_id='other'").run();
    expect((await h.get(PATH, await h.headers("other"))).status).toBe(200);
  });
});
