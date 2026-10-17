import { describe, expect, it } from "vitest";
import { assertDeclaredExtensionWorkflow, extensionWorkflowName, verifyExtensionArtifactSet, workflowHash, workflowWorkspaceExtensionId, type WorkflowInstallationGrant } from "./workflow-host.js";

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

  it("isolates space-wide durable extension workflows by the verified installation", () => {
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", installationId: "installation:tenant:ext_customs:space:space" })).toBe("installation:tenant:ext_customs:space:space");
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", projectId: "project", installationId: "installation-a" })).toBeUndefined();
    expect(workflowWorkspaceExtensionId({ workflowClass: "ephemeral_task", installationId: "installation-a" })).toBeUndefined();
  });
});
