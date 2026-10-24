import { describe, it, expect } from "vitest";
import {
  PERSONAL_ASSISTANT_SPACE_TEMPLATE,
  SOFTWARE_DEVELOPMENT_SPACE_TEMPLATE,
} from "./reference-spaces.js";
import { FOUNDRY_SPACE_TEMPLATE } from "./foundry-space.js";
describe("portable reference Spaces", () => {
  it.each([
    PERSONAL_ASSISTANT_SPACE_TEMPLATE,
    SOFTWARE_DEVELOPMENT_SPACE_TEMPLATE,
    FOUNDRY_SPACE_TEMPLATE,
  ])("describes $id without credentials or kernel registration", (template) => {
    expect(template.schemaVersion).toBe("2.0");
    expect(template.requiredCredentials).toEqual([]);
    expect(template.projects.length).toBeGreaterThan(0);
    expect(new Set(template.projects.map((p) => p.id)).size).toBe(
      template.projects.length
    );
    for (const p of template.projects) {
      expect([
        "DualPane",
        "CanvasFirst",
        "HeadlessPipeline",
        "TerminalFirst",
      ]).toContain(p.kind);
      expect(p.configuration?.presentation_profile).toBeDefined();
      expect(p.systemPrompt.length).toBeGreaterThan(80);
    }
    expect(JSON.stringify(template)).not.toMatch(/sk_live_|ghp_|whsec_/);
  });
  it("does not grant connections or phone numbers by including a reference template", () => {
    for (const t of [
      PERSONAL_ASSISTANT_SPACE_TEMPLATE,
      SOFTWARE_DEVELOPMENT_SPACE_TEMPLATE,
    ])
      expect(t.projects[0]?.capabilities).toEqual([]);
  });
});


import { instantiateBlueprint } from "../blueprint.js";
it.each([PERSONAL_ASSISTANT_SPACE_TEMPLATE,SOFTWARE_DEVELOPMENT_SPACE_TEMPLATE,FOUNDRY_SPACE_TEMPLATE])("instantiates $id for independent private Spaces",template=>{
 const one=instantiateBlueprint(template,"space-one"),two=instantiateBlueprint(template,"space-two");
 expect(one.metadata.targetSpaceId).toBe("space-one");expect(two.metadata.targetSpaceId).toBe("space-two");
 one.projects[0]!.systemPrompt="local override";
 expect(two.projects[0]!.systemPrompt).not.toBe("local override");expect(template.projects[0]!.systemPrompt).not.toBe("local override");
});
