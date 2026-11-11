import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import app from "./index.js";

class FakeD1Statement {
  private values: unknown[] = [];
  constructor(
    private readonly sql: string,
    private readonly db: FakeD1
  ) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return this.db.first<T>(this.sql, this.values);
  }
  async all<T>() {
    return this.db.all<T>(this.sql, this.values);
  }
  async run() {
    return this.db.run(this.sql, this.values);
  }
}
class FakeD1 {
  operations = new Map<
    string,
    { payload_hash: string; result_json: string | null }
  >();
  filesystems = new Map<string, Record<string, unknown>>();
  computers = new Map<string, Record<string, unknown>>();
  deletionOperation: Record<string, unknown> | null = null;
  manualDeletionReceipt: Record<string, unknown> | null = null;
  prepare(sql: string) {
    return new FakeD1Statement(sql, this);
  }
  async first<T>(sql: string, values: unknown[]): Promise<T | null> {
    if (sql.includes("FROM sandbox_provider_deletion_manual_receipts"))
      return this.manualDeletionReceipt as T | null;
    if (sql.includes("FROM sandbox_provider_deletion_operations o"))
      return this.deletionOperation as T | null;
    if (sql.includes("AS project_erased"))
      return { project_erased: 0, tenant_erased: 0 } as T;
    if (
      sql.includes("FROM sandbox_operations") &&
      sql.includes("idempotency_key")
    )
      return (this.operations.get(`${values[0]}:${values[1]}`) ??
        null) as T | null;
    if (sql.includes("FROM sandbox_filesystems") && sql.includes("WHERE id=?"))
      return (this.filesystems.get(String(values[0])) ?? null) as T | null;
    if (sql.includes("FROM spaces")) return null;
    return null;
  }
  async all<T>(_sql: string, _values: unknown[]) {
    return { results: [] as T[], success: true, meta: { changes: 0 } };
  }
  async run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT OR IGNORE INTO sandbox_provider_deletion_manual_receipts")) {
      if (!this.manualDeletionReceipt) {
        this.manualDeletionReceipt = {
          operation_id: values[0], tenant_id: values[1], evidence_ref_hash: values[2],
          operator_id_hash: values[3], observed_at: values[4], recorded_at: values[5],
        };
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE sandbox_provider_deletion_operations SET status='confirmed_deleted'")) {
      if (this.deletionOperation) this.deletionOperation.status = "confirmed_deleted";
    }
    if (sql.includes("INSERT INTO sandbox_computers"))
      this.computers.set(String(values[0]), { id: values[0] });
    if (sql.includes("INSERT INTO sandbox_filesystems"))
      this.filesystems.set(String(values[0]), {
        id: values[0],
        tenant_id: values[1],
        owner_id: values[2],
        space_id: values[3],
        project_id: values[4],
        branch: values[5],
      });
    if (sql.includes("INSERT INTO sandbox_operations"))
      this.operations.set(`${values[1]}:${values[4]}`, {
        payload_hash: String(values[5]),
        result_json: String(values[8]),
      });
    return { success: true, meta: { changes: 1 } };
  }
  async batch(statements: FakeD1Statement[]) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

describe("sandbox control plane boundary", () => {
  it("rejects requests without an internal router signature", async () => {
    const response = await app.fetch(
      new Request("http://sandbox/computers", {
        method: "GET",
        headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user" },
      }),
      { PLATFORM_DB: {} as D1Database, PLATFORM_SECRET: "test-secret" }
    );
    expect(response.status).toBe(403);
  });
  it("stores only a scoped config and replays identical creates idempotently", async () => {
    const secret = "sandbox-test-platform-secret";
    const token = await mintInternalToken(secret, "tenant_1");
    const db = new FakeD1();
    const env = {
      PLATFORM_DB: db as unknown as D1Database,
      PLATFORM_SECRET: secret,
    };
    const body = JSON.stringify({
      scope: {},
      templateId: "node",
      templateVersion: "1",
      filesystemId: "fs_1",
      resources: { cpu: 1, memoryMiB: 1024, diskGiB: 10 },
    });
    const request = () =>
      app.fetch(
        new Request("http://sandbox/computers", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "create-1",
            "x-naelao-tenant-id": "tenant_1",
            "x-naelao-user-id": "user_1",
            "x-naelao-role": "owner",
            "x-naelao-internal-token": token,
          },
          body,
        }),
        env
      );
    const first = await request();
    const second = await request();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(db.computers.size).toBe(1);
    expect(
      ((await first.json()) as { computer: { state: string } }).computer.state
    ).toBe("configured");
  });

  it("limits manual provider deletion evidence to owners and admins and stores a hashed receipt", async () => {
    const secret = "sandbox-test-platform-secret";
    const token = await mintInternalToken(secret, "tenant_1");
    const operationId = `spdel_${"a".repeat(64)}`;
    const db = new FakeD1();
    db.deletionOperation = {
      id: operationId, tenant_id: "tenant_1", status: "indeterminate", external_id: "provider-resource",
      computer_id: "computer_1", allocation_id: "allocation_1", generation: 1,
      space_id: "space_1", project_id: "project_1", connection_id: "connection_1", filesystem_id: "filesystem_1",
    };
    const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: secret };
    const observedAt = new Date(Date.now() - 1000).toISOString();
    const send = (role: string) => app.fetch(new Request(`http://sandbox/provider-deletions/${operationId}/receipt`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-naelao-tenant-id": "tenant_1", "x-naelao-user-id": "operator_1",
        "x-naelao-role": role, "x-naelao-internal-token": token,
      },
      body: JSON.stringify({ confirm: true, evidenceRef: "provider-ticket-9031", observedAt }),
    }), env);

    expect((await send("member")).status).toBe(403);
    expect(db.manualDeletionReceipt).toBeNull();
    const accepted = await send("admin");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ operationId, status: "confirmed_deleted", replay: false, evidenceRecorded: true });
    expect(db.deletionOperation.status).toBe("confirmed_deleted");
    expect(db.manualDeletionReceipt).toMatchObject({
      evidence_ref_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      operator_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(db.manualDeletionReceipt)).not.toContain("provider-ticket-9031");
    expect(JSON.stringify(db.manualDeletionReceipt)).not.toContain("operator_1");
  });
});
