import { describe, expect, it, vi } from "vitest";
import { assertDeclaredExtensionWorkflow, extensionWorkflowName, readWorkflowGrant, resolveApprovedObjectGrant, resolveApprovedStructuredDataGrant,
  resolveExtensionGadgetAppId, verifyExtensionArtifactSet, workflowHash, workflowWorkspaceExtensionId, type DurableWorkflowHostEnv, type WorkflowInstallationGrant } from "./workflow-host.js";

const installation: WorkflowInstallationGrant = {
  instance: { tenant_id: "tenant", space_id: "space", status: "active", scope: "SPACE_SHARED" },
  manifest: { id: "ext_customs", daemons: [{ workflowScript: "./indexer.ts" }] },
};

describe("verified extension workflow identity", () => {
  it("rejects an oversized agent config from R2 metadata before materializing its text", async () => {
    const text = vi.fn(async () => "oversized");
    const env = {
      PLATFORM_SECRET: "test-secret",
      SPACES_WORKER: { fetch: async () => Response.json({ data: [{ user_id: "user", role: "owner" }] }) },
      SCRIPTS_R2: { get: async () => ({ size: 1024 * 1024 + 1, text }) },
    } as unknown as DurableWorkflowHostEnv;
    await expect(readWorkflowGrant(env, { tenantId: "tenant", spaceId: "space", actorId: "user", agentId: "agent" })).rejects.toThrow("workflow_agent_config_too_large");
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects an oversized membership response before using its grant", async () => {
    const env = {
      PLATFORM_SECRET: "test-secret",
      SPACES_WORKER: { fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) },
      SCRIPTS_R2: { get: async () => ({ size: 0, text: async () => "" }) },
    } as unknown as DurableWorkflowHostEnv;
    await expect(readWorkflowGrant(env, { tenantId: "tenant", spaceId: "space", actorId: "user", agentId: "agent" })).rejects.toThrow();
  });

  it("recomputes the full immutable R2 release digest", async () => {
    const prefix = "spaces/space/extensions/ext_customs/1.0.0/";
    const files = new Map([[`${prefix}place-order.ts`, "export function run() { return 1; }"], [`${prefix}console.html`, "<main>Hi</main>"]]);
    const bucket = {
      list: async ({ prefix: requested }: { prefix: string }) => ({ objects: [...files.keys()].filter(key => key.startsWith(requested)).map(key => ({ key, size: new TextEncoder().encode(files.get(key)!).byteLength })), truncated: false }),
      get: async (key: string) => { const value = files.get(key); return value === undefined ? null : { size: new TextEncoder().encode(value).byteLength, text: async () => value }; },
    } as never;
    const entries = [...files].map(([key, value]) => [`./${key.slice(prefix.length)}`, value] as [string, string]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const expectedSha256 = await workflowHash(JSON.stringify(entries));
    expect(await verifyExtensionArtifactSet(bucket, { spaceId: "space", extensionId: "ext_customs", version: "1.0.0", expectedSha256 })).toBe(true);
    files.set(`${prefix}place-order.ts`, "export function run() { return 2; }");
    expect(await verifyExtensionArtifactSet(bucket, { spaceId: "space", extensionId: "ext_customs", version: "1.0.0", expectedSha256 })).toBe(false);
  });

  it("rejects an oversized artifact from listing metadata before fetching its body", async () => {
    const get = vi.fn(async () => null);
    const bucket = {
      list: async () => ({ objects: [{ key: "spaces/space/extensions/ext_customs/1.0.0/large.ts", size: 2_000_001 }], truncated: false }),
      get,
    } as never;

    await expect(verifyExtensionArtifactSet(bucket, {
      spaceId: "space",
      extensionId: "ext_customs",
      version: "1.0.0",
      expectedSha256: "0".repeat(64),
    })).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("maps a manifest-declared script and exact extension ID to an installed instance", () => {
    expect(extensionWorkflowName("./indexer.ts")).toBe("indexer");
    expect(extensionWorkflowName("../indexer.ts")).toBeNull();
    expect(() => assertDeclaredExtensionWorkflow(installation, "indexer", "ext_customs")).not.toThrow();
    expect(() => assertDeclaredExtensionWorkflow(installation, "other", "ext_customs")).toThrow("workflow_script_not_declared_by_installation");
    expect(() => assertDeclaredExtensionWorkflow(installation, "indexer", "ext_other")).toThrow("workflow_extension_identity_mismatch");
  });

  it("resolves a composed workflow part by its stable primitive id or entry name", () => {
    const composed: WorkflowInstallationGrant = { ...installation, manifest: { id: "ext_customs", bundle: { id: "ext_customs", version: "1.0.0", primitives: [
      { kind: "workflow", id: "place_order", entry: "./place-order.ts", steps: [], toolNames: ["orders.place"] },
    ] } } };
    expect(assertDeclaredExtensionWorkflow(composed, "place_order", "ext_customs")).toEqual({ id: "place_order", entry: "./place-order.ts", toolNames: ["orders.place"] });
    expect(assertDeclaredExtensionWorkflow(composed, "place-order", "ext_customs")).toMatchObject({ entry: "./place-order.ts" });
  });

  it("authorizes a Gadget only for a project-member workflow bound inside its exact active install", () => {
    const composed: WorkflowInstallationGrant = { instance: { tenant_id: "tenant", space_id: "space", project_id: "project", instance_id: "install-a", instance_key: "mentor2", status: "active", scope: "PROJECT_BOUND" },
      manifest: { id: "ext_customs", bundle: { id: "ext_customs", version: "1.0.0", primitives: [
        { kind: "workflow", id: "place_order", entry: "./place-order.ts", toolNames: ["extension.gadget.insert", "extension.gadget.update"] }, { kind: "gadget", id: "trade_journal" },
      ], workerRoles: [{ principal: "project_member", invocation: "workflow_step", execution: "worker", entry: "./place-order.ts", primitiveIds: ["place_order"], gadgetActions: [{ gadgetId: "trade_journal", operations: ["extension.gadget.insert", "extension.gadget.update"], tables: ["trades"] }] }] } } };
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "trade_journal", table: "trades" })).toBe("mentor2_trade_journal");
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.update", gadgetId: "trade_journal", table: "trades" })).toBe("mentor2_trade_journal");
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "trade_journal", table: "private" })).toBeNull();
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "other", table: "trades" })).toBeNull();
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.get", gadgetId: "trade_journal", table: "trades" })).toBeNull();
    expect(resolveExtensionGadgetAppId({ installation: { ...composed, instance: { ...composed.instance, project_id: null } }, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "trade_journal", table: "trades" })).toBeNull();
  });

  it("requires current owner approval pinned to the exact resource, install generation, operation and table", async () => {
    const requirement = { id: "records", kind: "structured_data", apiVersion: "1.0", scope: "project", binding: { gadgetId: "catalog", tables: ["records"] },
      operations: [{ id: "get", input: { schemaVersion: "1.0", fields: {} }, output: { schemaVersion: "1.0", fields: {} }, idempotency: "none", meteringUnit: "request" }],
      limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 1024 } };
    const manifest = { id: "ext_catalog", resourceRequirements: [requirement] } as unknown as WorkflowInstallationGrant["manifest"];
    const manifestSha256 = await workflowHash(JSON.stringify(manifest));
    const resourceSha256 = await workflowHash(JSON.stringify(requirement));
    const current: WorkflowInstallationGrant = { instance: { instance_id: "install-a", tenant_id: "tenant", space_id: "space", project_id: "project-a",
      generation: 4, status: "active", scope: "PROJECT_BOUND" }, manifest,
      resource_grants: [{ requirement_id: "records", manifest_sha256: manifestSha256, resource_sha256: resourceSha256, installation_generation: 4,
        operations: ["get"], tables: ["records"], status: "approved", revision: 3 }] };
    await expect(resolveApprovedStructuredDataGrant(current, "records", "get", "records")).resolves.toMatchObject({ revision: 3 });
    await expect(resolveApprovedStructuredDataGrant({ ...current, instance: { ...current.instance, generation: 5 } }, "records", "get", "records")).resolves.toBeNull();
    await expect(resolveApprovedStructuredDataGrant({ ...current, resource_grants: [{ ...current.resource_grants![0]!, status: "revoked" }] }, "records", "get", "records")).resolves.toBeNull();
    await expect(resolveApprovedStructuredDataGrant({ ...current, resource_grants: [{ ...current.resource_grants![0]!, tables: ["private"] }] }, "records", "get", "records")).resolves.toBeNull();
    await expect(resolveApprovedStructuredDataGrant({ ...current, resource_grants: [{ ...current.resource_grants![0]!, manifest_sha256: "0".repeat(64) }] }, "records", "get", "records")).resolves.toBeNull();
  });

  it("requires exact generation and an operation-only grant for object resources", async () => {
    const requirement = { id: "attachments", kind: "objects", apiVersion: "1.0", scope: "project", operations: [
      { id: "get", input: { schemaVersion: "1.0", fields: {} }, output: { schemaVersion: "1.0", fields: {} }, idempotency: "none", meteringUnit: "byte" },
    ], limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 1024 } };
    const manifest = { id: "ext_objects", resourceRequirements: [requirement] } as unknown as WorkflowInstallationGrant["manifest"];
    const manifestSha256 = await workflowHash(JSON.stringify(manifest)), resourceSha256 = await workflowHash(JSON.stringify(requirement));
    const current: WorkflowInstallationGrant = { instance: { instance_id: "install-a", tenant_id: "tenant", space_id: "space", project_id: "project-a",
      generation: 4, status: "active", scope: "PROJECT_BOUND" }, manifest, resource_grants: [{ requirement_id: "attachments", manifest_sha256: manifestSha256,
        resource_sha256: resourceSha256, installation_generation: 4, operations: ["get"], tables: [], status: "approved", revision: 2 }] };
    await expect(resolveApprovedObjectGrant(current, "attachments", "get")).resolves.toMatchObject({ revision: 2 });
    await expect(resolveApprovedObjectGrant({ ...current, instance: { ...current.instance, generation: 5 } }, "attachments", "get")).resolves.toBeNull();
    await expect(resolveApprovedObjectGrant({ ...current, resource_grants: [{ ...current.resource_grants![0]!, tables: ["bucket"] }] }, "attachments", "get")).resolves.toBeNull();
    await expect(resolveApprovedObjectGrant(current, "attachments", "put")).resolves.toBeNull();
  });

  it("isolates space-wide durable extension workflows by the verified installation", () => {
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", installationId: "installation:tenant:ext_customs:space:space" })).toBe("installation:tenant:ext_customs:space:space");
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", projectId: "project", installationId: "installation-a" })).toBeUndefined();
    expect(workflowWorkspaceExtensionId({ workflowClass: "ephemeral_task", installationId: "installation-a" })).toBeUndefined();
  });
});
