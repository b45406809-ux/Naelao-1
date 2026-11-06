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
  prepare(sql: string) {
    return new FakeD1Statement(sql, this);
  }
  async first<T>(sql: string, values: unknown[]): Promise<T | null> {
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
    const response = await app.request(
      "/computers",
      {
        method: "GET",
        headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user" },
      },
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
      app.request(
        "/computers",
        {
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
        },
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
});
