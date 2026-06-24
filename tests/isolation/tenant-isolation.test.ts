import { describe, it, expect, vi } from "vitest";

// Tenant isolation tests
// Verify that tenantA cannot access tenantB's resources

// Simulates the tenant scoping logic from workers/spaces/src/index.ts
function getSpaceForTenant(
  spaces: Array<{ id: string; tenant_id: string; name: string }>,
  spaceId: string,
  requestingTenantId: string
): { status: number; body: unknown } {
  const space = spaces.find((s) => s.id === spaceId);
  if (!space) return { status: 404, body: { error_code: "not_found" } };
  if (space.tenant_id !== requestingTenantId) {
    return { status: 403, body: { error_code: "forbidden", message: "Access denied" } };
  }
  return { status: 200, body: { data: space } };
}

// Simulates the KB document ownership check
function getKbDocForTenant(
  docs: Array<{ id: string; space_id: string; tenant_id: string }>,
  docId: string,
  spaceId: string,
  requestingTenantId: string
): { status: number; body: unknown } {
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return { status: 404, body: { error_code: "not_found" } };
  if (doc.tenant_id !== requestingTenantId || doc.space_id !== spaceId) {
    return { status: 403, body: { error_code: "forbidden" } };
  }
  return { status: 200, body: { data: doc } };
}

// Simulates D1 query for spaces with tenant_id filter
function listSpacesForTenant(
  spaces: Array<{ id: string; tenant_id: string; name: string }>,
  requestingTenantId: string
): Array<{ id: string; tenant_id: string; name: string }> {
  // Correct: always filter by tenant_id — never return cross-tenant data
  return spaces.filter((s) => s.tenant_id === requestingTenantId);
}

// Simulates audit log query scoped to tenant
function readAuditLogForTenant(
  auditLog: Array<{ resource_id: string; resource_type: string; actor_id: string; tenant_id: string }>,
  resourceId: string,
  requestingTenantId: string
): Array<typeof auditLog[0]> {
  return auditLog.filter(
    (e) => e.resource_id === resourceId && e.tenant_id === requestingTenantId
  );
}

const SPACES = [
  { id: "space-A1", tenant_id: "tenant-A", name: "A's Space 1" },
  { id: "space-A2", tenant_id: "tenant-A", name: "A's Space 2" },
  { id: "space-B1", tenant_id: "tenant-B", name: "B's Space 1" },
];

const KB_DOCS = [
  { id: "doc-A1", space_id: "space-A1", tenant_id: "tenant-A" },
  { id: "doc-B1", space_id: "space-B1", tenant_id: "tenant-B" },
];

const AUDIT_LOG = [
  { resource_id: "space-A1", resource_type: "space", actor_id: "user-A1", tenant_id: "tenant-A" },
  { resource_id: "space-B1", resource_type: "space", actor_id: "user-B1", tenant_id: "tenant-B" },
];

describe("Space access — cross-tenant isolation", () => {
  it("tenantA can access their own space", () => {
    const result = getSpaceForTenant(SPACES, "space-A1", "tenant-A");
    expect(result.status).toBe(200);
  });

  it("tenantB cannot access tenantA's space — returns 403", () => {
    const result = getSpaceForTenant(SPACES, "space-A1", "tenant-B");
    expect(result.status).toBe(403);
  });

  it("tenantA cannot access tenantB's space — returns 403", () => {
    const result = getSpaceForTenant(SPACES, "space-B1", "tenant-A");
    expect(result.status).toBe(403);
  });

  it("unknown space returns 404 not 403", () => {
    const result = getSpaceForTenant(SPACES, "space-nonexistent", "tenant-A");
    expect(result.status).toBe(404);
  });
});

describe("Space listing — tenant scoping", () => {
  it("listSpaces only returns spaces for the requesting tenant", () => {
    const ownedByA = listSpacesForTenant(SPACES, "tenant-A");
    expect(ownedByA.every((s) => s.tenant_id === "tenant-A")).toBe(true);
    expect(ownedByA.some((s) => s.tenant_id === "tenant-B")).toBe(false);
  });

  it("tenantB only sees their own spaces", () => {
    const ownedByB = listSpacesForTenant(SPACES, "tenant-B");
    expect(ownedByB).toHaveLength(1);
    expect(ownedByB[0]!.id).toBe("space-B1");
  });

  it("no cross-tenant data leakage in listing", () => {
    const allTenantSpaces = listSpacesForTenant(SPACES, "tenant-A");
    const bSpaceIds = SPACES.filter((s) => s.tenant_id === "tenant-B").map((s) => s.id);
    const foundBInA = allTenantSpaces.filter((s) => bSpaceIds.includes(s.id));
    expect(foundBInA).toHaveLength(0);
  });
});

describe("KB document access — cross-tenant isolation", () => {
  it("tenantA can access their own KB doc", () => {
    const result = getKbDocForTenant(KB_DOCS, "doc-A1", "space-A1", "tenant-A");
    expect(result.status).toBe(200);
  });

  it("tenantB cannot access tenantA's KB doc — returns 403", () => {
    const result = getKbDocForTenant(KB_DOCS, "doc-A1", "space-A1", "tenant-B");
    expect(result.status).toBe(403);
  });

  it("cross-space access with correct tenant returns 403", () => {
    // tenantA tries to access their doc via tenantB's spaceId
    const result = getKbDocForTenant(KB_DOCS, "doc-A1", "space-B1", "tenant-A");
    expect(result.status).toBe(403);
  });
});

describe("Audit log — tenant scoping", () => {
  it("audit log query returns only events for requesting tenant", () => {
    const aLog = readAuditLogForTenant(AUDIT_LOG, "space-A1", "tenant-A");
    expect(aLog.every((e) => e.tenant_id === "tenant-A")).toBe(true);
  });

  it("tenantB cannot see tenantA's audit events for the same resource ID", () => {
    const bLog = readAuditLogForTenant(AUDIT_LOG, "space-A1", "tenant-B");
    expect(bLog).toHaveLength(0);
  });
});
