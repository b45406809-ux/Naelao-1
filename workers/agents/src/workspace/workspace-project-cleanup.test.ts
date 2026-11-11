import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { handleWorkspaceProjectCleanup } from "./workspace-project-cleanup.js";

const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };

function request(cursor?: string) {
  return mintInternalToken("platform-secret", scope.tenantId).then(token => new Request("http://agents/internal/workspaces/delete-project", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ scope, confirm: true, ...(cursor ? { cursor } : {}) }),
  }));
}

class FakeErasureDb {
  tombstone: Record<string, unknown> | null = null;
  filesystems = ["fs-project"];
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async () => {
        if (sql.includes("FROM workspace_erasure_tombstones")) return this.tombstone;
        if (sql.includes("SELECT id FROM sandbox_filesystems")) {
          return (this.filesystems.find(id => id > String(values[3] ?? "")) ? { id: this.filesystems.find(id => id > String(values[3] ?? "")) } : null);
        }
        if (sql.includes("FROM sandbox_provider_deletion_operations")) return { pending: 0, unresolved: 0 };
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => {
        if (sql.startsWith("DELETE FROM sandbox_filesystems")) this.filesystems = [];
        if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones") && !this.tombstone) {
          this.tombstone = { tenant_id: values[0], space_id: values[1], project_id: values[2], tombstone_id: values[3], jurisdiction: values[4], status: "pending", cleanup_phase: "legacy", cleanup_cursor: null, bridge_cleanup_cursor: null, cleanup_page: 0 };
        }
        if (sql.includes("SET status='pending',cleanup_phase='legacy'")) {
          if (this.tombstone) this.tombstone = { ...this.tombstone, status: "pending", cleanup_phase: "legacy", cleanup_cursor: null, bridge_cleanup_cursor: null, cleanup_page: 0 };
        } else if (sql.includes("UPDATE workspace_erasure_tombstones")) {
          if (!this.tombstone) return { success: true, meta: { changes: 0 } };
          this.tombstone = { ...this.tombstone, cleanup_phase: values[0], cleanup_cursor: values[1], bridge_cleanup_cursor: values[2], cleanup_page: values[3], status: values[4] };
        }
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

function fixture() {
  const objects = new Map([
    ["spaces/space-a/projects/project-a/workspace/branches/workers/worker-a/output.txt", "overlay"],
    ["spaces/space-a/projects/project-a/workspace/src/main.ts", "legacy"],
    ["sandbox-workspace-bridge/tenant-a/fs-project/orphan-stage", "staged but missing D1 metadata"],
    ["spaces/space-a/provider-connections/shared", "tenant connection"],
  ]);
  const eraseCalls: unknown[] = [];
  const db = new FakeErasureDb();
  let ledger: string | null = null;
  const env = {
    PLATFORM_SECRET: "platform-secret",
    PLATFORM_DB: db,
    WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (value: Request) => { eraseCalls.push(await value.clone().json()); return Response.json({ erased: true }); } }),
    },
    SCRIPTS_R2: {
      async put(key: string, value: string) { if (key.startsWith("workspace-erasure-ledger/")) ledger ??= value; else objects.set(key, value); },
      async get(key: string) { return key.startsWith("workspace-erasure-ledger/") && ledger ? { async json() { return JSON.parse(ledger!); } } : null; },
      async list({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
        const after = cursor ? atob(cursor) : "";
        const matching = [...objects.keys()].filter(key => key.startsWith(prefix) && key > after).sort();
        const selected = matching.slice(0, Math.min(limit, 1));
        const truncated = matching.length > selected.length;
        return { objects: selected.map(key => ({ key })), truncated, ...(truncated ? { cursor: btoa(selected.at(-1)!) } : {}) };
      },
      async delete(keys: string[]) { for (const key of keys) objects.delete(key); },
    },
  };
  return { env: env as never, objects, eraseCalls, db, ledger: () => ledger };
}

describe("retryable project workspace cleanup", () => {
  it("erases coordinator state, pages legacy branch overlays, and preserves tenant provider connections", async () => {
    const { env, objects, eraseCalls, db, ledger } = fixture();
    const first = await handleWorkspaceProjectCleanup(await request(), env);
    expect(first.status).toBe(200);
    const firstResult = await first.json() as { erased: boolean; hasMore: boolean; nextCursor: string; providerConnectionsDeleted: boolean };
    expect(firstResult).toMatchObject({ erased: true, hasMore: true, providerConnectionsDeleted: false });
    expect(db.tombstone).toMatchObject({ status: "cleaning", cleanup_cursor: expect.any(String) });

    expect(ledger()).toContain('"project_id":"project-a"');
    const second = await handleWorkspaceProjectCleanup(await request(firstResult.nextCursor), env);
    expect(await second.json()).toMatchObject({ erased: true, hasMore: true, providerConnectionsDeleted: false });
    const third = await handleWorkspaceProjectCleanup(await request(), env);
    const thirdResult = await third.json() as { hasMore: boolean; nextCursor?: string };
    expect(thirdResult).toMatchObject({ hasMore: true });
    const fourth = await handleWorkspaceProjectCleanup(await request(thirdResult.nextCursor), env);
    expect(await fourth.json()).toMatchObject({ erased: true, hasMore: false, providerConnectionsDeleted: false });
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
    expect(eraseCalls).toHaveLength(4);
    expect(db.tombstone).toMatchObject({ status: "complete", cleanup_phase: "complete", cleanup_cursor: null });
  });

  it("returns a retryable error when legacy deletion fails and succeeds on replay", async () => {
    const { env, objects } = fixture();
    const bucket = (env as unknown as { SCRIPTS_R2: { delete(keys: string[]): Promise<void> } }).SCRIPTS_R2;
    const originalDelete = bucket.delete.bind(bucket);
    const remove = vi.fn(async (keys: string[]) => {
      if (remove.mock.calls.length === 1) throw new Error("temporary R2 failure");
      await originalDelete(keys);
    });
    bucket.delete = remove;

    const failed = await handleWorkspaceProjectCleanup(await request(), env);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error_code: "workspace_cleanup_retryable_failure" });
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const replay = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(replay.status).toBe(200);
      const result = await replay.json() as { hasMore: boolean; nextCursor?: string };
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
  });

  it("retries a lost staging-delete response from the persisted filesystem cursor", async () => {
    const { env, objects, db } = fixture();
    const first = await handleWorkspaceProjectCleanup(await request(), env);
    const firstBody = await first.json() as { nextCursor: string };
    const second = await handleWorkspaceProjectCleanup(await request(firstBody.nextCursor), env);
    const secondBody = await second.json() as { nextCursor: string };
    const bucket = (env as unknown as { SCRIPTS_R2: { delete(keys: string[]): Promise<void> } }).SCRIPTS_R2;
    const originalDelete = bucket.delete.bind(bucket);
    let loseResponse = true;
    bucket.delete = async (keys: string[]) => {
      await originalDelete(keys);
      if (loseResponse && keys.some(key => key.startsWith("sandbox-workspace-bridge/"))) {
        loseResponse = false;
        throw new Error("lost staging-delete response");
      }
    };
    const interrupted = await handleWorkspaceProjectCleanup(await request(secondBody.nextCursor), env);
    expect(interrupted.status).toBe(503);
    expect(db.tombstone).toMatchObject({ cleanup_phase: "bridge", bridge_cleanup_cursor: null });
    expect(objects.has("sandbox-workspace-bridge/tenant-a/fs-project/orphan-stage")).toBe(false);

    const replay = await handleWorkspaceProjectCleanup(await request(), env);
    expect(await replay.json()).toMatchObject({ erased: true, hasMore: true });
    const complete = await handleWorkspaceProjectCleanup(await request(), env);
    expect(await complete.json()).toMatchObject({ erased: true, hasMore: false });
    expect(db.tombstone).toMatchObject({ status: "complete", cleanup_phase: "complete" });
  });

  it("retries an erase whose first response was lost and preserves sibling provider connections", async () => {
    const { env, objects } = fixture();
    let tombstoned = false;
    let eraseAttempts = 0;
    (env as unknown as { WORKSPACE_COORDINATOR: { get: (id: string) => { fetch: (request: Request) => Promise<Response> } } }).WORKSPACE_COORDINATOR.get = () => ({
      fetch: async (value: Request) => {
        await value.json();
        eraseAttempts++;
        tombstoned = true; // the DO committed its tombstone before the Worker lost the response
        if (eraseAttempts === 1) throw new Error("simulated lost response after erase commit");
        return Response.json({ erased: true, scope });
      },
    });

    const lost = await handleWorkspaceProjectCleanup(await request(), env);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ error_code: "workspace_cleanup_retryable_failure" });
    expect(tombstoned).toBe(true);
    expect([...objects.keys()]).toContain("spaces/space-a/projects/project-a/workspace/src/main.ts");

    let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      const replay = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(replay.status).toBe(200);
      const result = await replay.json() as { erased: boolean; hasMore: boolean; nextCursor?: string; providerConnectionsDeleted: boolean };
      expect(result).toMatchObject({ erased: true, providerConnectionsDeleted: false });
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect(eraseAttempts).toBe(5);
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
  });
});
