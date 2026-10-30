import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./create-space.js", () => ({
  createSpaceRecord: vi.fn(),
  SpaceCreationError: class SpaceCreationError extends Error { constructor(public status: number) { super(); } },
}));
import { createSpaceRecord } from "./create-space.js";
import { ensureLaunchpad } from "./launchpad-bootstrap.js";

function envFor(rows: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "development",
    NAELAO_DASHBOARD_TENANT_ID: "team",
    PLATFORM_DB: { prepare(sql: string) { return { bind() { return { first: async () => sql.includes("product_slug") ? rows.slug ?? null : sql.includes("FROM orgs") ? rows.org ?? null : rows.root ?? null }; } }; } },
  } as unknown as Parameters<typeof ensureLaunchpad>[0];
}

describe("Launchpad bootstrap", () => {
  beforeEach(() => vi.clearAllMocks());
  it("creates Launchpad for the configured active team", async () => {
    await ensureLaunchpad(envFor({ org: { id: "team" } }));
    expect(createSpaceRecord).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "team", spacetypeId: "launchpad", productSlug: "launchpad" }));
  });
  it("reuses a matching root without creating a duplicate", async () => {
    await ensureLaunchpad(envFor({ slug: { id: "p", tenant_id: "team", status: "active", parent_space_id: null, spacetype_id: "launchpad" } }));
    expect(createSpaceRecord).not.toHaveBeenCalled();
  });
  it("does not take over another tenant's product", async () => {
    await expect(ensureLaunchpad(envFor({ slug: { id: "p", tenant_id: "other", status: "active", parent_space_id: null, spacetype_id: "launchpad" } }))).rejects.toThrow("launchpad_identity_conflict");
  });
  it("stops if an older root requires migration", async () => {
    await expect(ensureLaunchpad(envFor({ org: { id: "team" }, root: { id: "old" } }))).rejects.toThrow("launchpad_existing_root_requires_migration");
    expect(createSpaceRecord).not.toHaveBeenCalled();
  });
  it("requires the provisioning queue outside development", async () => {
    const env = envFor({ org: { id: "team" } });
    env.ENVIRONMENT = "production";
    await expect(ensureLaunchpad(env)).rejects.toThrow("launchpad_provisioning_queue_unavailable");
  });
});
