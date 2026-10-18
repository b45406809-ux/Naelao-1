import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { opaqueExternalSubject } from "../../workers/agents/src/channel-external-quota.js";
import { recordExternalMessage } from "../../workers/spaces/src/project-external-quota.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function quotaDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE project_external_quota_decisions (
    event_id TEXT NOT NULL, project_id TEXT NOT NULL, installation_id TEXT NOT NULL, provider TEXT NOT NULL,
    subject_hash TEXT NOT NULL, day TEXT NOT NULL, allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
    count_after INTEGER NOT NULL, daily_cap INTEGER NOT NULL, owner_notified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY(installation_id,provider,event_id)
  )`);
  db.exec(`CREATE TABLE project_external_quota_subject_usage (
    project_id TEXT NOT NULL, provider TEXT NOT NULL, subject_hash TEXT NOT NULL, day TEXT NOT NULL,
    message_count INTEGER NOT NULL CHECK(message_count >= 0), updated_at INTEGER NOT NULL, owner_notified_at INTEGER,
    PRIMARY KEY(project_id,provider,subject_hash,day)
  )`);
  db.exec(`CREATE TABLE project_external_quota_usage (
    project_id TEXT NOT NULL, installation_id TEXT NOT NULL, provider TEXT NOT NULL, subject_hash TEXT NOT NULL,
    day TEXT NOT NULL, message_count INTEGER NOT NULL CHECK(message_count > 0), updated_at INTEGER NOT NULL, owner_notified_at INTEGER,
    PRIMARY KEY(project_id,installation_id,provider,subject_hash,day)
  )`);
  return {
    exec(sql: string, ...bindings: unknown[]) {
      const statement = db.prepare(sql);
      if (/\bRETURNING\b/i.test(sql)) {
        const rows = statement.all(...bindings as never[]) as Array<{ message_count?: number }>;
        return { rowsWritten: rows.length, toArray: () => rows };
      }
      if (/^\s*SELECT\b/i.test(sql)) {
        const rows = statement.all(...bindings as never[]);
        return { rowsWritten: 0, toArray: () => rows };
      }
      const result = statement.run(...bindings as never[]);
      return { rowsWritten: Number(result.changes), toArray: () => [] };
    },
  };
}

describe("external channel message quotas", () => {
  it("enforces the daily limit across a sender's project extension instances", async () => {
    const sql = quotaDb();
    const subject = await opaqueExternalSubject("test-secret", ["tenant", "space", "project", "install", "whatsapp", "+15550001"]);
    const input = { eventId: "event-1", projectId: "project", installationId: "install", provider: "whatsapp", subjectHash: subject, day: "2026-10-17", dailyCap: 2 };
    expect(recordExternalMessage(sql, input)).toEqual({ allowed: true, count: 1, deduplicated: false, notifyOwner: false });
    expect(recordExternalMessage(sql, input)).toEqual({ allowed: true, count: 1, deduplicated: true, notifyOwner: false });
    expect(recordExternalMessage(sql, { ...input, eventId: "event-2" })).toEqual({ allowed: true, count: 2, deduplicated: false, notifyOwner: false });
    expect(recordExternalMessage(sql, { ...input, eventId: "event-3" })).toEqual({ allowed: false, count: 2, deduplicated: false, notifyOwner: true });
    expect(recordExternalMessage(sql, { ...input, eventId: "event-4" })).toEqual({ allowed: false, count: 2, deduplicated: false, notifyOwner: false });
    expect(recordExternalMessage(sql, { ...input, eventId: "event-3" })).toEqual({ allowed: false, count: 2, deduplicated: true, notifyOwner: false });
    expect(recordExternalMessage(sql, { ...input, installationId: "other-install" })).toMatchObject({ allowed: false, count: 2, deduplicated: false });
    expect(recordExternalMessage(sql, { ...input, eventId: "other-person", subjectHash: await opaqueExternalSubject("test-secret", ["tenant", "space", "project", "install", "whatsapp", "+15550002"]) })).toMatchObject({ allowed: true, count: 1 });
    expect(recordExternalMessage(sql, { ...input, eventId: "other-install", installationId: "other-install" })).toMatchObject({ allowed: false, count: 2 });
    expect(recordExternalMessage(sql, { ...input, eventId: "other-day", day: "2026-10-18" })).toMatchObject({ allowed: true, count: 1 });
  });

  it("stores only a keyed opaque sender identifier", async () => {
    const source = ["tenant", "space", "project", "install", "whatsapp", "+15550001"] as const;
    const hash = await opaqueExternalSubject("test-secret", source);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("15550001");
    await expect(opaqueExternalSubject("other-secret", source)).resolves.not.toBe(hash);
    await expect(opaqueExternalSubject("", source)).rejects.toThrow("external_quota_hash_key_missing");
  });

  it("carries forward this installation's old daily usage during quota aggregation rollout", () => {
    const sql = quotaDb();
    const legacyHash = "a".repeat(64);
    sql.exec("INSERT INTO project_external_quota_usage(project_id,installation_id,provider,subject_hash,day,message_count,updated_at) VALUES(?,?,?,?,?,?,?)",
      "p", "install-a", "whatsapp", legacyHash, "2026-10-17", 2, Date.now());
    const input = { eventId: "first-global", projectId: "p", installationId: "install-a", provider: "whatsapp", subjectHash: "b".repeat(64), legacySubjectHash: legacyHash, day: "2026-10-17", dailyCap: 3 };
    expect(recordExternalMessage(sql, input)).toMatchObject({ allowed: true, count: 3 });
    expect(recordExternalMessage(sql, { ...input, eventId: "next-install", installationId: "install-b", legacySubjectHash: undefined })).toMatchObject({ allowed: false, count: 3 });
  });

  it("treats a zero cap as unlimited", () => {
    const sql = quotaDb();
    const input = { eventId: "event-1", projectId: "p", installationId: "i", provider: "telegram", subjectHash: "opaque", day: "2026-10-17", dailyCap: 0 };
    expect(recordExternalMessage(sql, input).allowed).toBe(true);
    expect(recordExternalMessage(sql, { ...input, eventId: "event-2" }).allowed).toBe(true);
    expect(recordExternalMessage(sql, { ...input, eventId: "event-3" })).toMatchObject({ allowed: true, count: 3, notifyOwner: false });
  });
});
