import { describe, expect, it } from "vitest";
import { documentClauseNodeId } from "./document-node";
import { createProjectHydrationSeed, getProjectTemplate, projectTemplateAsBlueprintProject, validateDemoFixtureRows, validateProjectHydrationSeed } from "./project-templates";

describe("project template hydration", () => {
  it("exports a versioned welcome seed with actions limited to seeded files", () => {
    const template = getProjectTemplate("tpl_proj_contract_redliner")!;
    const blueprint = projectTemplateAsBlueprintProject(template, "Acme NDA");
    const seed = blueprint.configuration?.hydrationSeed as { version: number; title: string; actions: Array<Record<string, string>> } | undefined;
    expect(seed).toMatchObject({ version: 1, title: "Welcome to Acme NDA" });
    expect(seed?.actions).toContainEqual({ id: "connect-whatsapp", label: "Connect WhatsApp", kind: "open_channel_settings", channel: "whatsapp" });
    expect(seed?.actions).toContainEqual({ id: "review-starter", label: "Run sample audit", kind: "review_file", path: "demo/nda-audit-fixtures.json" });
    expect(validateProjectHydrationSeed(seed, new Set(blueprint.starterFiles.map(file => file.path)))).toEqual(createProjectHydrationSeed(template, "Acme NDA"));
    expect(blueprint.configuration?.demoFixtures).toHaveLength(3);
    expect(blueprint.starterFiles.some(file => file.path === "demo/nda-audit-fixtures.json")).toBe(true);
  });

  it("rejects malformed actions and paths outside the installed starter files", () => {
    expect(validateProjectHydrationSeed({ version: 1, title: "Start", description: "Demo", actions: [{ id: "open", label: "Read", kind: "open_file", path: "../../secrets" }] }, new Set(["README.md"]))).toBeUndefined();
    expect(validateProjectHydrationSeed({ version: 2, title: "Start", description: "Demo", actions: [] }, new Set())).toBeUndefined();
    expect(validateProjectHydrationSeed({ version: 1, title: "Start", description: "Demo", actions: [{ id: "link", label: "Open", kind: "open_url", url: "https://attacker.example" }] }, new Set())).toBeUndefined();
  });

  it("accepts bounded primitive fixture rows and rejects duplicate or executable-shaped data", () => {
    expect(validateDemoFixtureRows([{ id: "case-1", kind: "nda_clause", data: { synthetic: true, expected: "pass" } }])).toEqual([
      { id: "case-1", kind: "nda_clause", data: { synthetic: true, expected: "pass" } },
    ]);
    expect(validateDemoFixtureRows([
      { id: "same", kind: "case", data: {} },
      { id: "same", kind: "case", data: {} },
    ])).toBeUndefined();
    expect(validateDemoFixtureRows([{ id: "case-1", kind: "case", data: { nested: { run: "code" } } }])).toBeUndefined();
  });
});

describe("semantic document node identity", () => {
  it("is stable for a path and clause index and separates projects through the server scope", () => {
    expect(documentClauseNodeId("agreement.md", 7)).toBe(documentClauseNodeId("agreement.md", 7));
    expect(documentClauseNodeId("agreement.md", 7)).not.toBe(documentClauseNodeId("agreement.md", 8));
    expect(documentClauseNodeId("other.md", 7)).not.toBe(documentClauseNodeId("agreement.md", 7));
  });
});
