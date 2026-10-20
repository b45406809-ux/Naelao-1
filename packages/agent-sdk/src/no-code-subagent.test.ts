import { describe, expect, it } from "vitest";
import { compileNoCodeSubagent, type NoCodeSubagentManifest } from "./no-code-subagent.js";

const manifest: NoCodeSubagentManifest = { id: "subagent_research", name: "Research", description: "Research approved sources", creatorRoleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"], triggers: [{ type: "manual" }] };
describe("no-code subagent capability clamp", () => {
  it("compiles only capabilities held by the creator", () => expect(compileNoCodeSubagent(manifest, { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"] })).toMatchObject(manifest));
  it.each(["payout", "member_invite"])("rejects admin-only tool %s for a member", tool => expect(() => compileNoCodeSubagent({ ...manifest, allowedTools: [tool] }, { roleRank: 1, allowedTools: [tool], knowledgeBaseIds: ["public"] })).toThrow(`capability_ceiling_exceeded:${tool}`));
  it("rejects a restricted knowledge base", () => expect(() => compileNoCodeSubagent({ ...manifest, knowledgeBaseIds: ["board"] }, { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["board"], knowledgeBaseRoleRanks: { board: 3 } })).toThrow("capability_ceiling_exceeded:board"));
  it("deep-clones and freezes trigger configuration and drops unrecognized manifest fields", () => {
    const nested = { filters: [{ field: "status", values: ["open"] }] };
    const compiled = compileNoCodeSubagent({ ...manifest, triggers: [{ type: "manual", configuration: nested }], unexpected: { debug: true } } as NoCodeSubagentManifest, { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"] }) as NoCodeSubagentManifest & { unexpected?: unknown };
    nested.filters[0]!.values.push("closed");
    expect(compiled.triggers[0]?.configuration).toEqual({ filters: [{ field: "status", values: ["open"] }] });
    expect("unexpected" in compiled).toBe(false);
    const configuration = compiled.triggers[0]?.configuration as { filters: Array<{ values: string[] }> };
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.filters)).toBe(true);
    expect(Object.isFrozen(configuration.filters[0])).toBe(true);
    expect(Object.isFrozen(configuration.filters[0]?.values)).toBe(true);
  });

  it("rejects cyclic, oversized, sparse, and non-JSON trigger input", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const claims = { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"] };
    expect(() => compileNoCodeSubagent({ ...manifest, triggers: [{ type: "manual", configuration: cycle }] }, claims)).toThrow("invalid_subagent_trigger:configuration_cycle");
    expect(() => compileNoCodeSubagent({ ...manifest, triggers: [{ type: "manual", configuration: { text: "x".repeat(65_537) } }] }, claims)).toThrow("invalid_subagent_trigger:configuration_limit");
    const sparse = new Array(1) as string[];
    expect(() => compileNoCodeSubagent({ ...manifest, allowedTools: sparse }, claims)).toThrow("invalid_subagent_manifest");
    expect(() => compileNoCodeSubagent({ ...manifest, triggers: [{ type: "manual", configuration: { value: undefined } }] }, claims)).toThrow("invalid_subagent_trigger:configuration_value");
  });

  it("rejects malformed creator capability lists and rank ceilings", () => {
    expect(() => compileNoCodeSubagent(manifest, { roleRank: 1, allowedTools: ["bad tool"], knowledgeBaseIds: ["public"] })).toThrow("invalid_subagent_manifest");
    expect(() => compileNoCodeSubagent(manifest, { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"], toolRoleRanks: { search: 1.5 } })).toThrow("invalid_tool_role_rank:search");
  });
});
