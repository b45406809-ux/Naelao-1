import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { digestExtensionManifest, validateExtensionManifest } from "@naelao/agent-sdk";
import { mintInternalToken } from "@naelao/http";
import { registerExtensionObjectResourceRoutes } from "./extension-object-resource.js";

describe("extension workflow object bridge", () => {
  it("forwards an exact approved Project object operation through durable leases", async () => {
    const manifest = validateExtensionManifest({ id: "ext_object_route", type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.workflow"],
      gadgets: [], daemons: [], commands: [], resourceRequirements: [{ id: "files", kind: "objects", apiVersion: "1.0", scope: "project",
        operations: [{ id: "get", input: { schemaVersion: "1.0", fields: { key: { type: "string", required: true, maxLength: 128 } } },
          output: { schemaVersion: "1.0", fields: { found: { type: "boolean", required: true }, size: { type: "number", required: true, minimum: 0, maximum: 65536 },
            dataBase64: { type: "string", maxLength: 512 }, contentType: { type: "string", maxLength: 128 }, sha256: { type: "string", maxLength: 64 } } },
          idempotency: "none", meteringUnit: "byte" }], limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 1024 } }],
      bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: "ext_object_route", version: "1.0.0", primitives: [
        { schemaVersion: "1.0", kind: "workflow", id: "read_file", version: "1.0.0", permissions: [], capabilityRequirements: [], lifecycle: {},
          executionMode: "headless", entry: "./read.ts", steps: ["read"], toolNames: ["extension.resource.objects"] },
      ], workerRoles: [{ id: "reader", principal: "project_member", invocation: "workflow_step", execution: "worker", entry: "./read.ts", primitiveIds: ["read_file"] }] },
    });
    const manifestSha256 = await digestExtensionManifest(manifest), requirement = manifest.resourceRequirements![0]!;
    const resourceSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(requirement))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const claims: Record<string, unknown>[] = [], operations: Record<string, unknown>[] = [], released: Record<string, unknown>[] = [];
    const spaceStub = { fetch: vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/workflow-installation") return Response.json({ instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a",
        project_id: "project-a", generation: 3, status: "active", scope: "PROJECT_BOUND" }, manifest, release: { signatureValid: true, dependenciesResolved: true },
        resource_grants: [{ requirement_id: "files", manifest_sha256: manifestSha256, resource_sha256: resourceSha256,
          installation_generation: 3, operations: ["get"], tables: [], status: "approved", revision: 7 }] });
      if (path === "/extension-runtime-work") return Response.json({ acquired: true });
      if (path === "/extension-resource-operation") { claims.push(await request.json() as Record<string, unknown>); return Response.json({ lease_id: "12345678-1234-1234-1234-123456789abc" }); }
      if (path === "/extension-object-operation") { operations.push(await request.json() as Record<string, unknown>); return Response.json({ found: false, size: 0 }); }
      if (path === "/extension-resource-operation/release") { released.push(await request.json() as Record<string, unknown>); return Response.json({ released: true }); }
      throw new Error(`unexpected SpaceDO path ${path}`);
    }) };
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
      SPACE_DO: { idFromName: () => "space-do", get: () => spaceStub } };
    const app = new Hono(); registerExtensionObjectResourceRoutes(app as never);
    const token = await mintInternalToken(env.PLATFORM_SECRET, "tenant-a"), headers = { "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const response = await app.request("/spaces/space-a/internal/extensions/install-a/objects", { method: "POST", headers,
      body: JSON.stringify({ project_id: "project-a", workflow_id: "read_file", requirement_id: "files", operation_id: "get",
        input: { key: "manual/readme.txt" }, grant: { manifest_sha256: manifestSha256, resource_sha256: resourceSha256,
          installation_generation: 3, grant_revision: 7 } }) }, env as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ found: false, size: 0 });
    expect(claims).toMatchObject([{ tenantId: "tenant-a", projectId: "project-a", requirementId: "files", operationId: "get", resourceKind: "objects",
      gadgetId: "objects", table: "objects", manifestSha256, resourceSha256, installationGeneration: 3, grantRevision: 7 }]);
    expect(operations).toMatchObject([{ requirementId: "files", operationId: "get", leaseId: "12345678-1234-1234-1234-123456789abc",
      input: { key: "manual/readme.txt" } }]);
    expect(released).toMatchObject([{ instanceId: "install-a", leaseId: "12345678-1234-1234-1234-123456789abc" }]);
  });

  it("rejects a missing grant proof before reading the installation", async () => {
    const spaceFetch = vi.fn(async () => new Response());
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
      SPACE_DO: { idFromName: () => "space-do", get: () => ({ fetch: spaceFetch }) } };
    const app = new Hono(); registerExtensionObjectResourceRoutes(app as never);
    const token = await mintInternalToken(env.PLATFORM_SECRET, "tenant-a");
    const response = await app.request("/spaces/space-a/internal/extensions/install-a/objects", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ project_id: "project-a", workflow_id: "read_file", requirement_id: "files", operation_id: "get", input: { key: "file.txt" } }) }, env as never);
    expect(response.status).toBe(400);
    expect(spaceFetch).not.toHaveBeenCalled();
  });
});
