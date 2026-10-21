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
      "usage_events", "wallet_transactions", "whop_payout_requests", "whop_sub_merchants",
    ]);
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const scoped = new Set<string>();
    for (const { name } of tables) {
      const columns = await db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all<{ name: string }>();
      if (columns.results.some((column) => column.name === "space_id")) scoped.add(name);
    }
    const classified = new Set([...SPACE_ERASURE_TABLES, ...retainedOrSeparatelyHandled]);
    expect([...scoped].filter((table) => !classified.has(table)).sort()).toEqual([]);
    expect([...SPACE_ERASURE_TABLES].filter((table) => !scoped.has(table)).sort()).toEqual([]);
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
    db.db.prepare("INSERT INTO audit_log (id, tenant_id, actor_id, actor_type, event_type, resource_type, resource_id, event_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("audit-a", "org-a", "user-a", "user", "erasure_requested", "org", "org-a", "{}");

    await anonymizeOrgUsers(db as never, "org-a");
    await eraseOrgOperationalRecords(db as never, "org-a");

    expect(db.db.prepare("SELECT COUNT(*) AS count FROM org_members WHERE org_id = ?").get("org-a")).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE tenant_id = ?").get("org-a")).toEqual({ count: 0 });
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
