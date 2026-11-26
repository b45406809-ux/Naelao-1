import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeD1, type FakeD1 } from "../../../../tests/stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../infra/migrations", name), "utf8");
const P0_MIGRATION = "0291_managed_offerings_agreements_resources.sql";

// The managed_service_accounts definition as it stands before 0291: the original CREATE in 0179
// plus the later ALTERs in 0181 (owner_link_id) and 0208 (agentport_link_status).
function databaseBeforeP0(): FakeD1 {
  // 0179 imports existing AgentMail accounts with INSERT ... SELECT, so its source table must exist.
  const db = createFakeD1([
    "CREATE TABLE spaces(id TEXT PRIMARY KEY)",
    `CREATE TABLE assistant_agentmail_accounts(id TEXT PRIMARY KEY,tenant_id TEXT,space_id TEXT,project_id TEXT,mode TEXT,inbox_id TEXT,pod_id TEXT,agentport_agent_id TEXT,agentport_account_id TEXT,owner_user_id TEXT,status TEXT,email_address TEXT,created_at TEXT,updated_at TEXT)`,
  ]);
  db.db.exec(migration("0179_managed_services_control_plane.sql"));
  db.db.exec(migration("0181_managed_service_ownership_and_audit.sql"));
  db.db.exec(migration("0208_managed_service_agentport_link_state.sql"));
  return db;
}

function insertLegacyAccount(db: FakeD1, id: string, connectionMode: string, providerResourceRef: string, provider = "agentmail") {
  db.db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,
    provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,created_at,updated_at)
    VALUES(?,'tenant-a','space-a',?,?,?,?,'user','user-a','user','active','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`)
    .run(id, provider, provider, connectionMode, providerResourceRef);
}

function columnNames(db: FakeD1, table: string): string[] {
  return (db.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((row) => row.name);
}

function insertOffering(db: FakeD1, id: string) {
  db.db.prepare(`INSERT INTO managed_service_offerings(id,provider,service_id,capability_version,resource_type,category,display_name,
    access_modes_json,strategies_json,regions_json,configuration_schema_json,charge_components_json,quote_policy,data_handling_json,
    status,created_at,updated_at)
    VALUES(?,'agentmail','agentmail',1,'email.inbox','email','Inbox','["managed"]','["managed_master"]','[]','{}','[]','always','{}',
    'draft',1,1)`).run(id);
}

describe("MS-27 P0 managed-service schema", () => {
  it("applies on a fresh database and adds the §6.1 resource columns with their defaults", () => {
    const db = databaseBeforeP0();
    db.db.exec(migration(P0_MIGRATION));

    const columns = columnNames(db, "managed_service_accounts");
    for (const name of ["category", "resource_type", "offering_id", "access_mode", "provisioning_strategy", "sharing_class",
      "display_name", "subscription_id", "ownership_json", "row_version", "owner_link_id", "agentport_link_status"]) {
      expect(columns).toContain(name);
    }
    expect(columnNames(db, "managed_service_offerings")).toEqual(expect.arrayContaining(["quote_policy", "status", "capability_version"]));
    expect(columnNames(db, "managed_service_commercial_agreements")).toEqual(expect.arrayContaining(["verification_status", "evidence_sha256", "approved_by"]));
    expect(columnNames(db, "managed_service_offering_audit")).toEqual(expect.arrayContaining(["actor_id", "before_json", "after_json", "reason"]));
    expect(columnNames(db, "managed_service_commercial_agreement_audit")).toEqual(expect.arrayContaining(["actor_id", "reason"]));

    // A row written after the migration gets the defaults only; access_mode is set by code later,
    // because the MR-RES-1 backfill runs once at migration time.
    insertLegacyAccount(db, "acct-fresh", "naelao_managed", "inbox-fresh");
    expect(db.db.prepare("SELECT sharing_class,row_version,offering_id,access_mode,provisioning_strategy FROM managed_service_accounts WHERE id='acct-fresh'").get())
      .toEqual({ sharing_class: "dedicated", row_version: 1, offering_id: null, access_mode: null, provisioning_strategy: null });
  });

  it("migrates legacy rows without failing on existing duplicate provider references and backfills MR-RES-1", () => {
    const db = databaseBeforeP0();
    insertLegacyAccount(db, "legacy-naelao", "naelao_managed", "inbox-1");
    insertLegacyAccount(db, "legacy-user", "user_connected", "inbox-2");
    insertLegacyAccount(db, "legacy-provider", "provider_managed", "inbox-3");
    // Higgsfield customer-owned accounts all store the same placeholder ref.
    insertLegacyAccount(db, "legacy-hf-1", "user_connected", "customer-owned-api-key", "higgsfield");
    insertLegacyAccount(db, "legacy-hf-2", "user_connected", "customer-owned-api-key", "higgsfield");

    expect(() => db.db.exec(migration(P0_MIGRATION))).not.toThrow();

    const rows = db.db.prepare("SELECT id,connection_mode,access_mode,provisioning_strategy,offering_id,sharing_class FROM managed_service_accounts ORDER BY id").all();
    expect(rows).toEqual([
      { id: "legacy-hf-1", connection_mode: "user_connected", access_mode: "byok", provisioning_strategy: "customer_connection", offering_id: null, sharing_class: "dedicated" },
      { id: "legacy-hf-2", connection_mode: "user_connected", access_mode: "byok", provisioning_strategy: "customer_connection", offering_id: null, sharing_class: "dedicated" },
      { id: "legacy-naelao", connection_mode: "naelao_managed", access_mode: "managed", provisioning_strategy: "managed_master", offering_id: null, sharing_class: "dedicated" },
      { id: "legacy-provider", connection_mode: "provider_managed", access_mode: "managed", provisioning_strategy: "native_subaccount", offering_id: null, sharing_class: "dedicated" },
      { id: "legacy-user", connection_mode: "user_connected", access_mode: "byok", provisioning_strategy: "customer_connection", offering_id: null, sharing_class: "dedicated" },
    ]);
  });

  it("does not overwrite rows that already carry an access mode when the backfill statement runs again", () => {
    const db = databaseBeforeP0();
    db.db.exec(migration(P0_MIGRATION));
    insertLegacyAccount(db, "post-migration", "user_connected", "inbox-post");
    db.db.exec("UPDATE managed_service_accounts SET access_mode='managed',provisioning_strategy='first_party' WHERE id='post-migration'");
    // Re-running only the backfill statement must not overwrite a classified row.
    db.db.exec(`UPDATE managed_service_accounts SET access_mode = CASE connection_mode WHEN 'user_connected' THEN 'byok' END
      WHERE access_mode IS NULL AND provisioning_strategy IS NULL`);
    expect(db.db.prepare("SELECT access_mode,provisioning_strategy FROM managed_service_accounts WHERE id='post-migration'").get())
      .toEqual({ access_mode: "managed", provisioning_strategy: "first_party" });
  });

  it("exposes the V-spec field names through managed_resources", () => {
    const db = databaseBeforeP0();
    db.db.exec(migration(P0_MIGRATION));
    insertLegacyAccount(db, "view-a", "naelao_managed", "inbox-view");
    db.db.exec("UPDATE managed_service_accounts SET access_mode='managed',provisioning_strategy='managed_master',display_name='Inbox' WHERE id='view-a'");
    const row = db.db.prepare("SELECT * FROM managed_resources WHERE id='view-a'").get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "access_mode", "capability_version", "category", "connection_mode", "created_at", "display_name", "id", "lifecycle_state",
      "offering_id", "owner_id", "owner_type", "ownership_json", "project_id", "provider", "provider_resource_ref",
      "provisioning_strategy", "region", "resource_type", "row_version", "service_id", "sharing_class", "space_id",
      "subscription_id", "tenant_id", "updated_at",
    ]);
    expect(row).toMatchObject({
      id: "view-a", tenant_id: "tenant-a", provider: "agentmail", provider_resource_ref: "inbox-view",
      access_mode: "managed", provisioning_strategy: "managed_master", sharing_class: "dedicated", row_version: 1,
      display_name: "Inbox",
    });
  });

  it("rejects a duplicate provider reference for offering-backed rows but not for legacy rows", () => {
    const db = databaseBeforeP0();
    insertLegacyAccount(db, "legacy-dup-1", "user_connected", "shared-ref", "agentmail");
    insertLegacyAccount(db, "legacy-dup-2", "user_connected", "shared-ref", "agentmail");
    db.db.exec(migration(P0_MIGRATION));
    insertOffering(db, "off_agentmail_inbox_v1");

    db.db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,capability_version,connection_mode,
      provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,offering_id,created_at,updated_at)
      VALUES('new-1','tenant-a','space-a','agentmail','agentmail',1,'naelao_managed','new-ref','user','user-a','platform','active',
      'off_agentmail_inbox_v1','2026-11-26T00:00:00Z','2026-11-26T00:00:00Z')`).run();

    expect(() => db.db.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,capability_version,connection_mode,
      provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,offering_id,created_at,updated_at)
      VALUES('new-2','tenant-b','space-b','agentmail','agentmail',1,'naelao_managed','new-ref','user','user-b','platform','active',
      'off_agentmail_inbox_v1','2026-11-26T00:00:00Z','2026-11-26T00:00:00Z')`).run()).toThrow(/UNIQUE/);

    // A legacy row with the same reference (offering_id NULL) is still allowed, as before.
    expect(() => insertLegacyAccount(db, "legacy-late", "user_connected", "new-ref")).not.toThrow();
  });

  it("enforces the enumerated CHECK constraints on new columns and tables", () => {
    const db = databaseBeforeP0();
    db.db.exec(migration(P0_MIGRATION));
    insertOffering(db, "off_check_v1");
    expect(() => db.db.prepare("INSERT INTO managed_service_offerings(id,provider,service_id,capability_version,resource_type,category,display_name,access_modes_json,strategies_json,regions_json,configuration_schema_json,charge_components_json,quote_policy,data_handling_json,status,created_at,updated_at) VALUES('off_bad','agentmail','agentmail',1,'x','email','x','[]','[]','[]','{}','[]','sometimes','{}','draft',1,1)").run()).toThrow(/CHECK/);
    expect(() => db.db.prepare("INSERT INTO managed_service_commercial_agreements(id,provider,agreement_type,permitted_offering_ids_json,permits_managed_provisioning,permits_master_account_distribution,permits_subaccount_distribution,permits_shared_resources,permitted_regions_json,effective_from,verification_status,created_at,updated_at) VALUES('agr_bad','agentmail','first_party','[]',2,0,0,0,'[]',1,'unverified',1,1)").run()).toThrow(/CHECK/);
    expect(() => db.db.prepare("INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,owner_type,owner_id,provider_payer_type,lifecycle_state,access_mode,created_at,updated_at) VALUES('bad-mode','t','s','agentmail','agentmail','naelao_managed','r','user','u','user','active','shared','x','x')").run()).toThrow(/CHECK/);
  });

  it("stores offering, agreement and audit rows with the §6.2 and §6.3 defaults", () => {
    const db = databaseBeforeP0();
    db.db.exec(migration(P0_MIGRATION));
    insertOffering(db, "off_store_v1");
    db.db.prepare(`INSERT INTO managed_service_offering_audit(id,offering_id,actor_id,before_json,after_json,reason,created_at)
      VALUES('oa-1','off_store_v1','admin-a',NULL,'{"status":"draft"}','create',1)`).run();
    db.db.prepare(`INSERT INTO managed_service_commercial_agreements(id,provider,agreement_type,permitted_offering_ids_json,
      permits_managed_provisioning,permits_master_account_distribution,permits_subaccount_distribution,permits_shared_resources,
      permitted_regions_json,effective_from,verification_status,created_at,updated_at)
      VALUES('agr-1','agentmail','first_party','["off_store_v1"]',1,0,0,0,'[]',1,'unverified',1,1)`).run();
    db.db.prepare(`INSERT INTO managed_service_commercial_agreement_audit(id,agreement_id,actor_id,before_json,after_json,reason,created_at)
      VALUES('aa-1','agr-1','admin-a',NULL,'{"verification_status":"unverified"}','seed',1)`).run();
    expect(db.db.prepare("SELECT preference_rank,status FROM managed_service_offerings WHERE id='off_store_v1'").get())
      .toEqual({ preference_rank: 100, status: "draft" });
    expect(db.db.prepare("SELECT verification_status,approved_by,evidence_sha256 FROM managed_service_commercial_agreements WHERE id='agr-1'").get())
      .toEqual({ verification_status: "unverified", approved_by: null, evidence_sha256: null });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM managed_service_offering_audit").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM managed_service_commercial_agreement_audit").get()).toEqual({ n: 1 });
  });
});
