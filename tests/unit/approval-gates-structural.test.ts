import { describe, it, expect } from "vitest";
import { writeAgentConfig, loadAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { launchpadAgentToProfile } from "../../workers/agents/src/script-engine/profiles.js";
import { parseRequiresApprovalFor, isGated } from "../../workers/agents/src/script-engine/loop.js";
import { LAUNCHPAD_CORE_AGENTS } from "../../workers/agents/src/launchpad/spacetype.js";

// Spec §11 / appendix A1.16.1: `requires_approval_for` is supposed to gate specific actions
// behind owner approval for Autopilot-tier Launchpad project agents. Previously
// launchpadAgentToProfile (profiles.ts) only wrote the gates as PROSE under
// "# Approval Gates (HITL)" in agents.md, while loop.ts's parseRequiresApprovalFor only matched
// a `## requires_approval_for` markdown heading no profile ever wrote — so
// parseRequiresApprovalFor(agentsMd) always returned an empty set and NaelaoAgentDO.
// handleScriptRun ran every project agent with nothing gated at all. Fixed by carrying the
// gates structurally on AgentConfig.requiresApprovalFor (persisted in scripts.json, not
// agents.md), with parseRequiresApprovalFor kept only as a fallback for pre-existing configs.

// ── Minimal in-memory R2 bucket (mirrors tests/unit/script-engine.test.ts's makeR2) ──────────
function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      const text = typeof value === "string" ? value
        : value instanceof Uint8Array ? new TextDecoder().decode(value)
          : value instanceof ArrayBuffer ? new TextDecoder().decode(value)
            : ArrayBuffer.isView(value) ? new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
              : String(value);
      store.set(key, text);
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      const bytes = new TextEncoder().encode(text);
      return { key, size: bytes.byteLength, etag: `e${text.length}`, uploaded: new Date(), async arrayBuffer() { return bytes.slice().buffer; }, async text() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const text = store.get(key);
      return text === undefined ? null : { key, size: new TextEncoder().encode(text).byteLength, etag: `e${text.length}` } as R2Object;
    },
  };
  return bucket as unknown as R2Bucket;
}

const FULFILLMENT_DEF = LAUNCHPAD_CORE_AGENTS.find((a) => a.id === "launchpad-fulfillment-v1")!;

describe("structural requires_approval_for (F: Autopilot approval gates were never enforced)", () => {
  it("launchpadAgentToProfile carries requires_approval_for onto AgentConfig.requiresApprovalFor structurally", () => {
    const profile = launchpadAgentToProfile(FULFILLMENT_DEF);
    expect(profile.config.requiresApprovalFor).toEqual(["customer_email_send", "refund_issue"]);
  });

  it("agents.md still carries the human-readable prose, but it is NOT structurally parseable — proves the old code path was broken", () => {
    const profile = launchpadAgentToProfile(FULFILLMENT_DEF);
    expect(profile.config.agentsMd).toContain("Approval Gates (HITL)");
    expect(profile.config.agentsMd).toContain("customer_email_send");
    // The legacy parser only matches a `## requires_approval_for` heading, which the prose
    // section is not — this is exactly why the bug existed.
    expect([...parseRequiresApprovalFor(profile.config.agentsMd)]).toEqual([]);
  });

  it("round-trips through writeAgentConfig/loadAgentConfig (R2) without losing the structural field", async () => {
    const bucket = makeR2();
    const profile = launchpadAgentToProfile(FULFILLMENT_DEF);
    await writeAgentConfig(bucket, "space-1", profile.agentId, profile.config);
    const loaded = await loadAgentConfig(bucket, "space-1", profile.agentId);
    expect(loaded?.requiresApprovalFor).toEqual(["customer_email_send", "refund_issue"]);
  });

  it("a provisioned launchpad-fulfillment-v1 profile gates customer_email_send and refund_issue under gate_listed, but not an unlisted action", async () => {
    const bucket = makeR2();
    const profile = launchpadAgentToProfile(FULFILLMENT_DEF);
    await writeAgentConfig(bucket, "space-1", profile.agentId, profile.config);
    const loaded = await loadAgentConfig(bucket, "space-1", profile.agentId);

    // Mirrors NaelaoAgentDO.handleScriptRun's precedence: structural field first.
    const requiresApprovalFor = loaded?.requiresApprovalFor ?? [...parseRequiresApprovalFor(loaded?.agentsMd ?? "")];
    const gated = new Set(requiresApprovalFor);

    expect(isGated("customer_email_send", gated, "gate_listed")).toBe(true);
    expect(isGated("refund_issue", gated, "gate_listed")).toBe(true);
    expect(isGated("web_search", gated, "gate_listed")).toBe(false);
  });

  it("older configs with no persisted requiresApprovalFor fall back to parsing agents.md (never crash, never silently un-gate a newly-authored heading)", async () => {
    const bucket = makeR2();
    await writeAgentConfig(bucket, "space-1", "legacy-agent", {
      agentsMd: "## requires_approval_for\n- delete_file\n",
      systemPrompt: "You are a legacy agent.",
      scripts: { prebuilt: [], agent_scripts: "auto", startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });
    const loaded = await loadAgentConfig(bucket, "space-1", "legacy-agent");
    expect(loaded?.requiresApprovalFor).toBeUndefined();
    const fallback = loaded?.requiresApprovalFor ?? [...parseRequiresApprovalFor(loaded?.agentsMd ?? "")];
    expect(fallback).toEqual(["delete_file"]);
  });
});
