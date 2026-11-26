import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../infra/migrations", name), "utf8");

function databaseBeforeRegistry() {
  return createFakeD1([
    "CREATE TABLE spaces(id TEXT PRIMARY KEY)",
    `CREATE TABLE assistant_agentmail_accounts(id TEXT PRIMARY KEY,tenant_id TEXT,space_id TEXT,project_id TEXT,mode TEXT,inbox_id TEXT,pod_id TEXT,agentport_agent_id TEXT,agentport_account_id TEXT,owner_user_id TEXT,status TEXT,email_address TEXT,created_at TEXT,updated_at TEXT)`,
    migration("0130_assistant_communications.sql"),
    migration("0131_assistant_phones.sql"),
    migration("0133_phone_extension_handlers.sql"),
    migration("0134_assistant_live_calls.sql"),
    migration("0135_assistant_coordination.sql"),
    migration("0136_phone_provider_identity.sql"),
    migration("0179_managed_services_control_plane.sql"),
  ]);
}

function database() {
  const db = databaseBeforeRegistry();
  db.db.exec(migration("0202_telnyx_managed_service_account_registry.sql"));
  return db;
}

describe("Telnyx managed-service account registry", () => {
  it("tracks BYO number ownership and lifecycle without publishing an unverified AgentPort capability", () => {
    const db = databaseBeforeRegistry();
    db.db.prepare("INSERT INTO spaces(id) VALUES('space-a')").run();
    db.db.prepare(`INSERT INTO assistant_communication_identities(id,tenant_id,space_id,scope_key,owner_user_id)
      VALUES('identity-a','tenant-a','space-a','project-a','user-a')`).run();
    db.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,country_code,policy_json,status) VALUES('binding-a','identity-a','assistant','byo','telnyx','acct-ref-a',
      'number-ref-a','+14155550100','US','{}','active')`).run();
    db.db.exec(migration("0202_telnyx_managed_service_account_registry.sql"));

    expect(db.db.prepare(`SELECT provider,service_id,connection_mode,provider_resource_ref,owner_type,owner_id,
      provider_payer_type,provider_payer_id,credit_payer_type,lifecycle_state,agentport_account_id
      FROM managed_service_accounts WHERE id='telnyx-binding-a'`).get()).toEqual({
      provider: "telnyx", service_id: "phone-number", connection_mode: "user_connected", provider_resource_ref: "number-ref-a",
      owner_type: "user", owner_id: "user-a", provider_payer_type: "user", provider_payer_id: "user-a",
      credit_payer_type: null, lifecycle_state: "active", agentport_account_id: null,
    });
    expect(db.db.prepare("SELECT status FROM managed_service_capability_versions WHERE provider='telnyx' AND service_id='phone-number'").get())
      .toEqual({ status: "draft" });

    db.db.prepare("UPDATE assistant_phone_bindings SET status='detached' WHERE id='binding-a'").run();
    expect(db.db.prepare("SELECT lifecycle_state FROM managed_service_accounts WHERE id='telnyx-binding-a'").get())
      .toEqual({ lifecycle_state: "retired" });
  });

  it("keeps managed-number provider payer and organization credit payer distinct", () => {
    const db = database();
    db.db.prepare("INSERT INTO spaces(id) VALUES('space-a')").run();
    db.db.prepare(`INSERT INTO assistant_communication_identities(id,tenant_id,space_id,scope_key,owner_user_id)
      VALUES('identity-a','tenant-a','space-a','project-a','user-a')`).run();
    db.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,
      phone_number,country_code,policy_json,status) VALUES('binding-managed','identity-a','assistant','managed','telnyx','platform-account',
      'number-managed','+14155550101','US','{}','active')`).run();

    expect(db.db.prepare(`SELECT connection_mode,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id
      FROM managed_service_accounts WHERE id='telnyx-binding-managed'`).get()).toEqual({
      connection_mode: "naelao_managed", provider_payer_type: "platform", provider_payer_id: "naelao",
      credit_payer_type: "organization", credit_payer_id: "tenant-a",
    });
  });
  it("MS-28: triggers recreated by 0292 classify access_mode and provisioning_strategy (MR-RES-1) on insert and update", () => {
    const db = database();
    db.db.exec(migration("0291_managed_offerings_agreements_resources.sql"));
    db.db.exec(migration("0292_managed_offering_testing_allowlist_and_telnyx_classification.sql"));
    db.db.prepare("INSERT INTO spaces(id) VALUES('space-a')").run();
    db.db.prepare(`INSERT INTO assistant_communication_identities(id,tenant_id,space_id,scope_key,owner_user_id)
      VALUES('identity-a','tenant-a','space-a','project-a','user-a')`).run();
    db.db.prepare(`INSERT INTO assistant_communication_identities(id,tenant_id,space_id,scope_key,owner_user_id)
      VALUES('identity-b','tenant-a','space-a','project-b','user-a')`).run();
    const insert = (id: string, payer: string, identity: string, phone: string) => db.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,
      provider_account_sid,provider_number_sid,phone_number,country_code,policy_json,status) VALUES(?,?,'assistant',?,'telnyx','acct',?,?,'US','{}','active')`)
      .run(id, identity, payer, `sid-${id}`, phone);
    insert("b-managed", "managed", "identity-a", "+14155550110");
    insert("b-byo", "byo", "identity-b", "+14155550111");
    const row = (id: string) => db.db.prepare("SELECT connection_mode,access_mode,provisioning_strategy,lifecycle_state FROM managed_service_accounts WHERE id=?").get(`telnyx-${id}`);
    expect(row("b-managed")).toEqual({ connection_mode: "naelao_managed", access_mode: "managed", provisioning_strategy: "managed_master", lifecycle_state: "active" });
    expect(row("b-byo")).toEqual({ connection_mode: "user_connected", access_mode: "byok", provisioning_strategy: "customer_connection", lifecycle_state: "active" });
    // The update trigger keeps existing behaviour (lifecycle sync) and reclassifies when the payer changes.
    db.db.prepare("UPDATE assistant_phone_bindings SET status='detached',payer='managed' WHERE id='b-byo'").run();
    expect(row("b-byo")).toEqual({ connection_mode: "naelao_managed", access_mode: "managed", provisioning_strategy: "managed_master", lifecycle_state: "retired" });
  });
});
