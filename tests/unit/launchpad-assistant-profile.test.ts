import { describe, it, expect } from "vitest";
import { DEFAULT_NAELAO_AGENT } from "../../workers/agents/src/script-engine/profiles.js";

describe("the default Naelao assistant profile", () => {
  it("is the one general-purpose assistant profile", () => {
    expect(DEFAULT_NAELAO_AGENT.agentId).toBe("naelao-agent");
    expect(DEFAULT_NAELAO_AGENT.config.agentsMd.toLowerCase()).toContain("space assistant");
    expect(DEFAULT_NAELAO_AGENT.config.systemPrompt.toLowerCase()).not.toContain("business-builder");
  });

  it("keeps product behavior out of hardcoded commerce and persona bundles", () => {
    const prebuilt = DEFAULT_NAELAO_AGENT.config.scripts.prebuilt;
    expect(prebuilt).not.toContain("commerce");
    expect(prebuilt).not.toContain("wallet");
    expect(prebuilt).not.toContain("business-diagnostics");
    expect(prebuilt).not.toContain("launchpad-support-v1");
  });
});
