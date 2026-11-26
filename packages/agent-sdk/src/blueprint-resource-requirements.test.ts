import { describe, expect, it } from "vitest";
import { instantiateBlueprint } from "./blueprint.js";
import { validateBlueprintResourceRequirements } from "./blueprint-resource-requirements.js";
import type { SpaceBlueprint } from "./types.js";

const legacy: SpaceBlueprint = { id: "bp_legacy", schemaVersion: "2.0", metadata: {}, templateCategory: "general",
  projects: [{ id: "accounts", name: "Accounts", kind: "DualPane", templateMode: "cowork_studio", viewports: {},
    systemPrompt: "Work carefully", initialTasks: [], starterFiles: [] }], requiredExtensions: [], requiredCredentials: [] };

const reqs = [
  { key: "inbox", resourceType: "email.inbox", required: true, capabilities: ["send", "receive"], preferredAccessMode: "managed",
    grants: [{ roleKey: "sales", actions: ["send", "read"] }] },
  { key: "voice", resourceType: "voice.number", required: false },
];

describe("blueprint resource requirements", () => {
  it("round-trips through instantiateBlueprint without adding authority", () => {
    const out = instantiateBlueprint({ ...legacy, resourceRequirements: reqs as never }, "space-target");
    expect(out.resourceRequirements?.[0]).toEqual({ ...reqs[0], capabilities: ["receive", "send"], grants: [{ roleKey: "sales", actions: ["read", "send"] }] });
    expect(out.resourceRequirements?.[1]).toEqual(reqs[1]);
    expect(out).not.toHaveProperty("grants");
  });

  it("enforces limits and shapes", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `r${i}`, resourceType: "email.inbox", required: false }));
    expect(() => validateBlueprintResourceRequirements(many(20))).not.toThrow();
    expect(() => validateBlueprintResourceRequirements(many(21))).toThrow("Too many resource requirements");
    expect(() => validateBlueprintResourceRequirements([])).toThrow("Invalid resource requirement list");
    expect(() => validateBlueprintResourceRequirements([many(1)[0], many(1)[0]])).toThrow("Duplicate resource requirement key");
    expect(() => validateBlueprintResourceRequirements([{ key: "Bad", resourceType: "email.inbox", required: true }])).toThrow("Invalid resource requirement key");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "Email Inbox", required: true }])).toThrow("Invalid resource requirement type");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: "yes" }])).toThrow("required flag");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: true, preferredAccessMode: "rent" }])).toThrow("access mode");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: true, capabilities: [] }])).toThrow("capabilities");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: true, grants: [{ roleKey: "x", actions: [] }] }])).toThrow("grant actions");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: true, grants: [{ roleKey: "x", actions: ["a"] }, { roleKey: "x", actions: ["b"] }] }])).toThrow("Duplicate resource requirement grant role");
  });

  it("rejects unknown fields", () => {
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: true, price: 1 }])).toThrow("Unknown resource requirement field");
    expect(() => validateBlueprintResourceRequirements([{ key: "a", resourceType: "email.inbox", required: true, grants: [{ roleKey: "x", actions: ["a"], extra: 1 }] }])).toThrow("Unknown resource requirement grant field");
  });

  it("legacy blueprints without requirements still instantiate", () => {
    expect(instantiateBlueprint(legacy, "space-target").resourceRequirements).toBeUndefined();
  });
});
