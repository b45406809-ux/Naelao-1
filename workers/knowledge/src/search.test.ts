import { describe, expect, it, vi } from "vitest";
import { hybridRank, queryScopedFtsCandidates, sparseRank } from "./search.js";
import type { GroundedSearchHit } from "@naelao/rag";

function hit(id: string, content: string): GroundedSearchHit {
  return { id, score: 0.5, content, r2Key: `kb/${id}`, byteStart: 0, byteEnd: content.length };
}

describe("Knowledge Worker sparse ranking bounds", () => {
  it("ranks only the supplied candidate set and retains the original full hit", () => {
    const relevant = hit("relevant", "The customer requires an audit export");
    const irrelevant = hit("irrelevant", "A different topic");
    expect(sparseRank("audit export", [irrelevant, relevant])[0]).toMatchObject({ id: relevant.id, content: relevant.content });
    expect(hybridRank("audit export", [relevant], [irrelevant, relevant])[0]?.id).toBe("relevant");
  });

  it("rejects empty or oversized queries and broad candidate populations", () => {
    const candidates = [hit("one", "hello")];
    expect(() => sparseRank(" ", candidates)).toThrow(RangeError);
    expect(() => sparseRank("q".repeat(1_001), candidates)).toThrow(RangeError);
    expect(() => sparseRank("query", Array.from({ length: 201 }, (_, i) => hit(String(i), "x"))))
      .toThrow(/at most 200/);
  });

  it("caps text scanned per candidate while keeping returned content unchanged", () => {
    const large = hit("large", `audit ${"noise ".repeat(10_000)}`);
    expect(sparseRank("audit", [large])[0]?.content).toBe(large.content);
    const lateMatch = hit("late", `${"noise ".repeat(4_000)} audit`);
    expect(sparseRank("audit", [lateMatch])).toEqual([]);
    expect(() => sparseRank("audit", [{ ...large, content: 1 as never }])).toThrow(TypeError);
  });
});

describe("independent permissioned FTS candidate generation", () => {
  it("scopes FTS rows by tenant, Space, Project, role, document status and user ACL before ranking", async () => {
    const all = vi.fn(async () => ({ results: [{
      id: "allowed_chunk_0", content: "exact audit identifier", r2_key: "kb/allowed", byte_start: 0,
      content_hash: "b".repeat(64), byte_end: 22, line_start: 1, line_end: 1, heading_path: '["Page 2","Table 1"]',
      title: "Allowed source", source_adapter: "connector", source_revision: 4,
      source_content_sha256: "a".repeat(64), source_grant_revision: 3,
    }] }));
    let boundArgs: unknown[] = [];
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => { boundArgs = args; return { all: () => all() }; }),
      sql,
    }));
    const db = { prepare } as unknown as D1Database;
    const results = await queryScopedFtsCandidates({
      db, query: 'audit* OR "private"', tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a",
      userId: "user-a", roleRank: 20,
    });

    expect(results).toEqual([expect.objectContaining({ id: "allowed_chunk_0", title: "Allowed source", score: 0,
      sourceRevision: 4, sourceAdapter: "connector", sourceContentSha256: "a".repeat(64), sourceGrantRevision: 3,
      contentHash: "b".repeat(64), headingPath: ["Page 2", "Table 1"] })]);
    const sql = prepare.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("kb_chunks_fts MATCH ?");
    expect(sql).toContain("k.tenant_id = ? AND k.space_id = ? AND k.project_id = ? AND k.required_role_rank <= ?");
    expect(sql).toContain("d.status='indexed'");
    expect(sql).toContain("d.source_state='current'");
    expect(sql).toContain("json_each(d.allowed_user_ids_json) acl WHERE acl.value=?");
    expect(sql).toContain("ORDER BY bm25(kb_chunks_fts) ASC");
    expect(sql.match(/k\.tenant_id = \? AND k\.space_id = \? AND k\.project_id = \? AND k\.required_role_rank <= \?/g)).toHaveLength(1);
    expect(sql.indexOf("AND k.deleted_at IS NULL")).toBeLessThan(sql.indexOf("ORDER BY bm25"));
    expect(boundArgs).toEqual([
      '("audit" OR "OR" OR "private") OR "audit OR private"', "tenant-a", "space-a", "project-a", 20, "user-a", 200,
    ]);
  });

  it("does not invoke FTS for punctuation-only queries and enforces a bounded candidate count", async () => {
    const prepare = vi.fn();
    const db = { prepare } as unknown as D1Database;
    await expect(queryScopedFtsCandidates({
      db, query: "*** !!!", tenantId: "tenant-a", spaceId: "space-a", projectId: "_space",
      userId: "user-a", roleRank: 20,
    })).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    await expect(queryScopedFtsCandidates({
      db, query: "policy", tenantId: "tenant-a", spaceId: "space-a", projectId: "_space",
      userId: "user-a", roleRank: 20, limit: 201,
    })).rejects.toThrow(/candidate limit/);
  });
});
