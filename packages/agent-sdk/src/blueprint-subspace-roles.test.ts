import { describe, expect, it } from "vitest";
import { instantiateBlueprint } from "./blueprint.js";
import { validateBlueprintSubspaceRoles } from "./blueprint-subspace-roles.js";
import type { SpaceBlueprint } from "./types.js";

const legacy: SpaceBlueprint = { id: "bp_legacy", schemaVersion: "2.0", metadata: {}, templateCategory: "general",
  projects: [{ id: "accounts", name: "Accounts", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
    systemPrompt: "Work carefully", initialTasks: [], starterFiles: [] }], requiredExtensions: [], requiredCredentials: [] };

const roles = [
  { key: "sales", name: "Sales", description: "Sells things" },
  { key: "ops", name: "Operations" },
];
const proposals = [
  { source_role: "sales", target_role: "ops", allowed_kinds: ["question", "finding"], allow_reply: true },
  { source_role: "ops", target_role: "sales", allowed_kinds: ["completion"], allow_reply: false },
];

describe("blueprint subspace roles and route proposals", () => {
  it("round-trips valid declarations through instantiateBlueprint without adding authority", () => {
    const out = instantiateBlueprint({ ...legacy, subspaceRolesSchemaVersion: 1, subspaceRoles: roles,
      subspaceRouteProposals: proposals as never }, "space-target");
    expect(out.subspaceRoles).toEqual(roles);
    expect(out.subspaceRouteProposals?.[0]).toEqual({ ...proposals[0], allowed_kinds: ["finding", "question"] });
    expect(out).not.toHaveProperty("grants");
    expect(out).not.toHaveProperty("routes");
    expect(validateBlueprintSubspaceRoles({ roles }).proposals).toEqual([]);
  });

  it("enforces every limit", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `r${i}`, name: "R" }));
    expect(() => validateBlueprintSubspaceRoles({ roles: many(10) })).not.toThrow();
    expect(() => validateBlueprintSubspaceRoles({ roles: many(11) })).toThrow("Invalid subspace role list");
    expect(() => validateBlueprintSubspaceRoles({ roles: [] })).toThrow("Invalid subspace role list");
    expect(() => validateBlueprintSubspaceRoles({ roles: [{ key: "Bad", name: "x" }] })).toThrow("Invalid subspace role key");
    expect(() => validateBlueprintSubspaceRoles({ roles: [{ key: "a".repeat(49), name: "x" }] })).toThrow("Invalid subspace role key");
    expect(() => validateBlueprintSubspaceRoles({ roles: [{ key: "a", name: "x".repeat(81) }] })).toThrow("Invalid subspace role name");
    expect(() => validateBlueprintSubspaceRoles({ roles: [{ key: "a", name: "x", description: "d".repeat(401) }] }))
      .toThrow("Invalid subspace role description");
    expect(() => validateBlueprintSubspaceRoles({ roles: [{ key: "a", name: "x" }, { key: "a", name: "y" }] })).toThrow("Duplicate subspace role key");
    const twenty = many(10).flatMap((s, i) => many(10).filter((_, j) => j !== i).map((t) => ({ source_role: s.key, target_role: t.key, allowed_kinds: ["risk"], allow_reply: false })));
    expect(() => validateBlueprintSubspaceRoles({ roles: many(10), proposals: twenty.slice(0, 20) })).not.toThrow();
    expect(() => validateBlueprintSubspaceRoles({ roles: many(10), proposals: twenty.slice(0, 21) })).toThrow("Too many subspace route proposals");
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [proposals[0], proposals[0]] })).toThrow("Duplicate subspace route proposal");
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [{ ...proposals[0], allowed_kinds: [] }] })).toThrow("Invalid subspace route proposal kinds");
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [{ ...proposals[0], allowed_kinds: ["gossip"] }] })).toThrow("Invalid subspace route proposal kinds");
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [{ ...proposals[0], allow_reply: "yes" }] })).toThrow("allow_reply");
  });

  it("rejects unknown fields", () => {
    expect(() => validateBlueprintSubspaceRoles({ roles, extra: 1 })).toThrow("Unknown subspace roles field");
    expect(() => validateBlueprintSubspaceRoles({ roles: [{ key: "a", name: "x", spaceId: "real" }] })).toThrow("Unknown subspace role field");
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [{ ...proposals[0], status: "active" }] }))
      .toThrow("Unknown subspace route proposal field");
  });

  it("rejects a proposal naming an undeclared role", () => {
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [{ ...proposals[0], target_role: "ghost" }] }))
      .toThrow("undeclared role");
  });

  it("rejects a self-route", () => {
    expect(() => validateBlueprintSubspaceRoles({ roles, proposals: [{ ...proposals[0], target_role: "sales" }] }))
      .toThrow("cannot target its own role");
  });

  it("rejects proposals without roles and unsupported versions", () => {
    expect(() => instantiateBlueprint({ ...legacy, subspaceRolesSchemaVersion: 1, subspaceRouteProposals: proposals as never }, "s"))
      .toThrow("require declared subspace roles");
    expect(() => instantiateBlueprint({ ...legacy, subspaceRoles: roles }, "s")).toThrow("Unsupported subspace roles schema version");
  });

  it("still instantiates a legacy blueprint without these fields", () => {
    const out = instantiateBlueprint(legacy, "space-target");
    expect(out).not.toHaveProperty("subspaceRoles");
    expect(out).not.toHaveProperty("subspaceRouteProposals");
    expect(out).not.toHaveProperty("subspaceRolesSchemaVersion");
  });
});
