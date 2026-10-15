import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "attachment-index-secret";
const row = { id: "opaque-id", channel: "email", filename: "scan.pdf", mime_type: "application/pdf", size_bytes: 2048, created_at: "2026-10-15T00:00:00.000Z", expires_at: "2026-11-14T00:00:00.000Z" };

function env(options: { owned?: boolean } = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  return {
    queries,
    value: {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: {
        prepare(sql: string) {
          return { bind(...values: unknown[]) {
            queries.push({ sql, values });
            return {
              async all() { return { results: [row] }; },
              async first() { return options.owned === false ? null : row; },
            };
          } };
        },
      },
    } as never,
  };
}

async function post(path: string, context: ReturnType<typeof env>, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
    body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a", ...body }),
  }, context.value);
}

describe("scoped attachment metadata routes", () => {
  it("lists metadata only within the active tenant, Space, and task", async () => {
    const context = env();
    const response = await post("/internal/attachments/list", context, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachments: [row] });
    expect(context.queries[0]?.sql).toContain("tenant_id=? AND space_id=? AND task_id=? AND expires_at>?");
    expect(context.queries[0]?.values.slice(0, 3)).toEqual(["tenant-a", "space-a", "task-a"]);
  });

  it("inspects metadata without accessing object storage and hides cross-task ids", async () => {
    const context = env();
    const response = await post("/internal/attachments/inspect", context, { id: row.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachment: row });
    expect(context.queries[0]?.sql).toContain("id=? AND tenant_id=? AND space_id=? AND task_id=? AND expires_at>?");
    expect(context.queries[0]?.values.slice(0, 4)).toEqual([row.id, "tenant-a", "space-a", "task-a"]);

    const foreign = await post("/internal/attachments/inspect", env({ owned: false }), { id: row.id });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error_code: "attachment_not_found" });
  });
});
