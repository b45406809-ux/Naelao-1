import { describe, expect, it } from "vitest";
import { customAgentToConfig } from "./agent-templates.js";

describe("generic worker configuration", () => {
  it("accepts task-specific instructions, tools, skills, and connector scope", () => {
    const config = customAgentToConfig({
      name: "Project researcher",
      instructions: "Compare the supplied sources and cite each claim.",
      prebuilt_scripts: ["web-search"],
      skills: ["source-review"],
      connectors: ["drive"],
    });
    expect(config.agentsMd).toContain("Compare the supplied sources");
    expect(config.agentsMd).toContain("drive");
    expect(config.scripts.prebuilt).toContain("web-search");
    expect(config.skills.skills).toEqual([{ name: "source-review", tier: "space" }]);
  });

  it("always retains the safe runtime baseline without duplicate entries", () => {
    const config = customAgentToConfig({
      name: "Helper", instructions: "Help with the delegated task.",
      prebuilt_scripts: ["r2-workspace", "memory", "notifications"],
    });
    for (const capability of ["r2-workspace", "memory", "notifications"]) {
      expect(config.scripts.prebuilt.filter((entry) => entry === capability)).toHaveLength(1);
    }
  });
});
