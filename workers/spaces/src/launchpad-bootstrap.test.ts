import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./create-space.js", () => ({
  createSpaceRecord: vi.fn(),
  SpaceCreationError: class SpaceCreationError extends Error { constructor(public status: number) { super(); } },
}));
import { createSpaceRecord } from "./create-space.js";
import { ensureLaunchpad } from "./launchpad-bootstrap.js";

function envFor(rows: Record<string, unknown> = {}) {
  let inserted = false;
  return {
    ENVIRONMENT: "development",
    NAELAO_DASHBOARD_TENANT_ID: "team",
    PLATFORM_DB: { prepare(sql: string) { return { bind() { return { first: async () => sql.includes("FROM products") ? rows.product ?? (inserted ? { id: "new", tenant_id: "team", status: "active", spacetype_id: "launchpad" } : null) : sql.includes("product_link_migration_issues") ? rows.legacyIssue ?? null : sql.includes("FROM orgs") ? rows.org ?? null : null, run: async () => { inserted = true; return { meta: { changes: 1 } }; } }; } }; } },
  } as unknown as Parameters<typeof ensureLaunchpad>[0];
}

describe("Launchpad bootstrap", () => {
  beforeEach(() => vi.clearAllMocks());
  it("creates Launchpad in the Product registry for the configured active team", async () => {
    await ensureLaunchpad(envFor({ org: { id: "team" } }));
    expect(createSpaceRecord).not.toHaveBeenCalled();
  });
  it("reuses a registered Product without reading a backing Space", async () => {
    await ensureLaunchpad(envFor({ product: { id: "p", tenant_id: "team", status: "active", spacetype_id: "launchpad" } }));
    expect(createSpaceRecord).not.toHaveBeenCalled();
  });
  it("does not take over another tenant's Product", async () => {
    await expect(ensureLaunchpad(envFor({ product: { id: "p", tenant_id: "other", status: "active", spacetype_id: "launchpad" } }))).rejects.toThrow("launchpad_identity_conflict");
    expect(createSpaceRecord).not.toHaveBeenCalled();
  });
  it("fails closed when the upgrade audit found an unresolved legacy Launchpad identity", async () => {
    await expect(ensureLaunchpad(envFor({ legacyIssue: { space_id: "legacy-root" } }))).rejects.toThrow("launchpad_legacy_product_requires_migration");
    expect(createSpaceRecord).not.toHaveBeenCalled();
  });
});
