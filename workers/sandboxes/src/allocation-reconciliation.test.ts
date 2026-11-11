import { describe, expect, it, vi } from "vitest";
import { sealConnection } from "./connection-crypto.js";
import { runSandboxAllocationReconciliation } from "./provider-deletion-reconciliation.js";

class FakeDb {
  statements: Array<{ sql: string; values: unknown[] }> = [];
  status = "unknown";
  constructor(readonly allocation: Record<string, unknown>) {}
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async () => null,
      all: async () => ({ results: sql.includes("FROM sandbox_allocations a JOIN sandbox_computers") ? [this.allocation] : [] }),
      run: async () => {
        this.statements.push({ sql, values });
        if (sql.startsWith("UPDATE sandbox_allocations SET status='destroyed'")) this.status = "destroyed";
        else if (sql.startsWith("UPDATE sandbox_allocations SET status=?")) this.status = String(values[0]);
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

async function allocationRow(externalId: string | null) {
  const secret = "phase6-secret";
  const credentials = await sealConnection(secret, "tenant-a", "owner-a", "connection-a", JSON.stringify({ apiKey: "api-secret", instanceKey: "instance-secret" }));
  return {
    allocation_id: "allocation-a", id: "allocation-a", computer_id: "computer-a", connection_id: "connection-a",
    provider: "agent37", external_id: externalId, generation: 4, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
    owner_id: "owner-a", credential_ciphertext: credentials.ciphertext, credential_iv: credentials.iv,
    connection_provider: "agent37", connection_region: "us", template_id: "pinned-template", template_version: "17",
    status: "unknown",
  };
}

describe("sandbox allocation reconciliation", () => {
  it("inspects an uncertain allocation without replaying provider creation or starting a session", async () => {
    const row = await allocationRow("instance-a");
    const db = new FakeDb(row);
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Response.json({ status: "running" });
    }) as typeof fetch;
    const result = await runSandboxAllocationReconciliation({ PLATFORM_DB: db as never, PLATFORM_SECRET: "phase6-secret" }, fetcher, 25, new Date("2026-11-10T03:00:00.000Z"));
    expect(result).toEqual({ scanned: 1, observed: 1, indeterminate: 0 });
    expect(requests).toEqual(["GET https://api.agent37.com/v1/instances/instance-a"]);
    expect(db.status).toBe("active");
    expect(db.statements).toContainEqual(expect.objectContaining({ sql: expect.stringContaining("SET state='recovery_required'") }));
    expect(db.statements).toContainEqual(expect.objectContaining({ sql: expect.stringContaining("sandbox_allocation_reconciliation_receipts") }));
  });

  it("records missing allocation identity as unknown and sends no provider request", async () => {
    const db = new FakeDb(await allocationRow(null));
    const fetcher = vi.fn();
    const result = await runSandboxAllocationReconciliation({ PLATFORM_DB: db as never, PLATFORM_SECRET: "phase6-secret" }, fetcher);
    expect(result).toEqual({ scanned: 1, observed: 0, indeterminate: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.status).toBe("unknown");
    expect(db.statements[0]).toMatchObject({ values: expect.arrayContaining(["allocation_identity_unknown"]) });
  });

  it("recognizes an already deleted provider allocation from a read-only 404", async () => {
    const db = new FakeDb(await allocationRow("instance-a"));
    const methods: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const result = await runSandboxAllocationReconciliation({ PLATFORM_DB: db as never, PLATFORM_SECRET: "phase6-secret" }, fetcher);
    expect(result).toEqual({ scanned: 1, observed: 1, indeterminate: 0 });
    expect(methods).toEqual(["GET"]);
    expect(db.status).toBe("destroyed");
  });
});
