import { describe, it, expect } from "vitest";
import { resolveTenancy } from "../../workers/spaces/src/tenancy.js";
import { WORKSPACE_MANIFEST } from "../../workers/spaces/src/workspace-manifest.js";

// Tenancy is the first-class data-topology dimension (spec G-Y15). It must resolve
// deterministically from a productConfig — including legacy configs that only set
// membershipModel — so the provisioner always seeds the correct DO topology.

const base = {
  membershipModel: "team" as const,
  assistantMode: "per-user" as const,
  allowPublicSignup: false,
};

describe("resolveTenancy (G-Y15)", () => {
  it("prefers the explicit tenancy field", () => {
    expect(resolveTenancy({ ...base, tenancy: "saas" })).toBe("saas");
    expect(resolveTenancy({ ...base, tenancy: "single" })).toBe("single");
    expect(resolveTenancy({ ...base, tenancy: "team" })).toBe("team");
  });

  it("infers saas from a tenant/hybrid membership model when tenancy is absent", () => {
    expect(resolveTenancy({ ...base, membershipModel: "tenant" })).toBe("saas");
    expect(resolveTenancy({ ...base, membershipModel: "hybrid" })).toBe("saas");
  });

  it("defaults to team for a plain team product and for null", () => {
    expect(resolveTenancy(base)).toBe("team");
    expect(resolveTenancy(null)).toBe("team");
    expect(resolveTenancy(undefined)).toBe("team");
  });

  it("an explicit tenancy overrides the membershipModel inference", () => {
    // A builder can run a shared team space that still lets members spin up their own
    // businesses (hybrid join semantics) without flipping the whole product to saas.
    expect(resolveTenancy({ ...base, membershipModel: "hybrid", tenancy: "team" })).toBe("team");
  });

  it("rejects malformed runtime tenancy values and still infers tenant isolation", () => {
    expect(resolveTenancy({ ...base, tenancy: "unexpected", membershipModel: "tenant" } as never)).toBe("saas");
    expect(resolveTenancy({ ...base, tenancy: "unexpected", membershipModel: "unexpected" } as never)).toBe("team");
    expect(resolveTenancy({ ...base, tenancy: null } as never)).toBe("team");
  });
});

describe("generic Workspace tenancy", () => {
  it("ships as a team Space with opt-in child Spaces", () => {
    expect(WORKSPACE_MANIFEST.productConfig?.tenancy).toBe("team");
    expect(WORKSPACE_MANIFEST.productConfig?.agencyShell).toBe(false);
    expect(resolveTenancy(WORKSPACE_MANIFEST.productConfig)).toBe("team");
  });
});
