import { describe, it, expect, vi } from "vitest";
import knowledgeWorker from "../../workers/knowledge/src/index.js";
import { mintInternalToken } from "@naelao/http";

// F8: kb/documents/* routes already scope every SQL query by `WHERE space_id = ? AND
// tenant_id = ?`, so a foreign spaceId just matches zero rows there. kb/search had no such
// scoping at all — it filtered Vectorize by space_id alone — so a caller who merely
// knows/guesses another tenant's spaceId could search that tenant's KB. This proves the added
// ownership check rejects a spaceId that doesn't belong to the requesting tenant, and that a
// legitimately owned space still reaches the Vectorize query.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(opts: { ownerTenantId: string; vectorizeQuery: ReturnType<typeof vi.fn> }) {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          (stmt as unknown as { _args: unknown[] })._args = args;
          return stmt;
        },
        async first() {
          if (/SELECT config_json FROM spaces/.test(sql)) return { config_json: "{}" };
          if (/FROM spaces s JOIN orgs o/.test(sql) || /FROM spaces WHERE/.test(sql)) {
            const args = (stmt as unknown as { _args: unknown[] })._args;
            const [, tenantId] = args;
            return tenantId === opts.ownerTenantId ? { 1: 1 } : null;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  const kv = { async get() { return null; }, async put() {}, async delete() {} };
  const ai = { async run() { return { data: [{ embedding: new Array(8).fill(0.1) }] }; } };
  const vectors = { query: opts.vectorizeQuery };
  return {
    PLATFORM_SECRET: SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: db,
    KB_CACHE: kv,
    KB_VECTORS: vectors,
    KB_BUCKET: { async get() { return null; } },
    AI: ai,
  };
}

describe("knowledge worker — GET /spaces/:spaceId/kb/search tenant isolation", () => {
  it("rejects a search against a spaceId owned by a different tenant, before ever querying Vectorize", async () => {
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] });
    const token = await mintInternalToken(SECRET, "attacker-tenant");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/victim-space/kb/search?q=secret", {
        headers: { "x-naelao-tenant-id": "attacker-tenant", "x-naelao-internal-token": token, "x-naelao-role": "owner", "x-naelao-user-id": "builder" },
      }),
      makeEnv({ ownerTenantId: "victim-tenant", vectorizeQuery }) as never,
      execCtx
    );
    expect(res.status).toBe(404);
    expect(vectorizeQuery).not.toHaveBeenCalled();
  });

  it("allows a search against a spaceId owned by the requesting tenant", async () => {
    const vectorizeQuery = vi.fn().mockResolvedValue({ matches: [] });
    const token = await mintInternalToken(SECRET, "owner-tenant");
    const res = await knowledgeWorker.fetch(
      new Request("https://knowledge.naelao.com/spaces/my-space/kb/search?q=hello", {
        headers: { "x-naelao-tenant-id": "owner-tenant", "x-naelao-internal-token": token, "x-naelao-role": "owner", "x-naelao-user-id": "builder" },
      }),
      makeEnv({ ownerTenantId: "owner-tenant", vectorizeQuery }) as never,
      execCtx
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(vectorizeQuery).toHaveBeenCalledTimes(1);
    expect(vectorizeQuery.mock.calls[0]?.[1]).toMatchObject({ filter: { space_id: { $eq: "my-space" } } });
  });
});
