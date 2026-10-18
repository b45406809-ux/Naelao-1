import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";

describe("latest D1 deployment migration batch", () => {
  it("applies email, push, language, telephony, quota, channel-model, attachment, and extension trust/provider migrations", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE product_end_users (product_space_id TEXT, end_user_id TEXT, PRIMARY KEY(product_space_id,end_user_id))");
    storage.sql.exec("CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE)");
    // This migration batch is applied after the base Knowledge schema in production. Model the
    // referenced table so SQLite can validate the publication cleanup trigger too.
    storage.sql.exec("CREATE TABLE kb_documents (id TEXT, tenant_id TEXT, space_id TEXT, project_id TEXT)");
    for (const file of ["0038_channel_links.sql", "0039_channel_links_project.sql", "0081_workflow_budget_reservations.sql", "0093_email_reply_routes.sql", "0094_agent_email_addresses.sql", "0095_web_push_subscriptions.sql", "0096_product_end_user_language.sql", "0097_customer_voice_telephony.sql", "0098_llm_token_reservations.sql", "0099_channel_model_overrides.sql", "0100_email_attachment_ocr_usage.sql", "0101_customer_voice_purchase_quotes.sql", "0102_channel_attachments.sql", "0103_channel_extension_bindings.sql", "0104_kb_external_publications.sql", "0109_usage_events_v2.sql", "0110_workflow_usage_dimensions.sql", "0111_extension_publisher_keys.sql", "0112_extension_provider_connections.sql", "0113_whatsapp_extension_phone_routing.sql"]) {
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
      "extension_publisher_keys", "extension_provider_connections", "extension_provider_routes",
    ]));
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('product_end_users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('channel_links')").toArray().map(row => row.name)).toContain("model_override");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('workflow_budget_reservations')").toArray().map(row => row.name))
      .toEqual(expect.arrayContaining(["project_id", "installation_id", "runtime_tier"]));
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('extension_provider_connections')").toArray().map(row => row.name))
      .toEqual(expect.arrayContaining(["handler_sha256", "routing_keys_json", "credential_name", "webhook_secret_name", "status"]));
    storage.sql.exec("INSERT INTO extension_provider_routes(tenant_id,space_id,provider,account_id,channel_id,installation_id,connection_id,created_at) VALUES('t','s','slack','T1','C123456','i1','c1','now')");
    expect(() => storage.sql.exec("INSERT INTO extension_provider_routes(tenant_id,space_id,provider,account_id,channel_id,installation_id,connection_id,created_at) VALUES('t','s','slack','T1','C123456','i2','c2','now')")).toThrow();
    storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t','s','p1','i1','c1','telegram','bot-1','@bot','cred-1','hash','active','owner','now','now')");
    expect(() => storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t','s','p2','i2','c2','telegram','bot-1','@bot','cred-2','hash','active','owner','now','now')")).toThrow();
    storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t','s','p1','i1','wa1','whatsapp','wa-phone-1','Business 1','cred-wa-1','hash','active','owner','now','now')");
    expect(() => storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t2','s2','p2','i2','wa2','whatsapp','wa-phone-1','Business 1','cred-wa-2','hash','active','owner','now','now')")).toThrow();
  });
});
