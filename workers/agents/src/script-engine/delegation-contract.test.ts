import { describe, expect, it } from "vitest";
import { childFanout, issueDelegationContract, verifyDelegationContract, type DelegationContract } from "./delegation-contract.js";
const contract: DelegationContract = { tenantId: "t", spaceId: "s", projectId: "p", actorId: "u", agentId: "configured-worker",
  rootRunId: "root", parentRunId: "parent", parentDoId: "parent-do", workerId: "child", depth: 2, planner: true,
  maxTokens: 1800, maxSteps: 4, model: "model", role: "userland-role", callerRole: "editor", maxTier: 3, localOnly: true, localModelMachine: "workstation", filePaths: ["src/owned.ts"],
  workerCapabilities: { enabledPrebuilts: ["conversation", "document-processing"], selectedSkills: ["conversation-research-worker"] } };
describe("host-signed worker identity", () => {
  it("accepts a bounded contract and prevents scope, depth, identity, budget and placement tampering", async () => {
    const token = await issueDelegationContract(contract, "test-host-secret");
    await verifyDelegationContract(contract, token, "test-host-secret");
    const longRun = { ...contract, maxTokens: 2_000_000 };
    const longRunToken = await issueDelegationContract(longRun, "test-host-secret");
    await verifyDelegationContract(longRun, longRunToken, "test-host-secret");
    for (const patch of [{ actorId: "other" }, { projectId: undefined }, { agentId: "other" }, { maxTokens: 2_000_001 },
      { depth: 3, planner: false }, { parentDoId: "other" }, { maxTier: 6 }, { localOnly: false }, { localModelMachine: "other" }, { filePaths: ["src/other.ts"] },
      { workerCapabilities: { enabledPrebuilts: ["code-exec"], selectedSkills: [] } }]) {
      await expect(verifyDelegationContract({ ...contract, ...patch } as DelegationContract, token, "test-host-secret")).rejects.toThrow();
    }
    await expect(verifyDelegationContract(contract, token, "wrong-secret")).rejects.toThrow();
    await expect(verifyDelegationContract(contract, "", "test-host-secret")).rejects.toThrow();
  });
  it("caps planners at four then three children and gives leaves no delegation", async () => {
    expect(childFanout(1, true)).toBe(4); expect(childFanout(2, true)).toBe(3);
    expect(childFanout(2, false)).toBe(0); expect(childFanout(3, false)).toBe(0); expect(childFanout(3, true)).toBe(0);
    await expect(issueDelegationContract({ ...contract, depth: 3 }, "test-host-secret")).rejects.toThrow();
    await expect(issueDelegationContract({ ...contract, maxTokens: 2_000_001 }, "test-host-secret")).rejects.toThrow();
    await expect(issueDelegationContract({ ...contract, filePaths: ["../secret"] }, "test-host-secret")).rejects.toThrow("workspace_path_traversal");
    await expect(issueDelegationContract({ ...contract, workerCapabilities: { enabledPrebuilts: ["../escape"], selectedSkills: [] } }, "test-host-secret")).rejects.toThrow("delegation_worker_capabilities_invalid");
  });
});
