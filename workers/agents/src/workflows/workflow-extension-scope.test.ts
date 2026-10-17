import { describe, expect, it } from "vitest";
import { assertDeclaredExtensionWorkflow, extensionWorkflowName, resolveExtensionGadgetAppId, verifyExtensionArtifactSet, workflowHash, workflowWorkspaceExtensionId, type WorkflowInstallationGrant } from "./workflow-host.js";

const installation: WorkflowInstallationGrant = {
  instance: { tenant_id: "tenant", space_id: "space", status: "active", scope: "SPACE_SHARED" },
  manifest: { id: "ext_customs", daemons: [{ workflowScript: "./indexer.ts" }] },
};

describe("verified extension workflow identity", () => {
  it("recomputes the full immutable R2 release digest", async () => {
    const prefix = "spaces/space/extensions/ext_customs/1.0.0/";
    const files = new Map([[`${prefix}place-order.ts`, "export function run() { return 1; }"], [`${prefix}console.html`, "<main>Hi</main>"]]);
    const bucket = {
      list: async ({ prefix: requested }: { prefix: string }) => ({ objects: [...files.keys()].filter(key => key.startsWith(requested)).map(key => ({ key })), truncated: false }),
      get: async (key: string) => { const value = files.get(key); return value === undefined ? null : { text: async () => value }; },
    } as never;
    const entries = [...files].map(([key, value]) => [`./${key.slice(prefix.length)}`, value] as [string, string]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const expectedSha256 = await workflowHash(JSON.stringify(entries));
    expect(await verifyExtensionArtifactSet(bucket, { spaceId: "space", extensionId: "ext_customs", version: "1.0.0", expectedSha256 })).toBe(true);
    files.set(`${prefix}place-order.ts`, "export function run() { return 2; }");
    expect(await verifyExtensionArtifactSet(bucket, { spaceId: "space", extensionId: "ext_customs", version: "1.0.0", expectedSha256 })).toBe(false);
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
      ], workerRoles: [{ principal: "project_member", invocation: "workflow_step", execution: "worker", entry: "./place-order.ts", primitiveIds: ["place_order"] }] } } };
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "trade_journal" })).toBe("mentor2_trade_journal");
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.update", gadgetId: "trade_journal" })).toBe("mentor2_trade_journal");
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "other" })).toBeNull();
    expect(resolveExtensionGadgetAppId({ installation: composed, workflowId: "place_order", operation: "extension.gadget.get", gadgetId: "trade_journal" })).toBeNull();
    expect(resolveExtensionGadgetAppId({ installation: { ...composed, instance: { ...composed.instance, project_id: null } }, workflowId: "place_order", operation: "extension.gadget.insert", gadgetId: "trade_journal" })).toBeNull();
  });

  it("isolates space-wide durable extension workflows by the verified installation", () => {
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", installationId: "installation:tenant:ext_customs:space:space" })).toBe("installation:tenant:ext_customs:space:space");
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", projectId: "project", installationId: "installation-a" })).toBeUndefined();
    expect(workflowWorkspaceExtensionId({ workflowClass: "ephemeral_task", installationId: "installation-a" })).toBeUndefined();
  });
});
