import { describe, expect, it } from "vitest";
import { InstallationLedger, canUseLinkedSpace, scopedInstallationId } from "@naelao/agent-sdk";
import { validateMigrationSequence } from "@naelao/db";
import { deriveSpaceInstallationId } from "../../workers/spaces/src/create-space";
import { linkedBusinessTenantBoundary } from "../../workers/spaces/src/business-create";
import { restartLocalWorkers, retrieveSeededSpace, seedSpace } from "./support/runtime";

const shared = { tenantId: "tenant-a", spaceId: "space-a", extensionId: "ext.crm", scope: "SPACE_SHARED" as const, installedBy: "owner" };
const projectPrivate = { ...shared, scope: "PROJECT_USER" as const, projectId: "project-a", userId: "alice" };

describe("Step 03 tenancy and installation lifetimes", () => {
  it("keeps space-owned state after deleting a launching project", () => {
    const ledger = new InstallationLedger();
    const spaceShared = ledger.install(shared);
    const projectPrivateRecord = ledger.install(projectPrivate);
    const projectShared = ledger.install({ ...shared, scope: "PROJECT_SHARED", projectId: "project-a" as const });
    expect(ledger.removeProject("space-a", "project-a")).toBe(2);
    expect(ledger.list("space-a").find((record) => record.instanceId === spaceShared.instanceId)?.status).toBe("active");
    expect(ledger.list("space-a").find((record) => record.instanceId === projectPrivateRecord.instanceId)?.status).toBe("removed");
    expect(ledger.list("space-a").find((record) => record.instanceId === projectShared.instanceId)?.status).toBe("removed");
  });

  it("derives collision-resistant identities from tenant and installation scope", () => {
    const a = scopedInstallationId(shared);
    const b = scopedInstallationId({ ...shared, tenantId: "tenant-b" });
    expect(a).not.toBe(b);
    expect(a).toBe(deriveSpaceInstallationId(shared));
    expect(() => scopedInstallationId({ ...shared, scope: "PROJECT_SHARED" })).toThrow(/project_id_required/);
  });

  it("removes a user’s private instances without touching shared records", () => {
    const ledger = new InstallationLedger();
    const privateRecord = ledger.install(projectPrivate);
    const spacePrivate = ledger.install({ ...shared, scope: "SPACE_USER", userId: "alice" });
    const spaceShared = ledger.install(shared);
    expect(ledger.removeMember("space-a", "alice")).toBe(2);
    expect(ledger.list().find((record) => record.instanceId === privateRecord.instanceId)?.status).toBe("removed");
    expect(ledger.list().find((record) => record.instanceId === spacePrivate.instanceId)?.status).toBe("removed");
    expect(ledger.list().find((record) => record.instanceId === spaceShared.instanceId)?.status).toBe("active");
    expect(ledger.removeMember("space-a", "alice")).toBe(0);
  });

  it("requires an explicit linked-space grant and does not inherit data", () => {
    const boundary = linkedBusinessTenantBoundary({ parentTenantId: "tenant-parent", childTenantId: "tenant-child", linkedBySpaceId: "space-parent" });
    expect(boundary.dataInheritance).toBe("none");
    const grant = { grantId: "grant-1", tenantId: "tenant-parent", fromSpaceId: "space-parent", toSpaceId: "space-child", userId: "alice", actions: ["read"] as const };
    expect(canUseLinkedSpace(grant, { tenantId: "tenant-parent", fromSpaceId: "space-parent", toSpaceId: "space-child", userId: "alice", action: "read" })).toBe(true);
    expect(canUseLinkedSpace(grant, { tenantId: "tenant-parent", fromSpaceId: "space-parent", toSpaceId: "space-child", userId: "bob", action: "read" })).toBe(false);
  });

  it("validates additive migration plans and survives restart/replay", async () => {
    expect(() => validateMigrationSequence([{ version: 62, description: "new", up: "CREATE TABLE x(id TEXT);" }, { version: 62, description: "duplicate", up: "CREATE TABLE y(id TEXT);" }])).toThrow(/duplicate_migration_version/);
    const seeded = await seedSpace();
    await restartLocalWorkers();
    expect(await retrieveSeededSpace()).toEqual(seeded);
  });
});
