import { describe, expect, it } from "vitest";
import { agentTemplateSummaries, agentTemplateToConfig, findAgentTemplate } from "./agent-templates.js";

describe("curated worker templates", () => {
  it("publishes the default local access worker in the directory", () => {
    const summary = agentTemplateSummaries().find((template) => template.id === "local-access");
    expect(summary).toMatchObject({
      id: "local-access",
      name: "Local Access Worker",
      prebuilt_scripts: expect.arrayContaining(["local-machine", "code-exec"]),
    });
  });

  it("gives the local access worker the tunnel tool and universal durable baseline", () => {
    const template = findAgentTemplate("local-access");
    expect(template).toBeDefined();
    const config = agentTemplateToConfig(template!);
    expect(config.scripts.prebuilt).toEqual(expect.arrayContaining([
      "local-machine",
      "code-exec",
      "r2-workspace",
      "memory",
      "notifications",
    ]));
    expect(config.agentsMd).toContain("active grants");
  });
});
