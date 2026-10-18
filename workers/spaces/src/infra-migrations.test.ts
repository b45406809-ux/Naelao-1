import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";

describe("latest D1 deployment migration batch", () => {
  it("applies email, push, language, telephony, quota, channel-model, and attachment/number-purchase migrations", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE product_end_users (product_space_id TEXT, end_user_id TEXT, PRIMARY KEY(product_space_id,end_user_id))");
    storage.sql.exec("CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE)");
    // This migration batch is applied after the base Knowledge schema in production. Model the
    // referenced table so SQLite can validate the publication cleanup trigger too.
    storage.sql.exec("CREATE TABLE kb_documents (id TEXT, tenant_id TEXT, space_id TEXT, project_id TEXT)");
    for (const file of ["0038_channel_links.sql", "0039_channel_links_project.sql", "0081_workflow_budget_reservations.sql", "0093_email_reply_routes.sql", "0094_agent_email_addresses.sql", "0095_web_push_subscriptions.sql", "0096_product_end_user_language.sql", "0097_customer_voice_telephony.sql", "0098_llm_token_reservations.sql", "0099_channel_model_overrides.sql", "0100_email_attachment_ocr_usage.sql", "0101_customer_voice_purchase_quotes.sql", "0102_channel_attachments.sql", "0103_channel_extension_bindings.sql", "0104_kb_external_publications.sql", "0109_usage_events_v2.sql", "0110_workflow_usage_dimensions.sql"]) {
      storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations", file), "utf8"));
    }
    const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "email_reply_routes", "agent_email_addresses", "web_push_subscriptions",
      "customer_voice_space_policies", "customer_voice_number_bindings", "customer_voice_call_admissions", "email_attachment_ocr_usage",
      "customer_voice_purchase_quotes",
      "channel_attachments",
      "attachment_copy_claims",
      "llm_token_reservations", "llm_token_run_settlements",
      "workflow_budget_reservations",
      "kb_external_publications", "kb_external_publication_documents",
    ]));
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('product_end_users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('channel_links')").toArray().map(row => row.name)).toContain("model_override");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('workflow_budget_reservations')").toArray().map(row => row.name))
      .toEqual(expect.arrayContaining(["project_id", "installation_id", "runtime_tier"]));
  });
});
