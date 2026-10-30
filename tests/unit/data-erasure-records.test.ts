import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { anonymizeOrgUsers, claimErasureRequest, eraseOrgOperationalRecords, eraseSpaceD1Records, SPACE_ERASURE_TABLES } from "../../workers/workflows/src/workflows/erasure-cleanup.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8");
const platformMigrations = readdirSync(join(__dirname, "../../infra/migrations"))
  .filter((name) => /^\d+.*\.sql$/.test(name)).sort().map(migration);

describe("data erasure D1 records", () => {
  it("allows only one workflow to claim a pending erasure request", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier, status, suspension_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run("org-a", "Acme", "user-a", "free", "suspended", "erasure");
    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("request-a", "org-a", "erasure", "org_member", "user-a", "user-a", "pending");
    await expect(claimErasureRequest(db as never, "org-a", "user-a", "request-a")).resolves.toBe(true);
    await expect(claimErasureRequest(db as never, "org-a", "user-a", "request-a")).resolves.toBe(false);
    await expect(claimErasureRequest(db as never, "other-org", "user-a", "request-a")).resolves.toBe(false);
    expect(db.db.prepare("SELECT status FROM gdpr_requests WHERE id = ?").get("request-a")).toEqual({ status: "processing" });

    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("request-b", "org-a", "erasure", "org_member", "user-a", "user-a", "pending");
    db.db.prepare("UPDATE orgs SET suspension_reason = 'admin' WHERE id = ?").run("org-a");
    await expect(claimErasureRequest(db as never, "org-a", "user-a", "request-b")).resolves.toBe(false);
    expect(db.db.prepare("SELECT status FROM gdpr_requests WHERE id = ?").get("request-b")).toEqual({ status: "pending" });
  });

  it("classifies every live space-scoped table as deleted or deliberately retained", async () => {
    const db = createFakeD1(platformMigrations);
    const retainedOrSeparatelyHandled = new Set([
      "developer_earnings_ledger", "launchpad_orders", "platform_provenance", "template_subscriptions",
      "portal_domains", "space_provisioning_leases", "usage_events", "wallet_transactions",
      "whop_payout_requests", "whop_sub_merchants", "website_connections",
      "assistant_communication_identities",
    ]);
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const scoped = new Set<string>();
    for (const { name } of tables) {
      const columns = await db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all<{ name: string }>();
      if (columns.results.some((column) => column.name === "space_id")) scoped.add(name);
    }
    const classified = new Set([...SPACE_ERASURE_TABLES, ...retainedOrSeparatelyHandled]);
    const unclassifiedSpaceTables = [...scoped].filter((table) => !classified.has(table)).sort();
    expect(unclassifiedSpaceTables, `Unclassified Space tables: ${unclassifiedSpaceTables.join(", ")}`).toEqual([]);
    expect([...SPACE_ERASURE_TABLES].filter((table) => !scoped.has(table)).sort()).toEqual([]);
  });

  it("classifies every live tenant-scoped table under an erasure or retention policy", async () => {
    const db = createFakeD1(platformMigrations);
    const handledTenantScoped = new Set([
      "api_keys", "builder_api_key_index", "do_registry", "eval_results", "gdpr_erasure_outbox",
      "gdpr_requests", "idempotency_keys", "launchpad_orders", "marketplace_forks",
      "marketplace_listings", "marketplace_reviews", "notifications", "org_members", "portal_domains", "assistant_sessions",
      "reseller_accounts", "service_accounts", "space_provisioning_leases", "space_type_tools",
      "spaces", "spacetypes", "subscriptions", "usage_events", "users", "web_push_subscriptions",
      "website_connections", "assistant_communication_identities",
    ]);
    // Financial records and immutable provenance are deliberately retained; their schedules need a
    // separate policy rather than being removed by account erasure.
    const retainedTenantScoped = new Set([
      "audit_log", "invoices", "llm_token_run_settlements", "marketplace_license_overpayments",
      "marketplace_license_purchases", "payout_requests", "platform_provenance",
    ]);
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const tenantScoped = new Set<string>();
    for (const { name } of tables) {
      const columns = await db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all<{ name: string }>();
      if (columns.results.some((column) => column.name === "tenant_id" || column.name === "org_id")) tenantScoped.add(name);
    }
    const classified = new Set([...SPACE_ERASURE_TABLES, ...handledTenantScoped, ...retainedTenantScoped]);
    const unclassifiedTenantTables = [...tenantScoped].filter((table) => !classified.has(table)).sort();
    expect(unclassifiedTenantTables, `Unclassified tenant tables: ${unclassifiedTenantTables.join(", ")}`).toEqual([]);
    expect([...handledTenantScoped, ...retainedTenantScoped].filter((table) => !tenantScoped.has(table)).sort()).toEqual([]);
  });

  it("removes searchable chunks and parent threads as well as session shadows", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare(`INSERT INTO kb_documents (id, space_id, tenant_id, title) VALUES (?, ?, ?, ?)`)
      .run("doc-a", "space-a", "tenant-a", "Document");
    db.db.prepare(`INSERT INTO kb_chunks (id, tenant_id, space_id, project_id, document_id, chunk_index,
      content, content_hash, visibility, required_role_rank, source_freshness, heading_path, r2_key,
      byte_start, byte_end, line_start, line_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("chunk-a", "tenant-a", "space-a", "project-a", "doc-a", 0, "secret", "hash", "space", 0,
        "fresh", "heading", "kb/space-a/project-a/doc-a/chunk.json", 0, 6, 1, 1, "2026-01-01");
    db.db.prepare(`INSERT INTO threads (id, space_id, tenant_id, end_user_id, summary)
      VALUES (?, ?, ?, ?, ?)`)
      .run("thread-a", "space-a", "tenant-a", "user-a", "private summary");
    db.db.prepare(`INSERT INTO thread_sessions (id, thread_id, space_id, tenant_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("session-a", "thread-a", "space-a", "tenant-a", "ended", "2026-01-01");
    db.db.prepare(`INSERT INTO space_credentials (id, space_id, tenant_id, name, encrypted_value, iv)
      VALUES (?, ?, ?, ?, ?, ?)`).run("credential-a", "space-a", "tenant-a", "API_KEY", "ciphertext", "iv");
    db.db.prepare(`INSERT INTO notifications (id, tenant_id, user_id, type, title, body)
      VALUES (?, ?, ?, ?, ?, ?)`).run("notification-a", "tenant-a", "user-a", "agent", "Secret", "Sensitive output");

    await eraseSpaceD1Records(db as never, "space-a");

    expect(db.db.prepare("SELECT COUNT(*) AS count FROM kb_chunks WHERE space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM kb_chunks_fts WHERE content = ?").get("secret"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM kb_documents WHERE space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM thread_sessions WHERE space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM threads WHERE space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_credentials WHERE space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
  });

  it("deletes assistant ingress, project aliases, approval, voice, and provisioning state by Space", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare(`INSERT INTO orgs (id,name,owner_id,plan_tier,status) VALUES(?,?,?,?,?)`)
      .run("tenant-a", "Tenant", "owner", "free", "active");
    db.db.prepare(`INSERT INTO spacetypes (id,org_id,name) VALUES(?,?,?)`)
      .run("type-a", "tenant-a", "Default");
    db.db.prepare(`INSERT INTO spaces (id,tenant_id,spacetype_id,name,status) VALUES(?,?,?,?,?)`)
      .run("space-a", "tenant-a", "type-a", "A", "active");
    db.db.prepare(`INSERT INTO spaces (id,tenant_id,spacetype_id,name,status) VALUES(?,?,?,?,?)`)
      .run("space-b", "tenant-a", "type-a", "B", "active");
    db.db.prepare(`INSERT INTO project_agent_email_addresses
      (address_hash,tenant_id,space_id,agent_id,project_id,status,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run("hash-a", "tenant-a", "space-a", "agent-a", "project-a", "active", "2026-01-01");
    db.db.prepare(`INSERT INTO project_agent_email_addresses
      (address_hash,tenant_id,space_id,agent_id,project_id,status,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run("hash-b", "tenant-a", "space-b", "agent-b", "project-b", "active", "2026-01-01");
    db.db.prepare(`INSERT INTO assistant_mail_ingress_usage(tenant_id,space_id,day,bytes,messages) VALUES(?,?,?,?,?)`)
      .run("tenant-a", "space-a", "2026-01-01", 512, 1);
    db.db.prepare(`INSERT INTO assistant_mail_ingress_usage(tenant_id,space_id,day,bytes,messages) VALUES(?,?,?,?,?)`)
      .run("tenant-a", "space-b", "2026-01-01", 256, 1);
    db.db.prepare(`INSERT INTO assistant_active_voice_endpoints
      (tenant_id,space_id,project_key,user_id,agent_name,connection_id,expires_at) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "user-a", "assistant", "connection-a", 1);
    db.db.prepare(`INSERT INTO assistant_approval_decisions
      (token_hash,tenant_id,space_id,approval_id,request_hash,user_id,channel,contact,decision,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run("token-a", "tenant-a", "space-a", "approval-a", "request-a", "user-a", "email", "x", "approve", 1);
    db.db.prepare(`INSERT INTO space_provisioning_outbox(space_id,tenant_id,payload_json) VALUES(?,?,?)`)
      .run("space-a", "tenant-a", '{"secret":"setup"}');

    await eraseSpaceD1Records(db as never, "space-a");

    for (const table of ["project_agent_email_addresses", "assistant_mail_ingress_usage",
      "assistant_active_voice_endpoints", "assistant_approval_decisions", "space_provisioning_outbox"]) {
      expect(db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE space_id = ?`).get("space-a"))
        .toEqual({ count: 0 });
    }
    expect(db.db.prepare("SELECT address_hash FROM project_agent_email_addresses").all())
      .toEqual([{ address_hash: "hash-b" }]);
    expect(db.db.prepare("SELECT space_id FROM assistant_mail_ingress_usage").all())
      .toEqual([{ space_id: "space-b" }]);
  });

  it("erases all blackboard cards, coordination events, and delivery state with their Space", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare("INSERT INTO orgs (id,name,owner_id,plan_tier,status) VALUES(?,?,?,?,?)")
      .run("tenant-a", "Tenant", "owner", "free", "active");
    db.db.prepare("INSERT INTO spacetypes (id,org_id,name) VALUES(?,?,?)").run("type-a", "tenant-a", "Default");
    db.db.prepare("INSERT INTO spaces (id,tenant_id,spacetype_id,name,status) VALUES(?,?,?,?,?)")
      .run("space-a", "tenant-a", "type-a", "A", "active");
    db.db.prepare(`INSERT INTO assistant_communication_identities (id,tenant_id,space_id,scope_key,owner_user_id)
      VALUES(?,?,?,?,?)`).run("identity-a", "tenant-a", "space-a", "space", "owner");
    db.db.prepare(`INSERT INTO space_blackboard_cards
      (tenant_id,space_id,project_id,summary,capabilities_json,evidence_json,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "Summary", "[]", "[]", "2026-01-01");
    db.db.prepare(`INSERT INTO space_blackboard_requests
      (tenant_id,space_id,id,source_project_id,target_project_id,objective,expected_result,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "request-a", "project-a", "project-b", "Help", "Result", "pending", "owner", "2026-01-01", "2026-01-01");
    db.db.prepare(`INSERT INTO space_blackboard_events
      (tenant_id,space_id,event_id,project_id,request_id,kind,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "event-a", "project-a", "request-a", "task.updated", "2026-01-01");
    db.db.prepare(`INSERT INTO space_blackboard_event_receipts
      (tenant_id,space_id,project_id,event_id,user_id,read_at) VALUES(?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "event-a", "owner", "2026-01-01");
    db.db.prepare(`INSERT INTO space_blackboard_delivery
      (tenant_id,space_id,project_id,event_id,identity_id,status,next_at) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "event-a", "identity-a", "pending", Date.now());
    db.db.prepare(`INSERT INTO space_blackboard_wakes
      (tenant_id,space_id,project_id,event_id,status,next_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "event-a", "pending", Date.now(), Date.now());
    db.db.prepare(`INSERT INTO space_blackboard_policies
      (tenant_id,space_id,project_id,wake_enabled,authorized_user_id,updated_at) VALUES(?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", 1, "owner", "2026-01-01");
    db.db.prepare(`INSERT INTO space_blackboard_sharing_policies
      (tenant_id,space_id,project_id,authorized_user_id,peers_json,daily_limit,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "owner", "[]", 5, "2026-01-01");
    db.db.prepare(`INSERT INTO space_blackboard_policy_uses
      (tenant_id,space_id,project_id,action_key,payload_hash,user_id,used_day) VALUES(?,?,?,?,?,?,?)`)
      .run("tenant-a", "space-a", "project-a", "action-a", "hash", "owner", "2026-01-01");

    await eraseSpaceD1Records(db as never, "space-a");

    for (const table of SPACE_ERASURE_TABLES.filter((name) => name.startsWith("space_blackboard_"))) {
      expect(db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE space_id=?`).get("space-a"), table)
        .toEqual({ count: 0 });
    }
  });

  it("erases platform assistant sessions and cascading messages by tenant", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare(`INSERT INTO assistant_sessions (id, tenant_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run("session-a", "tenant-a", "user-a", "2026-01-01", "2026-01-01");
    db.db.prepare(`INSERT INTO assistant_sessions (id, tenant_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run("session-b", "tenant-b", "user-b", "2026-01-01", "2026-01-01");
    db.db.prepare(`INSERT INTO assistant_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("message-a", "session-a", "user", "private tenant A text", "2026-01-01");
    db.db.prepare(`INSERT INTO assistant_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("message-b", "session-b", "user", "private tenant B text", "2026-01-01");

    await eraseOrgOperationalRecords(db as never, "tenant-a");

    expect(db.db.prepare("SELECT id FROM assistant_sessions ORDER BY id").all()).toEqual([{ id: "session-b" }]);
    expect(db.db.prepare("SELECT id, content FROM assistant_messages ORDER BY id").all())
      .toEqual([{ id: "message-b", content: "private tenant B text" }]);
  });

  it("clears credentials and login metadata while anonymizing only the target org", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare("INSERT INTO users (id, email, password_hash, org_id, preferred_language, last_login_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("user-a", "person@example.com", "credential-hash", "org-a", "en", "2026-01-01");
    db.db.prepare("INSERT INTO users (id, email, password_hash, org_id) VALUES (?, ?, ?, ?)")
      .run("user-b", "other@example.com", "other-hash", "org-b");
    db.db.prepare("INSERT INTO builder_password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run("reset-a", "user-a", "reset-hash", "2026-12-01");

    await anonymizeOrgUsers(db as never, "org-a");

    expect(db.db.prepare("SELECT COUNT(*) AS count FROM builder_password_reset_tokens WHERE user_id = ?").get("user-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT email, password_hash, preferred_language, last_login_at, status, org_id FROM users WHERE id = ?")
      .get("user-a")).toEqual({
      email: "erased-user-a@deleted.invalid", password_hash: null,
      preferred_language: null, last_login_at: null, status: "erased", org_id: "org-a",
    });
    expect(db.db.prepare("SELECT email, password_hash FROM users WHERE id = ?").get("user-b"))
      .toEqual({ email: "other@example.com", password_hash: "other-hash" });
  });

  it("removes tenant access and notification records but retains erasure audit context", async () => {
    const db = createFakeD1(platformMigrations);
    db.db.prepare("INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES (?, ?, ?, ?)").run("org-a", "Acme", "user-a", "free");
    db.db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)").run("org-a", "user-a", "owner");
    db.db.prepare("INSERT INTO users (id, email, org_id) VALUES (?, ?, ?)").run("user-a", "person@example.com", "org-a");
    db.db.prepare("INSERT INTO notifications (id, tenant_id, user_id, type, title, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run("n-a", "org-a", "user-a", "agent", "Private", "Body");
    db.db.prepare("INSERT INTO spaces (id, tenant_id, spacetype_id, name) VALUES (?, ?, ?, ?)")
      .run("space-a", "org-a", "type-a", "Acme space");
    db.db.prepare("INSERT INTO template_subscriptions (id, space_id, template_id, developer_user_id, attribution_channel) VALUES (?, ?, ?, ?, ?)")
      .run("sub-a", "space-a", "template-a", "developer-a", "MARKETPLACE_ORGANIC");
    db.db.prepare("INSERT INTO whop_sub_merchants (id, tenant_id, space_id, company_id, owner_email) VALUES (?, ?, ?, ?, ?)")
      .run("merchant-a", "org-a", "space-a", "company-a", "person@example.com");
    db.db.prepare("INSERT INTO launchpad_orders (id, space_id, tenant_id, customer_email, customer_name, ls_order_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run("order-a", "space-a", "org-a", "buyer@example.com", "Buyer Name", "provider-order-a");
    db.db.prepare("INSERT INTO product_end_users (product_space_id, end_user_id, email, display_name) VALUES (?, ?, ?, ?)")
      .run("space-a", "end-user-a", "end-user@example.com", "End User");
    db.db.prepare("INSERT INTO password_reset_tokens (id, product_space_id, end_user_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("reset-a", "space-a", "end-user-a", "hash-a", "2026-12-01");
    db.db.prepare("INSERT INTO email_verification_tokens (id, product_space_id, end_user_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("verify-a", "space-a", "end-user-a", "hash-b", "2026-12-01");
    db.db.prepare("INSERT INTO builder_password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run("builder-reset-a", "user-a", "hash-c", "2026-12-01");
    db.db.prepare("INSERT INTO business_invites (id, business_space_id, product_space_id, email, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("invite-a", "space-a", "space-a", "invitee@example.com", "token-hash", "user-a", "2026-12-01");
    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, subject_email, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("gdpr-a", "org-a", "export", "org_member", "user-a", "person@example.com", "user-a");
    db.db.prepare("INSERT INTO gdpr_requests (id, tenant_id, request_type, subject_type, subject_id, requested_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run("erasure-a", "org-a", "erasure", "org_member", "user-a", "user-a");
    db.db.prepare("INSERT INTO gdpr_erasure_outbox (request_id, tenant_id, payload_json) VALUES (?, ?, ?)")
      .run("erasure-a", "org-a", JSON.stringify({ requestedBy: "user-a", reason: "private reason" }));
    db.db.prepare("INSERT INTO portal_domains (kind, hostname, tenant_id, space_id) VALUES (?, ?, ?, ?)")
      .run("domain", "private.example", "org-a", "space-a");
    db.db.prepare("INSERT INTO idempotency_keys (id, tenant_id, resource_type, request_hash, response_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("idem-a", "org-a", "api_call", "private-hash", "private-response", "2099-01-01");
    db.db.prepare("INSERT INTO space_provisioning_leases (space_id, tenant_id, lease_token, lease_expires_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("space-a", "org-a", "private-lease-token", 9999999999, 9999999999);
    db.db.prepare("INSERT INTO eval_suites (id, space_id, tenant_id, name) VALUES (?, ?, ?, ?)")
      .run("suite-a", "space-a", "org-a", "Sensitive evaluation");
    db.db.prepare("INSERT INTO eval_runs (id, suite_id, space_id, tenant_id) VALUES (?, ?, ?, ?)")
      .run("run-a", "suite-a", "space-a", "org-a");
    db.db.prepare("INSERT INTO eval_results (id, run_id, suite_id, tenant_id, case_index, input, actual_output) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("result-a", "run-a", "suite-a", "org-a", 0, "private input", "private output");
    db.db.prepare("INSERT INTO marketplace_listings (id, space_type_id, tenant_id, author_name, name, description, long_description, tags_json, preview_config_json, embedding_json, conformance_artifact_json, conformance_certificate_json, developer_user_id, ls_license_provisioning_token, ls_license_provisioning_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("listing-a", "type-a", "org-a", "Person Name", "Private listing", "Private description", "Private detail", '["private"]', "private-preview", "private-vector", "private-artifact", "private-certificate", "user-a", "private-token", 123);
    db.db.prepare("INSERT INTO marketplace_reviews (id, listing_id, tenant_id, reviewer_name, rating, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run("review-a", "listing-a", "org-a", "Person Name", 5, "Private review");
    db.db.prepare("INSERT INTO marketplace_forks (id, tenant_id, listing_id, blueprint_id, artifact_json, certificate_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("fork-a", "org-a", "listing-a", "blueprint-a", "private-fork", "private-cert");
    db.db.prepare("INSERT INTO marketplace_license_purchases (id, provider_event_id, tenant_id, listing_id, buyer_space_id, amount_cents) VALUES (?, ?, ?, ?, ?, ?)")
      .run("purchase-a", "provider-event-a", "org-a", "listing-a", "space-a", 5000);
    db.db.prepare("INSERT INTO marketplace_license_overpayments (provider_event_id, purchase_id, tenant_id, listing_id, amount_cents) VALUES (?, ?, ?, ?, ?)")
      .run("provider-overpayment-a", "purchase-a", "org-a", "listing-a", 5000);
    db.db.prepare("INSERT INTO developer_partner_profiles (user_id, handle, payout_destination) VALUES (?, ?, ?)")
      .run("user-a", "private-handle", "private-destination");
    db.db.prepare("INSERT INTO reseller_accounts (tenant_id, product_space_id) VALUES (?, ?)")
      .run("org-a", "space-a");
    db.db.prepare("INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, child_owner_user_id) VALUES (?, ?, ?, ?, ?)")
      .run("org-a", "parent-org", "parent-space", "space-a", "user-a");
    db.db.prepare("INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, event_type, resource_type, resource_id, event_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("audit-a", "org-a", "user-a", "user", "erasure_requested", "org", "org-a", "{}");

    await anonymizeOrgUsers(db as never, "org-a");
    await eraseOrgOperationalRecords(db as never, "org-a");

    expect(db.db.prepare("SELECT COUNT(*) AS count FROM org_members WHERE org_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM portal_domains WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM eval_results WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM space_provisioning_leases WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM gdpr_erasure_outbox WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT status, author_name, name, description, long_description, tags_json, preview_config_json, embedding_json, reviewed_by, review_note, conformance_artifact_json, conformance_certificate_json, developer_user_id, ls_license_provisioning_token, ls_license_provisioning_started_at FROM marketplace_listings WHERE id = ?").get("listing-a"))
      .toEqual({ status: "archived", author_name: "Erased publisher", name: "Unavailable listing", description: "This listing is no longer available.", long_description: null, tags_json: "[]", preview_config_json: null, embedding_json: null, reviewed_by: null, review_note: null, conformance_artifact_json: null, conformance_certificate_json: null, developer_user_id: null, ls_license_provisioning_token: null, ls_license_provisioning_started_at: null });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM marketplace_reviews WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM marketplace_forks WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM marketplace_license_purchases WHERE tenant_id = ?").get("org-a")).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM marketplace_license_overpayments WHERE tenant_id = ?").get("org-a")).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM developer_partner_profiles WHERE user_id = ?").get("user-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM reseller_accounts WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT status, child_owner_user_id FROM tenant_hierarchy WHERE child_tenant_id = ?").get("org-a"))
      .toEqual({ status: "terminated", child_owner_user_id: null });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE tenant_id = ?").get("org-a")).toEqual({ count: 1 });
    expect(db.db.prepare("SELECT status FROM template_subscriptions WHERE id = ?").get("sub-a")).toEqual({ status: "cancelled" });
    expect(db.db.prepare("SELECT owner_email FROM whop_sub_merchants WHERE id = ?").get("merchant-a"))
      .toEqual({ owner_email: "erased@deleted.invalid" });
    expect(db.db.prepare("SELECT customer_email, customer_name, ls_order_id, gross_cents FROM launchpad_orders WHERE id = ?").get("order-a"))
      .toEqual({ customer_email: "erased@deleted.invalid", customer_name: null, ls_order_id: null, gross_cents: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM product_end_users WHERE product_space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE product_space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM email_verification_tokens WHERE product_space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM builder_password_reset_tokens WHERE user_id = ?").get("user-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM business_invites WHERE business_space_id = ?").get("space-a"))
      .toEqual({ count: 0 });
    expect(db.db.prepare("SELECT subject_id, subject_email FROM gdpr_requests WHERE id = ?").get("gdpr-a"))
      .toEqual({ subject_id: "erased", subject_email: null });
    expect(db.db.prepare("SELECT org_id FROM users WHERE id = ?").get("user-a")).toEqual({ org_id: null });
    expect(db.db.prepare("SELECT name, owner_id, status FROM orgs WHERE id = ?").get("org-a"))
      .toEqual({ name: "Erased organization", owner_id: "system-erasure", status: "erased" });
  });
});
