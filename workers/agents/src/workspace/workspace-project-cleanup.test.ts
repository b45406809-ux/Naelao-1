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
  backupExports = new Map<string, Record<string, unknown>>();
  runtimeRows: Array<Record<string, unknown>> = [];
  mainRuntimeRegistry: Record<string, unknown> | null = null;
  browserProfileRows: Array<Record<string, unknown>> = [];
  browserSessionRows: Array<Record<string, unknown>> = [];
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...next: unknown[]) => { values = next; return statement; },
      first: async () => {
        if (sql.includes("FROM workspace_erasure_backup_exports")) return this.backupExports.get(String(values[0])) ?? null;
        if (sql.includes("FROM workspace_erasure_tombstones")) return this.tombstone;
        if (sql.includes("SELECT COUNT(*) AS count FROM workspace_runtime_registry")) return { count: this.runtimeRows.filter(row => !row.erasure_notified_at).length };
        if (sql.includes("SELECT COUNT(*) AS count FROM workspace_browser_profile_registry")) return { count: this.browserProfileRows.filter(row =>
          row.tenant_id === values[0] && row.space_id === values[1] && row.project_id === values[2] && !row.erasure_notified_at).length };
        if (sql.includes("SELECT COUNT(*) AS count FROM workspace_browser_session_registry")) return { count: this.browserSessionRows.filter(row =>
          row.tenant_id === values[0] && row.space_id === values[1] && row.project_id === values[2] && !row.erasure_notified_at).length };
        if (sql.includes("SELECT id FROM sandbox_filesystems")) {
          return (this.filesystems.find(id => id > String(values[3] ?? "")) ? { id: this.filesystems.find(id => id > String(values[3] ?? "")) } : null);
        }
        if (sql.includes("FROM sandbox_provider_deletion_operations")) return { pending: 0, unresolved: 0 };
        return null;
      },
      all: async () => ({ results: sql.includes("FROM workspace_browser_profile_registry")
        ? this.browserProfileRows.filter(row => row.tenant_id === values[0] && row.space_id === values[1] && row.project_id === values[2] && !row.erasure_notified_at)
          .slice(0, 100).map(row => ({ profile_id: row.profile_id, scope_json: row.scope_json }))
        : sql.includes("FROM workspace_browser_session_registry")
          ? this.browserSessionRows.filter(row => row.tenant_id === values[0] && row.space_id === values[1] && row.project_id === values[2] && !row.erasure_notified_at)
            .slice(0, 100).map(row => ({ session_id: row.session_id, scope_json: row.scope_json }))
        : sql.includes("FROM workspace_runtime_registry")
          ? this.runtimeRows.filter(row => !row.erasure_notified_at).slice(0, 100).map(row => ({ runtime_kind: row.runtime_kind, object_name: row.object_name }))
          : [] }),
      run: async () => {
        if (sql.startsWith("DELETE FROM sandbox_filesystems")) this.filesystems = [];
        if (sql.includes("INSERT OR IGNORE INTO workspace_runtime_registry")) {
          const [tenantId, spaceId, projectId, runtimeKind, objectName, firstSeenAt, lastSeenAt] = values;
          if (!this.runtimeRows.some(row => row.tenant_id === tenantId && row.space_id === spaceId && row.project_id === projectId
            && row.runtime_kind === runtimeKind && row.object_name === objectName)) {
            this.runtimeRows.push({ tenant_id: tenantId, space_id: spaceId, project_id: projectId, runtime_kind: runtimeKind,
              object_name: objectName, branch: "", installation_id: null, first_seen_at: firstSeenAt, last_seen_at: lastSeenAt, erasure_attempts: 0 });
          }
        }
        if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_tombstones") && !this.tombstone) {
          this.tombstone = { tenant_id: values[0], space_id: values[1], project_id: values[2], tombstone_id: values[3], jurisdiction: values[4], requested_at: values[5], status: "pending", cleanup_phase: "legacy", cleanup_cursor: null, bridge_cleanup_cursor: null, cleanup_page: 0 };
        }
        if (sql.includes("INSERT OR IGNORE INTO workspace_erasure_backup_exports")) {
          const [tombstoneId, tenantId, spaceId, projectId, jurisdiction, backupKey, receiptSha256, exportedAt] = values;
          this.backupExports.set(String(tombstoneId), { tenant_id: tenantId, space_id: spaceId, project_id: projectId,
            jurisdiction, backup_key: backupKey, receipt_sha256: receiptSha256, exported_at: exportedAt });
        }
        if (sql.includes("UPDATE workspace_runtime_registry SET erasure_notified_at")) {
          const row = this.runtimeRows.find(item => item.tenant_id === values[1] && item.space_id === values[2] && item.project_id === values[3]
            && item.runtime_kind === values[4] && item.object_name === values[5]);
          if (row) { row.erasure_notified_at = values[0]; row.erasure_attempts = Number(row.erasure_attempts ?? 0) + 1; row.last_erasure_error = null; }
        } else if (sql.includes("UPDATE workspace_runtime_registry SET erasure_attempts")) {
          const row = this.runtimeRows.find(item => item.tenant_id === values[1] && item.space_id === values[2] && item.project_id === values[3]
            && item.runtime_kind === values[4] && item.object_name === values[5]);
          if (row) { row.erasure_attempts = Number(row.erasure_attempts ?? 0) + 1; row.last_erasure_error = values[0]; }
        }
        if (sql.includes("UPDATE project_main_runtime_registry SET state='erased'")) {
          const [lastSeenAt, tenantId, spaceId, projectId, objectName] = values;
          const row = this.mainRuntimeRegistry;
          if (row && row.tenant_id === tenantId && row.space_id === spaceId && row.project_id === projectId
            && row.runtime_kind === "dynamic_sandbox" && row.runtime_object_name === objectName) {
            row.state = "erased";
            row.last_seen_at = lastSeenAt;
          }
        }
        if (sql.includes("UPDATE workspace_browser_profile_registry SET erasure_notified_at")) {
          const row = this.browserProfileRows.find(item => item.profile_id === values[1] && item.tenant_id === values[2] && item.space_id === values[3] && item.project_id === values[4]);
          if (row) { row.erasure_notified_at = values[0]; row.erasure_attempts = Number(row.erasure_attempts ?? 0) + 1; row.last_erasure_error = null; }
        } else if (sql.includes("UPDATE workspace_browser_profile_registry SET erasure_attempts")) {
          const row = this.browserProfileRows.find(item => item.profile_id === values[1] && item.tenant_id === values[2] && item.space_id === values[3] && item.project_id === values[4]);
          if (row) { row.erasure_attempts = Number(row.erasure_attempts ?? 0) + 1; row.last_erasure_error = values[0]; }
        }
        if (sql.includes("UPDATE workspace_browser_session_registry SET erasure_notified_at")) {
          const row = this.browserSessionRows.find(item => item.session_id === values[3] && item.tenant_id === values[4] && item.space_id === values[5] && item.project_id === values[6]);
          if (row) { row.erasure_notified_at = values[0]; row.closed_at ??= values[1]; row.last_seen_at = values[2]; row.erasure_attempts = Number(row.erasure_attempts ?? 0) + 1; row.last_erasure_error = null; }
        } else if (sql.includes("UPDATE workspace_browser_session_registry SET erasure_attempts")) {
          const row = this.browserSessionRows.find(item => item.session_id === values[1] && item.tenant_id === values[2] && item.space_id === values[3] && item.project_id === values[4]);
          if (row) { row.erasure_attempts = Number(row.erasure_attempts ?? 0) + 1; row.last_erasure_error = values[0]; }
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
  const backupObjects = new Map<string, unknown>();
  const runtimeNotifications: Request[] = [];
  const browserProfileNotifications: Request[] = [];
  const browserSessionNotifications: Request[] = [];
  const env = {
    PLATFORM_SECRET: "platform-secret",
    PLATFORM_DB: db,
    WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (value: Request) => {
        const path = new URL(value.url).pathname;
        if (path === "/v1/erase/admission") return Response.json({ admitted: true });
        eraseCalls.push(await value.clone().json()); return Response.json({ erased: true });
      } }),
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
    WORKSPACE_ERASURE_BACKUP_R2: {
      async put(key: string, value: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
        if (options?.onlyIf?.etagDoesNotMatch === "*" && backupObjects.has(key)) return null;
        backupObjects.set(key, JSON.parse(value));
        return { key };
      },
      async get(key: string) { const value = backupObjects.get(key); return value ? { async json() { return structuredClone(value); } } : null; },
    },
    TOOL_SANDBOX: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      runtimeNotifications.push(request);
      return Response.json({ erased: true, localStatePurged: true, providerSnapshotPurge: "not_supported" });
    } }) },
    BROWSER_WORKER: { fetch: async (request: Request) => { browserProfileNotifications.push(request); return Response.json({ ok: true }); } },
  };
  (env as unknown as { BROWSER_WORKER: { fetch(request: Request): Promise<Response> } }).BROWSER_WORKER.fetch = async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/browser-session")) { browserSessionNotifications.push(request); return Response.json({ ok: true, sessionClosed: true }); }
    browserProfileNotifications.push(request);
    return Response.json({ ok: true });
  };
  return { env: env as never, objects, eraseCalls, db, ledger: () => ledger, backupObjects, runtimeNotifications, browserProfileNotifications, browserSessionNotifications };
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
    let cursor: string | undefined = firstResult.nextCursor;
    let hasMore = true;
    for (let page = 0; page < 8 && hasMore; page++) {
      const response = await handleWorkspaceProjectCleanup(await request(cursor), env);
      const result = await response.json() as { hasMore: boolean; nextCursor?: string; providerConnectionsDeleted: boolean };
      expect(response.status).toBe(200);
      expect(result.providerConnectionsDeleted).toBe(false);
      hasMore = result.hasMore;
      cursor = result.nextCursor;
    }
    expect(hasMore).toBe(false);
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
    expect(eraseCalls).toHaveLength(6);
    expect(db.tombstone).toMatchObject({ status: "complete", cleanup_phase: "complete", cleanup_cursor: null });
  });

  it("discovers the stable legacy project runtime names before the retryable erasure barrier", async () => {
    const { env, db, runtimeNotifications } = fixture();
    const response = await handleWorkspaceProjectCleanup(await request(), env);
    expect(response.status).toBe(200);
    expect(db.runtimeRows).toContainEqual(expect.objectContaining({
      runtime_kind: "tool_sandbox", object_name: "sandbox:space-a:project-a", erasure_notified_at: expect.any(String),
    }));
    expect(runtimeNotifications).toHaveLength(1);
    expect(await runtimeNotifications[0]!.clone().json()).toMatchObject({ scope, confirm: true });
  });

  it("marks the project-main registry erased only after its exact dynamic runtime confirms local purge", async () => {
    const { env, db } = fixture();
    db.mainRuntimeRegistry = { tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId,
      runtime_kind: "dynamic_sandbox", runtime_object_name: `sandbox:${scope.spaceId}:${scope.projectId}`,
      state: "active", allocation_generation: 4, last_seen_at: "2026-11-11T00:00:00.000Z" };
    const mutableEnv = env as unknown as Record<string, unknown>;
    mutableEnv.DYNAMIC_SANDBOX = mutableEnv.TOOL_SANDBOX;

    const response = await handleWorkspaceProjectCleanup(await request(), env);
    expect(response.status).toBe(200);
    expect(db.mainRuntimeRegistry).toMatchObject({ state: "erased", allocation_generation: 4 });
  });

  it("leaves project-main state unchanged when dynamic runtime erasure lacks a purge receipt", async () => {
    const { env, db } = fixture();
    db.mainRuntimeRegistry = { tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId,
      runtime_kind: "dynamic_sandbox", runtime_object_name: `sandbox:${scope.spaceId}:${scope.projectId}`,
      state: "active", allocation_generation: 4, last_seen_at: "2026-11-11T00:00:00.000Z" };
    const mutableEnv = env as unknown as Record<string, unknown>;
    mutableEnv.DYNAMIC_SANDBOX = { idFromName: (name: string) => name, get: () => ({ fetch: async () =>
      Response.json({ erased: true, localStatePurged: false, providerSnapshotPurge: "not_supported" }) }) };

    const response = await handleWorkspaceProjectCleanup(await request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "workspace_runtime_erasure_pending", pending: 1 });
    expect(db.mainRuntimeRegistry).toMatchObject({ state: "active", allocation_generation: 4 });
  });

  it("revokes only registered browser profiles for the deleted project before coordinator erasure", async () => {
    const { env, db, eraseCalls, browserProfileNotifications } = fixture();
    const profileScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "member-a", agentId: "assistant-a",
      runId: "old-run", sessionId: "old-session", expiresAt: Date.now() - 60_000, authorizedOrigins: ["https://example.com"],
      authorizedActions: ["click"], connectionId: "connection-a", maxTier: 5 };
    const owner = JSON.stringify([profileScope.tenantId, profileScope.spaceId, profileScope.projectId, profileScope.actorId, profileScope.connectionId]);
    const profileId = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    db.browserProfileRows.push({ profile_id: profileId, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
      scope_json: JSON.stringify(profileScope), erasure_attempts: 0 });
    const unrelated = { ...profileScope, projectId: "project-b", connectionId: "connection-b" };
    const unrelatedOwner = JSON.stringify([unrelated.tenantId, unrelated.spaceId, unrelated.projectId, unrelated.actorId, unrelated.connectionId]);
    const unrelatedId = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unrelatedOwner)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    db.browserProfileRows.push({ profile_id: unrelatedId, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-b",
      scope_json: JSON.stringify(unrelated), erasure_attempts: 0 });

    const response = await handleWorkspaceProjectCleanup(await request(), env);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(browserProfileNotifications).toHaveLength(1);
    expect(await browserProfileNotifications[0]!.clone().json()).toMatchObject({ ...profileScope, expiresAt: expect.any(Number) });
    expect(db.browserProfileRows[0]).toMatchObject({ erasure_notified_at: expect.any(String), erasure_attempts: 1 });
    expect(db.browserProfileRows[1]).not.toHaveProperty("erasure_notified_at");
    expect(eraseCalls).toHaveLength(1);
    expect(await response.json()).toMatchObject({ browserProfileErasure: { notified: 1, pending: 0 } });
  });

  it("keeps project cleanup pending when a registered browser profile cannot be revoked", async () => {
    const { env, db, eraseCalls } = fixture();
    const profileScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "member-a", agentId: "assistant-a",
      runId: "old-run", sessionId: "old-session", expiresAt: Date.now() - 60_000, authorizedOrigins: ["https://example.com"],
      authorizedActions: [], connectionId: "connection-a", maxTier: 5 };
    const owner = JSON.stringify([profileScope.tenantId, profileScope.spaceId, profileScope.projectId, profileScope.actorId, profileScope.connectionId]);
    const profileId = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    db.browserProfileRows.push({ profile_id: profileId, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
      scope_json: JSON.stringify(profileScope), erasure_attempts: 0 });
    (env as unknown as { BROWSER_WORKER?: unknown }).BROWSER_WORKER = undefined;

    const response = await handleWorkspaceProjectCleanup(await request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "workspace_browser_profile_erasure_pending", pending: 1 });
    expect(eraseCalls).toHaveLength(0);
    expect(db.browserProfileRows[0]).toMatchObject({ last_erasure_error: "browser_profile_worker_unavailable", erasure_attempts: 1 });
  });

  it("closes the exact project browser session and removes its screenshot scope before erasure", async () => {
    const { env, db, browserSessionNotifications } = fixture();
    const sessionScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "member-a", agentId: "assistant-a",
      runId: "run-a", sessionId: "session-a", expiresAt: Date.now() - 60_000, authorizedOrigins: ["https://example.com"],
      authorizedActions: [], connectionId: undefined, maxTier: 4 };
    const owner = JSON.stringify([sessionScope.tenantId, sessionScope.spaceId, sessionScope.projectId, sessionScope.actorId, sessionScope.agentId, sessionScope.runId, sessionScope.sessionId]);
    const sessionId = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    db.browserSessionRows.push({ session_id: sessionId, tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a",
      scope_json: JSON.stringify(sessionScope), closed_at: new Date().toISOString(), erasure_attempts: 0 });

    const response = await handleWorkspaceProjectCleanup(await request(), env);
    expect(response.status).toBe(200);
    expect(browserSessionNotifications).toHaveLength(1);
    expect(new URL(browserSessionNotifications[0]!.url).pathname).toBe("/v1/workspace-erasure/browser-session");
    const erasedScope = await browserSessionNotifications[0]!.clone().json() as Record<string, unknown>;
    expect(erasedScope).toMatchObject({ tenantId: sessionScope.tenantId, spaceId: sessionScope.spaceId, projectId: sessionScope.projectId,
      actorId: sessionScope.actorId, agentId: sessionScope.agentId, runId: sessionScope.runId, sessionId: sessionScope.sessionId,
      expiresAt: expect.any(Number) });
    expect(erasedScope).not.toHaveProperty("connectionId");
    expect(db.browserSessionRows[0]).toMatchObject({ erasure_notified_at: expect.any(String), closed_at: expect.any(String), erasure_attempts: 1 });
    expect(await response.json()).toMatchObject({ browserSessionErasure: { notified: 1, pending: 0 } });
  });

  it("erases project-bound sidecar workspaces while preserving bundles, Space sidecars, and provider connections", async () => {
    const { env, objects } = fixture();
    objects.set("spaces/space-a/projects/project-a/extensions/install-a/workspace/private.db", "private sidecar state");
    objects.set("spaces/space-a/projects/project-a/extensions/install-a/workspace/out/report.txt", "sidecar file");
    objects.set("spaces/space-a/projects/project-a/extensions/install-a/releases/manifest.json", "extension bundle");
    objects.set("spaces/space-a/space-workspace/extensions/space-install/workspace/notes.txt", "Space sidecar");
    objects.set("spaces/space-a/projects/project-b/extensions/install-b/workspace/private.db", "sibling project");
    objects.set(`workspace-artifacts/tenant-a/space-a/project-a/environment/${"a".repeat(64)}`, "project artifact");
    objects.set(`workspace-artifacts/tenant-a/space-a/project-b/environment/${"b".repeat(64)}`, "sibling project artifact");

    let cursor: string | undefined;
    let hasMore = true;
    for (let page = 0; page < 12 && hasMore; page++) {
      const response = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(response.status).toBe(200);
      const result = await response.json() as { hasMore: boolean; nextCursor?: string };
      hasMore = result.hasMore;
      cursor = result.nextCursor;
    }

    expect(hasMore).toBe(false);
    expect([...objects.keys()].sort()).toEqual([
      "spaces/space-a/provider-connections/shared",
      "spaces/space-a/space-workspace/extensions/space-install/workspace/notes.txt",
      "spaces/space-a/projects/project-a/extensions/install-a/releases/manifest.json",
      "spaces/space-a/projects/project-b/extensions/install-b/workspace/private.db",
      `workspace-artifacts/tenant-a/space-a/project-b/environment/${"b".repeat(64)}`,
    ].sort());
  });

  it("replays a lost sidecar-workspace delete response from the unchanged R2 cursor", async () => {
    const { env, objects, db } = fixture();
    objects.set("spaces/space-a/projects/project-a/extensions/install-a/workspace/private.db", "private sidecar state");
    const bucket = (env as unknown as { SCRIPTS_R2: { delete(keys: string[]): Promise<void> } }).SCRIPTS_R2;
    const originalDelete = bucket.delete.bind(bucket);
    let loseResponse = true;
    bucket.delete = async (keys: string[]) => {
      await originalDelete(keys);
      if (loseResponse && keys.some(key => key.includes("/extensions/") && key.includes("/workspace/"))) {
        loseResponse = false;
        throw new Error("lost sidecar delete response");
      }
    };

    const first = await handleWorkspaceProjectCleanup(await request(), env);
    const firstResult = await first.json() as { nextCursor: string };
    const second = await handleWorkspaceProjectCleanup(await request(firstResult.nextCursor), env);
    const secondResult = await second.json() as { nextCursor: string };
    const lost = await handleWorkspaceProjectCleanup(await request(secondResult.nextCursor), env);
    expect(lost.status).toBe(503);
    expect(db.tombstone).toMatchObject({ cleanup_phase: "bridge", bridge_cleanup_cursor: null });
    expect(objects.has("spaces/space-a/projects/project-a/extensions/install-a/workspace/private.db")).toBe(false);

    const replay = await handleWorkspaceProjectCleanup(await request(), env);
    expect(await replay.json()).toMatchObject({ erased: true, hasMore: true });
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const response = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(response.status).toBe(200);
      const result = await response.json() as { hasMore: boolean; nextCursor?: string };
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect(db.tombstone).toMatchObject({ status: "complete", cleanup_phase: "complete" });
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
  });

  it("replays a lost immutable project-artifact delete response without touching sibling artifacts", async () => {
    const { env, objects } = fixture();
    const projectArtifact = `workspace-artifacts/tenant-a/space-a/project-a/environment/${"a".repeat(64)}`;
    const siblingArtifact = `workspace-artifacts/tenant-a/space-a/project-b/environment/${"b".repeat(64)}`;
    objects.set(projectArtifact, "project export");
    objects.set(siblingArtifact, "sibling export");
    const bucket = (env as unknown as { SCRIPTS_R2: { delete(keys: string[]): Promise<void> } }).SCRIPTS_R2;
    const originalDelete = bucket.delete.bind(bucket);
    let loseResponse = true;
    bucket.delete = async (keys: string[]) => {
      await originalDelete(keys);
      if (loseResponse && keys.some(key => key.startsWith("workspace-artifacts/tenant-a/space-a/project-a/"))) {
        loseResponse = false;
        throw new Error("lost immutable artifact delete response");
      }
    };

    let cursor: string | undefined;
    let interrupted = false;
    for (let page = 0; page < 8 && !interrupted; page++) {
      const response = await handleWorkspaceProjectCleanup(await request(cursor), env);
      if (response.status === 503) { interrupted = true; break; }
      expect(response.status).toBe(200);
      cursor = ((await response.json()) as { nextCursor?: string }).nextCursor;
    }
    expect(interrupted).toBe(true);
    expect(objects.has(projectArtifact)).toBe(false);
    expect(objects.has(siblingArtifact)).toBe(true);

    let hasMore = true;
    cursor = undefined;
    for (let page = 0; page < 8 && hasMore; page++) {
      const response = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(response.status).toBe(200);
      const result = await response.json() as { hasMore: boolean; nextCursor?: string };
      hasMore = result.hasMore;
      cursor = result.nextCursor;
    }
    expect(hasMore).toBe(false);
    expect([...objects.keys()].sort()).toEqual([siblingArtifact, "spaces/space-a/provider-connections/shared"].sort());
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
    const third = await handleWorkspaceProjectCleanup(await request(secondBody.nextCursor), env);
    const thirdBody = await third.json() as { nextCursor: string };
    const fourth = await handleWorkspaceProjectCleanup(await request(thirdBody.nextCursor), env);
    const fourthBody = await fourth.json() as { nextCursor: string };
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
    const interrupted = await handleWorkspaceProjectCleanup(await request(fourthBody.nextCursor), env);
    expect(interrupted.status).toBe(503);
    expect(db.tombstone).toMatchObject({ cleanup_phase: "bridge", bridge_cleanup_cursor: expect.any(String) });
    expect(objects.has("sandbox-workspace-bridge/tenant-a/fs-project/orphan-stage")).toBe(false);

    const replay = await handleWorkspaceProjectCleanup(await request(), env);
    expect(await replay.json()).toMatchObject({ erased: true, hasMore: true });
    let cursor: string | undefined;
    let hasMore = true;
    for (let page = 0; page < 5 && hasMore; page++) {
      const complete = await handleWorkspaceProjectCleanup(await request(cursor), env);
      expect(complete.status).toBe(200);
      const result = await complete.json() as { hasMore: boolean; nextCursor?: string };
      hasMore = result.hasMore;
      cursor = result.nextCursor;
    }
    expect(hasMore).toBe(false);
    expect(db.tombstone).toMatchObject({ status: "complete", cleanup_phase: "complete" });
  });

  it("retries an erase whose first response was lost and preserves sibling provider connections", async () => {
    const { env, objects } = fixture();
    let tombstoned = false;
    let eraseAttempts = 0;
    (env as unknown as { WORKSPACE_COORDINATOR: { get: (id: string) => { fetch: (request: Request) => Promise<Response> } } }).WORKSPACE_COORDINATOR.get = () => ({
      fetch: async (value: Request) => {
        if (new URL(value.url).pathname === "/v1/erase/admission") return Response.json({ admitted: true });
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
    expect(eraseAttempts).toBe(7);
    expect([...objects.keys()]).toEqual(["spaces/space-a/provider-connections/shared"]);
  });

  it("keeps the erasure tombstone active and aliases intact until an independent receipt copy is available", async () => {
    const { env, objects, db } = fixture();
    const backup = (env as unknown as { WORKSPACE_ERASURE_BACKUP_R2?: unknown }).WORKSPACE_ERASURE_BACKUP_R2;
    delete (env as unknown as { WORKSPACE_ERASURE_BACKUP_R2?: unknown }).WORKSPACE_ERASURE_BACKUP_R2;
    const blocked = await handleWorkspaceProjectCleanup(await request(), env);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error_code: "workspace_erasure_backup_unavailable" });
    expect(db.tombstone).toMatchObject({ status: "pending" });
    expect([...objects.keys()]).toContain("spaces/space-a/projects/project-a/workspace/src/main.ts");

    (env as unknown as { WORKSPACE_ERASURE_BACKUP_R2?: unknown }).WORKSPACE_ERASURE_BACKUP_R2 = backup;
    const retried = await handleWorkspaceProjectCleanup(await request(), env);
    expect(retried.status).toBe(200);
    expect(db.backupExports.size).toBe(1);
  });

  it("retries exact runtime erasure notifications before deleting canonical workspace data", async () => {
    const { env, db, eraseCalls, runtimeNotifications, objects } = fixture();
    db.runtimeRows.push({ tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId,
      runtime_kind: "tool_sandbox", object_name: "sandbox:space-a:project-a:branch:main", erasure_attempts: 0 });
    const namespace = (env as unknown as { TOOL_SANDBOX: { get: () => { fetch: (request: Request) => Promise<Response> } } }).TOOL_SANDBOX;
    const originalGet = namespace.get;
    let rejectOnce = true;
    namespace.get = () => ({ fetch: async request => {
      runtimeNotifications.push(request);
      if (rejectOnce) { rejectOnce = false; return Response.json({ error_code: "runtime_erasure_retry_required" }, { status: 503 }); }
      return Response.json({ erased: true, localStatePurged: true, providerSnapshotPurge: "not_supported" });
    } });

    const first = await handleWorkspaceProjectCleanup(await request(), env);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error_code: "workspace_runtime_erasure_pending", pending: 1 });
    expect(eraseCalls).toHaveLength(0);
    expect(objects.has("spaces/space-a/projects/project-a/workspace/src/main.ts")).toBe(true);
    expect(db.runtimeRows[0]).toMatchObject({ erasure_attempts: 1, last_erasure_error: "runtime_erasure_retry_required" });

    namespace.get = originalGet;
    const retried = await handleWorkspaceProjectCleanup(await request(), env);
    expect(retried.status).toBe(200);
    expect(db.runtimeRows[0]).toMatchObject({ erasure_notified_at: expect.any(String), erasure_attempts: 2, last_erasure_error: null });
    expect(runtimeNotifications).toHaveLength(3);
    expect(await runtimeNotifications[0]!.clone().json()).toMatchObject({ scope, confirm: true });
  });
});
