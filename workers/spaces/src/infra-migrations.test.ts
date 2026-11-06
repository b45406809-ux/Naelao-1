import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";

describe("latest D1 deployment migration batch", () => {
  it("applies email, push, language, telephony, quota, channel-model, attachment, and extension trust/provider migrations", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    storage.sql.exec("CREATE TABLE product_end_users (product_space_id TEXT, end_user_id TEXT, PRIMARY KEY(product_space_id,end_user_id))");
    storage.sql.exec("CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT)");
    storage.sql.exec("CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE)");
    // This migration batch is applied after the base Knowledge schema in production. Model the
    // referenced table so SQLite can validate the publication cleanup trigger too.
    storage.sql.exec("CREATE TABLE kb_documents (id TEXT, tenant_id TEXT, space_id TEXT, project_id TEXT)");
    const migrationFiles = ["0038_channel_links.sql", "0039_channel_links_project.sql", "0081_workflow_budget_reservations.sql", "0093_email_reply_routes.sql", "0094_agent_email_addresses.sql", "0095_web_push_subscriptions.sql", "0096_product_end_user_language.sql", "0097_customer_voice_telephony.sql", "0098_llm_token_reservations.sql", "0099_channel_model_overrides.sql", "0100_email_attachment_ocr_usage.sql", "0101_customer_voice_purchase_quotes.sql", "0102_channel_attachments.sql", "0103_channel_extension_bindings.sql", "0104_kb_external_publications.sql", "0109_usage_events_v2.sql", "0110_workflow_usage_dimensions.sql", "0111_extension_publisher_keys.sql", "0112_extension_provider_connections.sql", "0113_whatsapp_extension_phone_routing.sql", "0124_project_scoped_agent_email_addresses.sql", "0152_decision_call_reservations.sql"];
    for (const file of migrationFiles) {
      storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations", file), "utf8"));
    }
    storage.sql.exec("INSERT INTO spaces(id,tenant_id,created_by) VALUES ('s1','t1','u1'),('s2','t1','u2')");
    storage.sql.exec("INSERT INTO agent_email_addresses(address_hash,tenant_id,space_id,agent_id,status,created_at) VALUES ('hash-a','t1','s1','agent-a','active','2026-01-01')");
    storage.sql.exec("INSERT INTO project_agent_email_addresses(address_hash,tenant_id,space_id,agent_id,project_id,status,created_at) VALUES ('hash-p','t1','s2','agent-b','project-b','revoked','2026-02-01')");
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0158_agentport_registry.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0159_agentport_api_keys.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0160_agentport_developer_identity.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0161_agentport_channels_threads.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0162_agentport_signed_identity.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0163_agentport_provider_auth.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0164_agentport_channel_message_refs.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0165_agentport_oauth.sql"), "utf8"));
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0163_agentport_provider_auth.sql"), "utf8"))).not.toThrow();
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0164_agentport_channel_message_refs.sql"), "utf8"))).not.toThrow();
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0165_agentport_oauth.sql"), "utf8"))).not.toThrow();
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0166_drop_agentport_message_store.sql"), "utf8"));
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0166_drop_agentport_message_store.sql"), "utf8"))).not.toThrow();
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0167_agentport_apps_capabilities.sql"), "utf8"));
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0167_agentport_apps_capabilities.sql"), "utf8"))).not.toThrow();
    const legacyAgentCount = storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM agentport_agents").toArray()[0]?.count;
    storage.sql.exec("INSERT INTO agentport_organizations(id,name,owner_developer_id,status,created_at,updated_at) VALUES('legacy-org','Legacy','naelao-managed:legacy-org','active','now','now')");
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0168_agentport_client_neutral_host_resources.sql"), "utf8"));
    expect(storage.sql.exec<{ owner_developer_id: string }>("SELECT owner_developer_id FROM agentport_organizations WHERE id='legacy-org'").toArray()[0]?.owner_developer_id).toBe("platform-managed:legacy-org");
    expect(storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM agentport_agents").toArray()[0]?.count).toBe(legacyAgentCount);
    expect(storage.sql.exec<{ host_resource_id: string }>("SELECT host_resource_id FROM agentport_agents WHERE host_space_id='s1' LIMIT 1").toArray()[0]?.host_resource_id).toBe("s1");
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0169_agentport_email_accounts.sql"), "utf8"));
    storage.sql.exec(`INSERT INTO agentport_services(id,tenant_id,name,service_type,account_models_json,capabilities_json,events_json,billing_json,connection_purpose,partnership_status,status,created_at,updated_at)
      VALUES('ap_email:t1','t1','AgentPort Email','managed','["agent_native"]','["email.send","email.receive"]','["message.received"]','{}','agent_resource','approved','active','2026-01-01','2026-01-01')`);
    storage.sql.exec(`INSERT INTO agentport_accounts(id,tenant_id,service_id,account_model,owner_type,owner_id,external_account_id,metadata_json,status,created_at,updated_at)
      VALUES('mailbox-old','t1','ap_email:t1','agent_native','individual','u1','old@mail.example','{}','active','2026-01-01','2026-01-02')`);
    storage.sql.exec(`INSERT INTO agentport_email_accounts(account_id,tenant_id,agent_id,address,inbound_webhook_url,idempotency_key,created_at,updated_at)
      SELECT 'mailbox-old','t1',id,'old@mail.example','https://hooks.example.com/mail','old-key','2026-01-01','2026-01-02' FROM agentport_agents WHERE host_space_id='s1' LIMIT 1`);
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0170_agentport_email_channels.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0171_agentport_event_notifications.sql"), "utf8"));
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0171_agentport_event_notifications.sql"), "utf8"))).not.toThrow();
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0172_assistant_agentmail_accounts.sql"), "utf8"));
    expect(() => storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0172_assistant_agentmail_accounts.sql"), "utf8"))).not.toThrow();
    expect(storage.sql.exec<{ id: string; account_id: string; provider_channel_id: string; status: string }>(
      "SELECT id,account_id,provider_channel_id,status FROM agentport_channels WHERE account_id='mailbox-old'"
    ).toArray()).toEqual([{ id: "chn-email:mailbox-old", account_id: "mailbox-old", provider_channel_id: "old@mail.example", status: "active" }]);
    expect(storage.sql.exec<{ owner_id: string; address: string; status: string }>(
      "SELECT a.owner_id,e.address,e.status FROM agentport_accounts a JOIN agentport_email_accounts e ON e.account_id=a.id WHERE a.id='mailbox-old'"
    ).toArray()).toEqual([{ owner_id: "u1", address: "old@mail.example", status: "active" }]);
    const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "email_reply_routes", "agent_email_addresses", "web_push_subscriptions",
      "customer_voice_space_policies", "customer_voice_number_bindings", "customer_voice_call_admissions", "email_attachment_ocr_usage",
      "customer_voice_purchase_quotes",
      "channel_attachments",
      "attachment_copy_claims",
      "llm_token_reservations", "llm_token_run_settlements",
      "workflow_budget_reservations", "decision_call_reservations",
      "kb_external_publications", "kb_external_publication_documents",
      "extension_publisher_keys", "extension_provider_connections", "extension_provider_routes",
      "agentport_principals", "agentport_agents", "agentport_services", "agentport_accounts",
      "agentport_account_grants", "agentport_account_dependencies", "agentport_event_subscriptions",
      "agentport_email_accounts", "agentport_email_sends",
      "agentport_events", "agentport_activity_leases",
      "agentport_api_keys",
      "agentport_organizations", "agentport_developers", "agentport_auth_rate_limits",
      "agentport_channels", "agentport_threads", "agentport_channel_message_refs", "agentport_trusted_senders", "agentport_action_receipts",
      "agentport_service_manifests",
      "assistant_agentmail_pods", "assistant_agentmail_accounts", "assistant_agentmail_event_receipts",
      "assistant_agentmail_sends", "assistant_agentport_event_receipts", "assistant_agentport_event_runs", "assistant_agentmail_operations",
      "agentport_identity_keys", "agentport_issued_credentials",
      "agentport_provider_auth",
      "agentport_oauth_clients", "agentport_oauth_codes", "agentport_oauth_tokens", "agentport_oauth_refresh_tokens",
    ]));
    expect(tables).not.toContain("agentport_messages");
    expect(tables).toContain("agentport_apps");
    expect(tables).toContain("agentport_capability_handles");
    expect(tables).toContain("agentport_usage_records");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('product_end_users')").toArray().map(row => row.name)).toContain("preferred_language");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('channel_links')").toArray().map(row => row.name)).toContain("model_override");
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('workflow_budget_reservations')").toArray().map(row => row.name))
      .toEqual(expect.arrayContaining(["project_id", "installation_id", "runtime_tier"]));
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('extension_provider_connections')").toArray().map(row => row.name))
      .toEqual(expect.arrayContaining(["handler_sha256", "routing_keys_json", "credential_name", "webhook_secret_name", "status"]));
    expect(storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM agentport_accounts WHERE external_account_id LIKE 'sha256:%'").toArray()[0]?.count).toBe(2);
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM agentport_accounts WHERE external_account_id='sha256:hash-p'").toArray()[0]?.status).toBe("revoked");
    expect(storage.sql.exec<{ verification_level: string }>("SELECT verification_level FROM agentport_principals WHERE id='prn-user:t1:u1'").toArray()[0]?.verification_level).toBe("unverified");
    storage.sql.exec("INSERT INTO extension_provider_routes(tenant_id,space_id,provider,account_id,channel_id,installation_id,connection_id,created_at) VALUES('t','s','slack','T1','C123456','i1','c1','now')");
    expect(() => storage.sql.exec("INSERT INTO extension_provider_routes(tenant_id,space_id,provider,account_id,channel_id,installation_id,connection_id,created_at) VALUES('t','s','slack','T1','C123456','i2','c2','now')")).toThrow();
    storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t','s','p1','i1','c1','telegram','bot-1','@bot','cred-1','hash','active','owner','now','now')");
    expect(() => storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t','s','p2','i2','c2','telegram','bot-1','@bot','cred-2','hash','active','owner','now','now')")).toThrow();
    storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t','s','p1','i1','wa1','whatsapp','wa-phone-1','Business 1','cred-wa-1','hash','active','owner','now','now')");
    expect(() => storage.sql.exec("INSERT INTO extension_provider_connections(tenant_id,space_id,project_id,installation_id,connection_id,provider,account_id,account_label,credential_name,handler_sha256,status,connected_by,connected_at,updated_at) VALUES('t2','s2','p2','i2','wa2','whatsapp','wa-phone-1','Business 1','cred-wa-2','hash','active','owner','now','now')")).toThrow();
  });
});
