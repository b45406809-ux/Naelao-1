import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anonymizeOrgUsers, eraseSpaceD1Records } from "../../workers/workflows/src/workflows/erasure-cleanup.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8");

describe("data erasure D1 records", () => {
  it("removes searchable chunks and parent threads as well as session shadows", async () => {
    const db = createFakeD1([
      migration("0006_kb_documents.sql"),
      migration("0018_active_sessions.sql"),
      migration("0027_threads.sql"),
      migration("0029_thread_sessions.sql"),
      migration("0051_kb_documents_project.sql"),
      migration("0074_items_45_87_security_models.sql"),
      migration("0114_thread_last_active_at.sql"),
    ]);
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
  });

  it("clears credentials and login metadata while anonymizing only the target org", async () => {
    const db = createFakeD1([
      migration("0001_users.sql"),
      "ALTER TABLE users ADD COLUMN preferred_language TEXT;",
    ]);
    db.db.prepare("INSERT INTO users (id, email, password_hash, org_id, preferred_language, last_login_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("user-a", "person@example.com", "credential-hash", "org-a", "en", "2026-01-01");
    db.db.prepare("INSERT INTO users (id, email, password_hash, org_id) VALUES (?, ?, ?, ?)")
      .run("user-b", "other@example.com", "other-hash", "org-b");

    await anonymizeOrgUsers(db as never, "org-a");

    expect(db.db.prepare("SELECT email, password_hash, preferred_language, last_login_at, status FROM users WHERE id = ?")
      .get("user-a")).toEqual({
      email: "erased-user-a@deleted.invalid", password_hash: null,
      preferred_language: null, last_login_at: null, status: "erased",
    });
    expect(db.db.prepare("SELECT email, password_hash FROM users WHERE id = ?").get("user-b"))
      .toEqual({ email: "other@example.com", password_hash: "other-hash" });
  });
});
