import { describe, expect, it } from "vitest";
import { buildProposalDecision, parseDecisionResult, parseTemplateResourceProposals, proposalErrorText } from "./template-resource-proposals.js";

describe("template resource proposals (MS-47)", () => {
  it("parses proposals and drops malformed rows", () => {
    const rows = parseTemplateResourceProposals({ proposals: [
      { id: "trp_1", requirement_key: "inbox", resource_type: "email_inbox", required: true, status: "proposed", capabilities: ["email.send", 3],
        proposed_grants: [{ roleKey: "sales", actions: ["email.send"] }, { actions: [] }] },
      { id: "x" }, null] });
    expect(rows).toEqual([{ id: "trp_1", requirementKey: "inbox", resourceType: "email_inbox", required: true, status: "proposed", capabilities: ["email.send"],
      grants: [{ roleKey: "sales", actions: ["email.send"] }] }]);
    expect(parseTemplateResourceProposals(null)).toEqual([]);
  });

  it("builds the exact decision body the Spaces route accepts", () => {
    const p = { id: "trp_1" };
    expect(buildProposalDecision(p, { kind: "skip" }, { sales: "a" })).toEqual({ id: "trp_1", decision: "skip" });
    expect(buildProposalDecision(p, { kind: "reuse", resourceId: "res_1" })).toEqual({ id: "trp_1", decision: "approve", choice: { kind: "reuse", resource_id: "res_1" } });
    expect(buildProposalDecision(p, { kind: "create", offeringId: "off", region: "us", minMonthlyCredits: 100, initialCredits: 110 }, { sales: "agent-1, agent-2 agent-1", ops: "  " })).toEqual({
      id: "trp_1", decision: "approve",
      choice: { kind: "create", offering_id: "off", region: "us", acknowledged_min_monthly_credits: 100, acknowledged_initial_credits: 110 },
      grant_agent_ids: { sales: ["agent-1", "agent-2"] } });
  });

  it("parses the decision result and explains known errors", () => {
    expect(parseDecisionResult({ id: "p", status: "approved", grants: [{ role_key: "sales", agent_id: "a", status: "deferred", reason: "grant_unavailable" }, { role_key: "x", agent_id: "b", status: "weird" }] }))
      .toEqual({ status: "approved", grants: [{ roleKey: "sales", agentId: "a", status: "deferred", reason: "grant_unavailable" }] });
    expect(parseDecisionResult({})).toBeNull();
    expect(proposalErrorText("price_changed")).toMatch(/price changed/);
    expect(proposalErrorText("nope")).toBe("That did not work. Try again.");
  });
});
