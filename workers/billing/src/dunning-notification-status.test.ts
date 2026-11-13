import { describe, expect, it } from "vitest";
import worker from "./index.js";

function database() {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        queries.push({ sql, args });
        return { async all() {
          return { results: [{ notification_id: `dunning-${"a".repeat(64)}`, provider_outcome: "provider_accepted", attempt_count: 2 }] };
        } };
      } };
    },
  } as unknown as D1Database;
  return { db, queries };
}

async function request(db: D1Database, headers: Record<string, string> = {}) {
  return worker.fetch!(new Request("https://billing.test/billing/dunning-notifications", { headers }), {
    PLATFORM_SECRET: "test-secret", PLATFORM_DB: db,
  } as never, {} as ExecutionContext);
}

describe("owner billing notice status", () => {
  it("requires a verified tenant and owner/admin role before reading attempts", async () => {
    const missingTenant = database();
    expect((await request(missingTenant.db)).status).toBe(401);
    expect(missingTenant.queries).toHaveLength(0);

    const member = database();
    expect((await request(member.db, { "x-naelao-tenant-id": "org-1", "x-naelao-role": "member" })).status).toBe(403);
    expect(member.queries).toHaveLength(0);
  });

  it("returns only the current tenant's platform subscription provider outcomes", async () => {
    const context = database();
    const response = await request(context.db, { "x-naelao-tenant-id": "org-1", "x-naelao-role": "owner" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ provider_outcome: "provider_accepted", attempt_count: 2 }] });
    expect(context.queries).toHaveLength(1);
    expect(context.queries[0]?.sql).toContain("subscription_scope='platform_subscription'");
    expect(context.queries[0]?.sql).toContain("WHERE tenant_id=?");
    expect(context.queries[0]?.args).toEqual(["org-1"]);
    expect(context.queries[0]?.sql).toContain("LIMIT 50");
  });
});
