import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "./index.js";
import type { WorkspaceScope } from "./workspace/workspace-contract.js";

const secret = "workspace-archive-route-secret-material";
const scope: WorkspaceScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" };
const manifestHash = "a".repeat(64);
const contentHash = "b".repeat(64);

function archiveSnapshot() {
  return {
    version: 1,
    scope,
    policyGeneration: 2,
    branches: [{ head: { version: 1, scope, branch: "main", revision: 4, manifestHash,
      parentRevision: 3, publicationId: "publication-4", updatedAt: "2026-11-14T00:00:00.000Z" }, base: null }],
  };
}

describe("authenticated project workspace archive routes", () => {
  it("requires an internal tenant token and emits a scope-bound transport snapshot", async () => {
    const forwarded: Request[] = [];
    const stub = { async fetch(request: Request) {
      forwarded.push(request);
      return Response.json({ present: true, snapshot: archiveSnapshot(), objectReferences: [
        { key: `workspace-v1/tenant-a/space-a/project-a/global/manifests/${manifestHash}.json`, etag: "manifest-etag", size: 128 },
        { key: `workspace-v1/tenant-a/space-a/project-a/global/content/${contentHash}`, etag: "content-etag", size: 24 },
      ] });
    } };
    const env = { PLATFORM_SECRET: secret, WORKSPACE_COORDINATOR: {
      idFromName(name: string) { expect(name).toBeTruthy(); return "workspace-id"; },
      get(id: unknown) { expect(id).toBe("workspace-id"); return stub; },
    } } as never;
    const body = JSON.stringify({ scope });
    const rejected = await app.request("/internal/workspaces/archive/export", { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": "invalid",
    }, body }, env);
    expect(rejected.status).toBe(403);
    expect(forwarded).toHaveLength(0);

    const token = await mintInternalToken(secret, scope.tenantId);
    const accepted = await app.request("/internal/workspaces/archive/export", { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token,
    }, body }, env);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ present: true, snapshot: {
      version: 1, projectId: scope.projectId, jurisdiction: scope.jurisdiction, policyGeneration: 2,
      branches: [{ head: { branch: "main", revision: 4, manifestHash }, base: null }],
    }, objectReferences: [{ key: expect.stringContaining("/manifests/"), size: 128 }, { key: expect.stringContaining("/content/"), size: 24 }] });
    expect(new URL(forwarded[0]!.url).pathname).toBe("/v1/archive/export");
    expect(await forwarded[0]!.json()).toEqual({ scope });
  });

  it("validates restore transport fields before reconstructing the coordinator scope", async () => {
    const forwarded: Request[] = [];
    const stub = { async fetch(request: Request) { forwarded.push(request); return Response.json({ restored: true, replay: false, branchCount: 1 }); } };
    const env = { PLATFORM_SECRET: secret, WORKSPACE_COORDINATOR: {
      idFromName() { return "workspace-id"; }, get() { return stub; },
    } } as never;
    const token = await mintInternalToken(secret, scope.tenantId);
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token };
    const invalid = await app.request("/internal/workspaces/archive/restore", { method: "POST", headers, body: JSON.stringify({
      spaceId: scope.spaceId, projectId: scope.projectId, jurisdiction: scope.jurisdiction, restoreId: "restore.test.1",
      snapshot: { version: 1, projectId: scope.projectId, jurisdiction: scope.jurisdiction, policyGeneration: 2,
        branches: [{ head: { branch: "main", revision: "4", manifestHash, parentRevision: null, publicationId: null, updatedAt: "2026-11-14T00:00:00.000Z" }, base: null }] },
    }) }, env);
    expect(invalid.status).toBe(400);
    expect(forwarded).toHaveLength(0);

    const accepted = await app.request("/internal/workspaces/archive/restore", { method: "POST", headers, body: JSON.stringify({
      spaceId: scope.spaceId, projectId: scope.projectId, jurisdiction: scope.jurisdiction, restoreId: "restore.test.1",
      snapshot: { version: 1, projectId: scope.projectId, jurisdiction: scope.jurisdiction, policyGeneration: 2,
        branches: [{ head: { version: 1, branch: "main", revision: 4, manifestHash, parentRevision: 3,
          publicationId: "publication-4", updatedAt: "2026-11-14T00:00:00.000Z" }, base: null }] },
    }) }, env);
    expect(accepted.status).toBe(200);
    const forwardedRequest = forwarded[0]!;
    expect(new URL(forwardedRequest.url).pathname).toBe("/v1/archive/restore");
    expect(await forwardedRequest.json()).toMatchObject({ restoreId: "restore.test.1", snapshot: {
      version: 1, scope, policyGeneration: 2, branches: [{ head: { scope, branch: "main", revision: 4, manifestHash }, base: null }],
    } });
  });
});
