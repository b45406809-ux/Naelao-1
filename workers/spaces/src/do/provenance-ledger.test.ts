import { describe, expect, it } from "vitest";
import { PROVENANCE_GENESIS_HASH, provenanceHmac, SpaceDO } from "./SpaceDO.js";

describe("provenance hash chain", () => {
  it("links entries and detects tampering", async () => {
    const fields = [PROVENANCE_GENESIS_HASH, "human", "assistant", "executor", "a".repeat(40), "2026-01-01T00:00:00.000Z"];
    const hash = await provenanceHmac("audit-secret", fields);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await provenanceHmac("audit-secret", fields)).toBe(hash);
    expect(await provenanceHmac("audit-secret", [...fields.slice(0, 2), "tampered", ...fields.slice(3)])).not.toBe(hash);
    const next = await provenanceHmac("audit-secret", [hash, ...fields.slice(1)]);
    expect(next).not.toBe(hash);
  });

  it("appends through SpaceDO and verifies the persisted chain", async () => {
    const entries: Array<Record<string, string | null>> = [];
    const sql = {
      exec(query: string, ...args: unknown[]) {
        const lower = query.toLowerCase();
        if (lower.includes("select entry_hash from provenance_ledger")) {
          const latest = entries[entries.length - 1];
          return { toArray: () => latest ? [{ entry_hash: latest.entry_hash }] : [] };
        }
        if (lower.includes("insert into provenance_ledger")) {
          const [entry_hash, prev_hash, human_trigger_id, assistant_actor_id, project_executor_id, git_commit_oid, task_id, created_at] = args.map(String);
          entries.push({ entry_hash, prev_hash, human_trigger_id, assistant_actor_id, project_executor_id, git_commit_oid, task_id, created_at });
          return { rowsWritten: 1, toArray: () => [] };
        }
        if (lower.includes("select * from provenance_ledger")) return { toArray: () => entries };
        return { rowsWritten: 1, toArray: () => [] };
      },
    };
    const instance = new SpaceDO({
      storage: { sql, transactionSync: (fn: () => unknown) => fn(), deleteAlarm: async () => undefined, setAlarm: async () => undefined },
    } as never, { PLATFORM_SECRET: "audit-secret" } as never);
    const base = { human_trigger_id: "human", assistant_actor_id: "assistant", project_executor_id: "executor", git_commit_oid: "a".repeat(40) };
    const first = await instance.fetch(new Request("https://space/provenance", { method: "POST", body: JSON.stringify({ ...base, created_at: "2026-01-01T00:00:00.000Z" }) }));
    expect(first.status).toBe(201);
    const second = await instance.fetch(new Request("https://space/provenance", { method: "POST", body: JSON.stringify({ ...base, git_commit_oid: "b".repeat(40), created_at: "2026-01-01T00:01:00.000Z" }) }));
    expect(second.status).toBe(201);
    const verified = await instance.fetch(new Request("https://space/provenance/verify"));
    expect(await verified.json()).toEqual({ valid: true, entries: 2 });
    entries[0]!.git_commit_oid = "c".repeat(40);
    const tampered = await instance.fetch(new Request("https://space/provenance/verify"));
    expect((await tampered.json() as { valid: boolean }).valid).toBe(false);
  });
});
