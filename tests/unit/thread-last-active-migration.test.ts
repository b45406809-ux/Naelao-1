import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8");

describe("thread activity migration", () => {
  it("adds and backfills last_active_at for existing threads", () => {
    const db = createFakeD1([
      migration("0027_threads.sql"),
      migration("0029_thread_sessions.sql"),
    ]);
    db.db.prepare(`INSERT INTO threads (id, space_id, tenant_id, end_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("thread-a", "space-a", "tenant-a", "user-a", "2026-01-01", "2026-01-02");

    db.db.exec(migration("0114_thread_last_active_at.sql"));

    expect(db.db.prepare("SELECT last_active_at FROM threads WHERE id = ?").get("thread-a"))
      .toEqual({ last_active_at: "2026-01-02" });
    expect(db.db.prepare("PRAGMA index_list(threads)").all()).toContainEqual(
      expect.objectContaining({ name: "idx_threads_tenant_activity" }),
    );
  });
});
