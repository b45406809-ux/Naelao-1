import { mintInternalToken } from "@naelao/http";
import { describe, expect, it } from "vitest";
import { handleSandboxWorkspaceBridge } from "./workspace-bridge.js";

class Statement {
  values: unknown[] = [];
  constructor(private sql: string, private db: FakeD1) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  first<T>() { return this.db.first<T>(this.sql, this.values); }
  all<T>() { return this.db.all<T>(this.sql, this.values); }
  run() { return this.db.run(this.sql, this.values); }
}
class FakeD1 {
  snapshots = new Map<string, Record<string, unknown>>();
  blobs = new Map<string, Record<string, unknown>>();
  publications = new Map<string, Record<string, unknown>>();
  entries: Array<Record<string, unknown>> = [];
  prepare(sql: string) { return new Statement(sql, this); }
  async first<T>(sql: string, values: unknown[]): Promise<T | null> {
    if (sql.includes("FROM sandbox_filesystems")) return (String(values[0]) === "fs-1" ? {
      id: "fs-1", tenant_id: "tenant-1", owner_id: "user-1", space_id: "space-1", project_id: "project-1", branch: "main", mode: "snapshot_diff", consistency: "file_cas", status: "active",
    } : null) as T | null;
    if (sql.includes("FROM sandbox_computers")) return (String(values[0]) === "computer-1" ? { id: "computer-1" } : null) as T | null;
    if (sql.includes("FROM sandbox_workspace_blobs")) return (this.blobs.get(String(values[0])) ?? null) as T | null;
    if (sql.includes("FROM sandbox_workspace_snapshots")) return (this.snapshots.get(String(values[0])) ?? null) as T | null;
    if (sql.includes("FROM sandbox_publications")) return (this.publications.get(`${values[0]}:${values[1]}:${values[2]}`) ?? null) as T | null;
    return null;
  }
  async all<T>(sql: string, values: unknown[]) {
    if (sql.includes("sandbox_workspace_snapshot_entries")) return { results: this.entries.filter((row) => row.snapshot_id === values[0]) as T[] };
    return { results: [] as T[] };
  }
  async run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO sandbox_workspace_snapshots")) this.snapshots.set(String(values[0]), { id: values[0], tenant_id: values[1], filesystem_id: values[2], computer_id: values[3], status: "active", coordinator_revision: values[7] });
    if (sql.includes("INSERT INTO sandbox_workspace_blobs")) this.blobs.set(String(values[0]), { id: values[0], tenant_id: values[1], filesystem_id: values[2], snapshot_id: values[3], object_key: values[4], sha256: values[5], size_bytes: values[6], executable: values[7] });
    if (sql.includes("INSERT INTO sandbox_workspace_snapshot_entries")) this.entries.push({ snapshot_id: values[0], path: values[1], blob_id: values[2], sha256: values[3], size_bytes: values[4], executable: values[5] });
    if (sql.includes("INSERT INTO sandbox_publications")) {
      const row = { id: values[0], tenant_id: values[1], filesystem_id: values[2], computer_id: values[3], branch: values[4], status: "pending", changes_json: values[5], applied_paths_json: "[]", conflicts_json: "[]", idempotency_key: values[8], snapshot_id: values[9] };
      this.publications.set(`${values[1]}:${values[2]}:${values[8]}`, row);
      this.publications.set(`id:${values[0]}`, row);
    }
    if (sql.includes("UPDATE sandbox_publications")) {
      const row = this.publications.get(`id:${values[4]}`);
      if (row) Object.assign(row, { status: values[0], applied_paths_json: values[1], conflicts_json: values[2] });
    }
    if (sql.includes("UPDATE sandbox_workspace_snapshots")) {
      const row = this.snapshots.get(String(values[0]));
      if (row) row.status = "published";
    }
    return { success: true, meta: { changes: 1 } };
  }
  async batch(statements: Statement[]) { for (const statement of statements) await statement.run(); return statements.map(() => ({ success: true, meta: { changes: 1 } })); }
}

describe("sandbox workspace snapshot bridge", () => {
  it("rejects unauthenticated access and limits snapshots to safe canonical workspace files", async () => {
    const db = new FakeD1();
    const objects = new Map<string, Uint8Array>([
      ["spaces/space-1/projects/project-1/workspace/branches/main/src/main.ts", new TextEncoder().encode("ok")],
      ["spaces/space-1/projects/project-1/workspace/branches/main/.env", new TextEncoder().encode("secret")],
      ["spaces/space-1/projects/project-1/workspace/branches/dev/src/main.ts", new TextEncoder().encode("other branch")],
    ]);
    const metadata = new Map<string, Record<string, string>>();
    const bucket = {
      async list({ prefix }: { prefix: string }) {
        return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: objects.get(key)!.byteLength })), truncated: false };
      },
      async head(key: string) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength, etag: `etag-${key}`, customMetadata: metadata.get(key) ?? {} } : null;
      },
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return { body: new Blob([bytes]).stream(), size: bytes.byteLength, httpMetadata: metadata.get(`${key}:http`) ?? {}, async arrayBuffer() { return bytes.slice().buffer; } };
      },
      async put(key: string, value: Uint8Array, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) {
        objects.set(key, value.slice());
        if (options?.customMetadata) metadata.set(key, options.customMetadata);
        if (options?.httpMetadata?.contentType) metadata.set(`${key}:http`, { contentType: options.httpMetadata.contentType });
      },
      async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    } as unknown as R2Bucket;
    const concurrency = {
      idFromName: (name: string) => name,
      get: () => ({ async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/locks/acquire") return Response.json({ acquired: true, fencingToken: 2 });
        if (url.pathname === "/locks/release") return Response.json({ released: true });
        if (url.pathname === "/lock/acquire") return Response.json({ acquired: true, fencingToken: 1 });
        if (url.pathname === "/lock/release") return Response.json({ released: true });
        const value = await request.json() as { path: string; expectedHash: string | null; operation: string; contentBase64?: string };
        const current = objects.get(value.path);
        const actual = current ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", current))].map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
        if (actual !== value.expectedHash) return Response.json({ error_code: "conflict" }, { status: 409 });
        if (value.operation === "delete") objects.delete(value.path);
        else objects.set(value.path, Uint8Array.from(atob(value.contentBase64!), (character) => character.charCodeAt(0)));
        return Response.json({ published: true });
      } }),
    } as unknown as DurableObjectNamespace;
    const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: "test-secret", SCRIPTS_R2: bucket, CONCURRENCY_DO: concurrency,
      WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ async fetch() { return Response.json({ migration: null }); } }) } };
    const path = "http://agents/internal/sandbox-workspaces/snapshot";
    const noAuth = await handleSandboxWorkspaceBridge(new Request(path, { method: "POST", body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1" }) }), env);
    expect(noAuth.status).toBe(403);

    const token = await mintInternalToken(env.PLATFORM_SECRET, "tenant-1");
    const unifiedEnv = { ...env, UNIFIED_WORKSPACE_ENABLED: "true" };
    const unifiedHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "user-1", "x-naelao-internal-token": token };
    const blockedSnapshot = await handleSandboxWorkspaceBridge(new Request(path, { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1" }) }), unifiedEnv);
    expect(blockedSnapshot.status).toBe(503);
    const contentHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ok")))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const coordinatorCalls: string[] = [];
    let coordinatorCheckpoint: { changes?: Array<{ contentType?: string }> } | null = null;
    const coordinatorEnv = { ...unifiedEnv, WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
      const url = new URL(request.url); coordinatorCalls.push(url.pathname);
      if (url.pathname === "/v1/read") return Response.json({ head: { revision: 7, branch: "main" }, entries: [{ path: "src/main.ts", sha256: contentHash, size: 2, executable: false, contentType: "text/plain", objectKey: `workspace-v1/tenant-1/space-1/project-1/global/content/${contentHash}` }] });
      if (url.pathname === "/v1/open") return Response.json({ session: { id: `ws_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`, fence: 0 }, head: { revision: 7 } });
      if (url.pathname === "/v1/checkpoint") { coordinatorCheckpoint = await request.json() as { changes?: Array<{ contentType?: string }> }; return Response.json({ publication: { status: "published", revision: 8, appliedPaths: ["src/main.ts"], conflicts: [] } }); }
      return Response.json({ ok: true });
    } }) } };
    const canonicalKey = `workspace-v1/tenant-1/space-1/project-1/global/content/${contentHash}`;
    const legacyMainKey = "spaces/space-1/projects/project-1/workspace/branches/main/src/main.ts";
    metadata.set(`${legacyMainKey}:http`, { contentType: "text/plain" });
    objects.set(canonicalKey, new TextEncoder().encode("ok"));
    metadata.set(`${canonicalKey}:http`, { contentType: "text/plain" });
    const legacyOnlyKey = "spaces/space-1/projects/project-1/workspace/branches/main/legacy-only.txt";
    objects.set(legacyOnlyKey, new TextEncoder().encode("drift"));
    const driftSnapshot = await handleSandboxWorkspaceBridge(new Request(path, { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1" }) }), coordinatorEnv);
    expect(driftSnapshot.status).toBe(409);
    expect(await driftSnapshot.json()).toMatchObject({ error_code: "workspace_dual_read_drift" });
    objects.delete(legacyOnlyKey);
    metadata.set(`${legacyMainKey}:http`, { contentType: "application/pdf" });
    const mimeDrift = await handleSandboxWorkspaceBridge(new Request(path, { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1" }) }), coordinatorEnv);
    expect(mimeDrift.status).toBe(409);
    expect(await mimeDrift.json()).toMatchObject({ error_code: "workspace_dual_read_drift" });
    metadata.set(`${legacyMainKey}:http`, { contentType: "text/plain" });
    const manifestSnapshotResponse = await handleSandboxWorkspaceBridge(new Request(path, { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1" }) }), coordinatorEnv);
    expect(manifestSnapshotResponse.status).toBe(200);
    const manifestSnapshotBody = await manifestSnapshotResponse.json() as { snapshot: { id: string; revision: number; entries: Array<{ sha256: string }> } };
    expect(manifestSnapshotBody).toMatchObject({ snapshot: { revision: 7, entries: [{ sha256: contentHash }] } });
    const unifiedStaged = await handleSandboxWorkspaceBridge(new Request("http://agents/internal/sandbox-workspaces/blobs", { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", snapshotId: manifestSnapshotBody.snapshot.id, sha256: contentHash, contentBase64: btoa("ok"), contentType: "application/pdf" }) }), coordinatorEnv);
    const unifiedStagedBody = await unifiedStaged.json() as { blobId: string };
    const unifiedPublished = await handleSandboxWorkspaceBridge(new Request("http://agents/internal/sandbox-workspaces/publish", { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1", snapshotId: manifestSnapshotBody.snapshot.id, idempotencyKey: "unified-publish-1", changes: [{ path: "src/main.ts", expectedHash: contentHash, blobId: unifiedStagedBody.blobId }] }) }), coordinatorEnv);
    expect(unifiedPublished.status).toBe(200);
    expect(await unifiedPublished.json()).toMatchObject({ publication: { revision: 8, status: "published" } });
    expect(coordinatorCheckpoint).toMatchObject({ changes: [{ contentType: "application/pdf" }] });
    expect(coordinatorCalls).toContain("/v1/checkpoint");

    const largeBytes = new Uint8Array(5 * 1024 * 1024).fill(65);
    const largeHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", largeBytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    let largeBinary = "";
    for (let offset = 0; offset < largeBytes.length; offset += 0x8000) largeBinary += String.fromCharCode(...largeBytes.subarray(offset, offset + 0x8000));
    const largeStage = await handleSandboxWorkspaceBridge(new Request("http://agents/internal/sandbox-workspaces/blobs", { method: "POST", headers: unifiedHeaders,
      body: JSON.stringify({ filesystemId: "fs-1", snapshotId: manifestSnapshotBody.snapshot.id, sha256: largeHash, contentBase64: btoa(largeBinary), contentType: "application/octet-stream" }) }), coordinatorEnv);
    expect(largeStage.status).toBe(200);
    const result = await handleSandboxWorkspaceBridge(new Request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "user-1", "x-naelao-internal-token": token },
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1" }),
    }), env);
    expect(result.status).toBe(200);
    const body = await result.json() as { snapshot: { id: string; entries: Array<{ path: string; sha256: string; blobId: string }> } };
    expect(body.snapshot.entries.map((entry) => entry.path)).toEqual(["src/main.ts"]);
    expect(body.snapshot.entries[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.snapshot.entries[0].blobId).toMatch(/^swb_/);

    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "user-1", "x-naelao-internal-token": token };
    const changedBytes = new TextEncoder().encode("changed");
    const changedHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", changedBytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const staged = await handleSandboxWorkspaceBridge(new Request("http://agents/internal/sandbox-workspaces/blobs", { method: "POST", headers, body: JSON.stringify({ filesystemId: "fs-1", snapshotId: body.snapshot.id, sha256: changedHash, contentBase64: btoa("changed") }) }), env);
    expect(staged.status).toBe(200);
    const stagedBody = await staged.json() as { blobId: string };
    const published = await handleSandboxWorkspaceBridge(new Request("http://agents/internal/sandbox-workspaces/publish", {
      method: "POST", headers,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1", snapshotId: body.snapshot.id, idempotencyKey: "publish-1", changes: [{ path: "src/main.ts", expectedHash: body.snapshot.entries[0]!.sha256, blobId: stagedBody.blobId }] }),
    }), env);
    expect(published.status).toBe(200);
    expect(new TextDecoder().decode(objects.get("spaces/space-1/projects/project-1/workspace/branches/main/src/main.ts"))).toBe("changed");
    const replay = await handleSandboxWorkspaceBridge(new Request("http://agents/internal/sandbox-workspaces/publish", {
      method: "POST", headers,
      body: JSON.stringify({ filesystemId: "fs-1", computerId: "computer-1", snapshotId: body.snapshot.id, idempotencyKey: "publish-1", changes: [{ path: "src/main.ts", expectedHash: body.snapshot.entries[0]!.sha256, blobId: stagedBody.blobId }] }),
    }), env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await published.clone().json());
  });
});
