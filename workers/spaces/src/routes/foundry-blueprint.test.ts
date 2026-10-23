import { describe, expect, it } from "vitest";
import { FOUNDRY_SPACE_TEMPLATE } from "@naelao/agent-sdk";
import { evaluateBlueprintSecurity } from "@naelao/security";

describe("Foundry dogfood marketplace blueprint", () => {
  it("passes the same static security gate used for Space Template exports", () => {
    expect(evaluateBlueprintSecurity(FOUNDRY_SPACE_TEMPLATE).publishable).toBe(true);
  });

  it("keeps its private Studio project separate from every customer export", () => {
    const project = FOUNDRY_SPACE_TEMPLATE.projects[0]!;
    const exported = new Set((project.configuration?.included_paths as string[] | undefined) ?? []);
    expect(project.configuration).toMatchObject({ studio_only: true });
    expect(exported.has("eval/README.md")).toBe(false);
    expect(exported.has("product/brief.md")).toBe(false);
    expect(exported.has("product/export-manifest.json")).toBe(false);
  });
});
