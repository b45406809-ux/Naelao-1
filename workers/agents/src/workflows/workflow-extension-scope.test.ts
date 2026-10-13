import { describe, expect, it } from "vitest";
import { assertDeclaredExtensionWorkflow, extensionWorkflowName, workflowWorkspaceExtensionId, type WorkflowInstallationGrant } from "./workflow-host.js";

const installation: WorkflowInstallationGrant = {
  instance: { tenant_id: "tenant", space_id: "space", status: "active", scope: "SPACE_SHARED" },
  manifest: { id: "ext_customs", daemons: [{ workflowScript: "./indexer.ts" }] },
};

describe("verified extension workflow identity", () => {
  it("maps a manifest-declared script and exact extension ID to an installed instance", () => {
    expect(extensionWorkflowName("./indexer.ts")).toBe("indexer");
    expect(extensionWorkflowName("../indexer.ts")).toBeNull();
    expect(() => assertDeclaredExtensionWorkflow(installation, "indexer", "ext_customs")).not.toThrow();
    expect(() => assertDeclaredExtensionWorkflow(installation, "other", "ext_customs")).toThrow("workflow_script_not_declared_by_installation");
    expect(() => assertDeclaredExtensionWorkflow(installation, "indexer", "ext_other")).toThrow("workflow_extension_identity_mismatch");
  });

  it("isolates space-wide durable extension workflows by the verified installation", () => {
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", installationId: "installation:tenant:ext_customs:space:space" })).toBe("installation:tenant:ext_customs:space:space");
    expect(workflowWorkspaceExtensionId({ workflowClass: "vertical_extension", projectId: "project", installationId: "installation-a" })).toBeUndefined();
    expect(workflowWorkspaceExtensionId({ workflowClass: "ephemeral_task", installationId: "installation-a" })).toBeUndefined();
  });
});
