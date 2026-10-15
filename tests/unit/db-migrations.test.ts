import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations, validateMigrationSequence, type Migration } from "../../packages/db/src/migrate";
import { createDOStorage } from "./helpers/sqlite-do-shim";

describe("atomic versioned DO migrations", () => {
  it("applies pending versions once and replays safely after restart", () => {
    const storage = createDOStorage();
    const migrations: Migration[] = [
      { version: 1, description: "base", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" },
      { version: 2, description: "add status", up: "ALTER TABLE records ADD COLUMN status TEXT NOT NULL DEFAULT 'new';" },
    ];
    applyMigrations(storage, migrations);
    applyMigrations(storage, migrations);
    expect([...storage.sql.exec<{ version: number }>("SELECT version FROM _migrations ORDER BY version").toArray()]).toEqual([{ version: 1 }, { version: 2 }]);
    expect([...storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('records')").toArray()].map((column) => column.name)).toContain("status");
  });

  it("rolls back the whole pending batch on a failed statement and rejects duplicate versions before execution", () => {
    const storage = createDOStorage();
    const migrations: Migration[] = [
      { version: 1, description: "create", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" },
      { version: 2, description: "invalid index", up: "CREATE INDEX absent_index ON missing_table(id);" },
    ];
    expect(() => applyMigrations(storage, migrations)).toThrow(/Migration 2/);
    expect(() => storage.sql.exec("SELECT version FROM _migrations").toArray()).toThrow();
    expect(() => validateMigrationSequence([migrations[0]!, migrations[0]!])).toThrow(/duplicate_migration_version/);
  });

  it("keeps builder withdrawal requests separate from Whop business-wallet payouts", () => {
    const storage = createDOStorage();
    for (const name of ["0053_payout_requests.sql", "0064_whop_sub_merchants.sql", "0066_payout_request_expiry.sql"]) {
      storage.sql.exec(readFileSync(join(__dirname, "../../infra/migrations", name), "utf8"));
    }

    const columns = (table: string) => storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map(column => column.name);
    const builderColumns = columns("payout_requests");
    const whopColumns = columns("whop_payout_requests");
    expect(builderColumns).toContain("tenant_id");
    expect(builderColumns).not.toContain("space_id");
    expect(whopColumns).toContain("space_id");
    expect(whopColumns).toContain("destination_id");
    expect(whopColumns).toContain("expires_at");

    storage.sql.exec("INSERT INTO payout_requests (id, tenant_id, amount_cents) VALUES ('builder-1', 'tenant-1', 500)");
    storage.sql.exec("INSERT INTO whop_payout_requests (id, space_id, destination_id, amount_cents) VALUES ('wallet-1', 'space-1', 'dest-1', 700)");
    expect(storage.sql.exec<{ id: string }>("SELECT id FROM payout_requests").toArray()).toEqual([{ id: "builder-1" }]);
    expect(storage.sql.exec<{ id: string }>("SELECT id FROM whop_payout_requests").toArray()).toEqual([{ id: "wallet-1" }]);
  });

  it("adds independent language preference fields to platform members and product end users", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE product_end_users (product_space_id TEXT, end_user_id TEXT, PRIMARY KEY(product_space_id, end_user_id))");
    storage.sql.exec(readFileSync(join(__dirname, "../../infra/migrations/0096_product_end_user_language.sql"), "utf8"));

    const columns = (table: string) => storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map(column => column.name);
    expect(columns("users")).toContain("preferred_language");
    expect(columns("product_end_users")).toContain("preferred_language");
    storage.sql.exec("INSERT INTO users (id, preferred_language) VALUES ('member-1', 'fr-CA')");
    storage.sql.exec("INSERT INTO product_end_users (product_space_id, end_user_id, preferred_language) VALUES ('product-a', 'user-1', 'sw-KE')");
    expect(storage.sql.exec<{ preferred_language: string }>("SELECT preferred_language FROM users WHERE id = 'member-1'").toArray()).toEqual([{ preferred_language: "fr-CA" }]);
    expect(storage.sql.exec<{ preferred_language: string }>("SELECT preferred_language FROM product_end_users WHERE product_space_id = 'product-a' AND end_user_id = 'user-1'").toArray()).toEqual([{ preferred_language: "sw-KE" }]);
  });

  it("creates tenant-scoped voice number bindings and idempotent call admission records", () => {
    const storage = createDOStorage();
    storage.sql.exec(readFileSync(join(__dirname, "../../infra/migrations/0097_customer_voice_telephony.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../infra/migrations/0097_customer_voice_telephony.sql"), "utf8"));
    const admissionColumns = storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('customer_voice_call_admissions')").toArray().map((column) => column.name);
    const numberColumns = storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('customer_voice_number_bindings')").toArray().map((column) => column.name);
    expect(admissionColumns).toContain("reserved_cost_minor");
    expect(admissionColumns).toContain("reserved_duration_seconds");
    expect(numberColumns).toContain("provider_voice_url");
    expect(numberColumns).toContain("provider_status_callback");
    expect(numberColumns).toContain("provider_voice_method");
    expect(numberColumns).toContain("provider_status_callback_method");
    expect(numberColumns).toContain("provider_status_callback_events_json");
    storage.sql.exec("INSERT INTO customer_voice_space_policies (tenant_id,space_id,updated_by,updated_at) VALUES ('t1','s1','u1','2026-10-15T00:00:00Z')");
    storage.sql.exec(`INSERT INTO customer_voice_number_bindings
      (id,provider,provider_account_sid,provider_number_sid,tenant_id,space_id,agent_id,phone_number,country_code,monthly_cost_minor,currency,monthly_quote_at,inbound_price_per_minute_minor,created_by,created_at,updated_at)
      VALUES ('n1','twilio','AC${"a".repeat(32)}','PN${"b".repeat(32)}','t1','s1','a1','+14155550100','US',1000,'USD','2026-10-15T00:00:00Z',1,'u1','2026-10-15T00:00:00Z','2026-10-15T00:00:00Z')`);
    storage.sql.exec(`INSERT INTO customer_voice_call_admissions
      (call_sid,number_binding_id,tenant_id,space_id,agent_id,caller_number,called_number,status,ticket_nonce,ticket_token,issued_at,ticket_expires_at,updated_at)
      VALUES ('CA1','n1','t1','s1','a1','+14155550101','+14155550100','issued','nonce1','ticket','2026-10-15T00:00:00Z','2026-10-15T00:01:00Z','2026-10-15T00:00:00Z')`);
    expect(() => storage.sql.exec(`INSERT INTO customer_voice_call_admissions
      (call_sid,number_binding_id,tenant_id,space_id,agent_id,caller_number,called_number,status,ticket_nonce,ticket_token,issued_at,ticket_expires_at,updated_at)
      VALUES ('CA1','n1','t1','s1','a1','+14155550101','+14155550100','issued','nonce2','ticket','2026-10-15T00:00:00Z','2026-10-15T00:01:00Z','2026-10-15T00:00:00Z')`)).toThrow();
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM customer_voice_call_admissions WHERE call_sid='CA1'").toArray()).toEqual([{ status: "issued" }]);
  });
});
