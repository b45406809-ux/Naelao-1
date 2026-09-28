import { describe, expect, it } from "vitest";
import { compileNoCodeSubagent, type NoCodeSubagentManifest } from "./no-code-subagent.js";

const manifest: NoCodeSubagentManifest = { id: "subagent_research", name: "Research", description: "Research approved sources", creatorRoleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"], triggers: [{ type: "manual" }] };
describe("no-code subagent capability clamp", () => {
  it("compiles only capabilities held by the creator", () => expect(compileNoCodeSubagent(manifest, { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["public"] })).toMatchObject(manifest));
  it.each(["payout", "member_invite"])("rejects admin-only tool %s for a member", tool => expect(() => compileNoCodeSubagent({ ...manifest, allowedTools: [tool] }, { roleRank: 1, allowedTools: [tool], knowledgeBaseIds: ["public"] })).toThrow(`capability_ceiling_exceeded:${tool}`));
  it("rejects a restricted knowledge base", () => expect(() => compileNoCodeSubagent({ ...manifest, knowledgeBaseIds: ["board"] }, { roleRank: 1, allowedTools: ["search"], knowledgeBaseIds: ["board"], knowledgeBaseRoleRanks: { board: 3 } })).toThrow("capability_ceiling_exceeded:board"));
});
