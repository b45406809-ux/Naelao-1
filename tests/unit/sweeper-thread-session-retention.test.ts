import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanOldSessions } from "../../workers/sweeper/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const migration = (name: string) => readFileSync(join(__dirname, `../../infra/migrations/${name}`), "utf8");

describe("ended thread session retention", () => {
  it("deletes expired sessions and recalculates the parent count atomically", async () => {
    const db = createFakeD1([
      migration("0018_active_sessions.sql"),
      migration("0027_threads.sql"),
      migration("0029_thread_sessions.sql"),
      migration("0114_thread_last_active_at.sql"),
    ]);
    db.db.prepare(`INSERT INTO threads (id, space_id, tenant_id, end_user_id, session_count)
      VALUES (?, ?, ?, ?, ?)`).run("thread-a", "space-a", "tenant-a", "user-a", 2);
    db.db.prepare(`INSERT INTO thread_sessions (id, thread_id, space_id, tenant_id, end_user_id, status, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`)
      .run("session-old", "thread-a", "space-a", "tenant-a", "user-a", "ended", "2020-01-01",
        "session-active", "thread-a", "space-a", "tenant-a", "user-a", "active", null);

    await expect(cleanOldSessions(db as never)).resolves.toBe(1);
    expect(db.db.prepare("SELECT session_count FROM threads WHERE id = ?").get("thread-a"))
      .toEqual({ session_count: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM thread_sessions WHERE id = ?").get("session-old"))
      .toEqual({ count: 0 });
  });
});
