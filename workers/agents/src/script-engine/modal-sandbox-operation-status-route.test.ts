import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { app } from "../index.js";
import { createModalSandboxD1Hooks } from "./modal-sandbox-journal.js";
import type { ModalSandboxRecord } from "./modal-lifecycle.js";

const secret = "modal-operation-status-route-test-secret";
const baseRecord: ModalSandboxRecord = {
  id: "modal:operation-a", tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "owner-a",
  idempotencyKey: "operation-a", requestHash: "a".repeat(64), image: `registry.example/sandbox@sha256:${"b".repeat(64)}`,
  cpu: 2, memoryMb: 8192, region: "us-east-1", timeoutSeconds: 300, gpu: "L4", state: "pending", revision: 0,
  createdAt: 1_794_600_000_000, updatedAt: 1_794_600_000_000, reservedCredits: 500,
};

async function fixture(role: "owner" | "admin" | "member" = "owner") {
  const db = createFakeD1([
    `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
     CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL);`,
    readFileSync(new URL("../../../../infra/migrations/0256_modal_sandbox_operation_journal.sql", import.meta.url), "utf8"),
  ]);
  await db.prepare("INSERT INTO spaces(id,tenant_id) VALUES('space-a','tenant-a')").run();
  await db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('tenant-a','user-a',?)").bind(role).run();
  const projectRequests: string[] = [];
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
    SPACES_WORKER: { fetch: async (request: Request) => {
      projectRequests.push(new URL(request.url).pathname);
      return Response.json({ project_id: "project-a" });
    } },
  } as never;
  const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
  return { db, env, headers, projectRequests };
}

describe("Modal operation status route", () => {
  it("returns scoped saved metadata to owners and admins without contacting a provider", async () => {
    const f = await fixture("admin");
    const hooks = createModalSandboxD1Hooks(f.db, { reserve: async () => undefined, settle: async () => undefined, release: async () => undefined });
    await hooks.claim(baseRecord);
    await hooks.record({ ...baseRecord, providerId: "provider-private-id", state: "running", revision: 1,
      actualCredits: 620, overrunCredits: 120, updatedAt: baseRecord.updatedAt + 1000 });
    await hooks.claim({ ...baseRecord, id: "modal:other-project", projectId: "project-b", actorId: "other-owner",
      idempotencyKey: "other-project", requestHash: "c".repeat(64) });
    await hooks.claim({ ...baseRecord, id: "modal:other-tenant", tenantId: "tenant-b", actorId: "other-tenant-owner",
      idempotencyKey: "other-tenant", requestHash: "d".repeat(64) });

    const response = await app.request("/spaces/space-a/projects/project-a/modal-operations", { headers: f.headers }, f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ source: "saved_operation_journal", providerContacted: false, operations: [{
      operationId: baseRecord.id, state: "running", region: "us-east-1", revision: 1, reservedCredits: 500,
      actualCredits: 620, overrunCredits: 120, errorCode: null,
      createdAt: new Date(baseRecord.createdAt).toISOString(), updatedAt: new Date(baseRecord.updatedAt + 1000).toISOString(),
    }] });
    expect(f.projectRequests).toEqual(["/spaces/space-a/projects/project-a"]);
  });

  it("denies project members before reading journal records", async () => {
    const f = await fixture("member");
    const response = await app.request("/spaces/space-a/projects/project-a/modal-operations", { headers: f.headers }, f.env);
    expect(response.status).toBe(403);
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM modal_sandbox_operations").first()).toEqual({ count: 0 });
  });
});
