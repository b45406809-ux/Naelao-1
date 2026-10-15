import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";

describe("latest D1 deployment migration batch", () => {
  it("applies email, push, language, telephony, and model-quota migrations in order", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE product_end_users (product_space_id TEXT, end_user_id TEXT, PRIMARY KEY(product_space_id,end_user_id))");
    for (const file of ["0093_email_reply_routes.sql", "0094_agent_email_addresses.sql", "0095_web_push_subscriptions.sql", "0096_product_end_user_language.sql", "0097_customer_voice_telephony.sql", "0098_llm_token_reservations.sql"]) {
      storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations", file), "utf8"));
    }
    const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "email_reply_routes", "agent_email_addresses", "web_push_subscriptions",
      "customer_voice_space_policies", "customer_voice_number_bindings", "customer_voice_call_admissions",
      "llm_token_reservations", "llm_token_run_settlements",
    ]));
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('product_end_users')").toArray().map(row => row.name)).toContain("preferred_language");
  });
});
