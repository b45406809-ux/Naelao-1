import { describe, expect, it } from "vitest";
import { PROJECT_TEMPLATES } from "./project-templates.js";

describe("canonical project templates", () => {
  it("define a primary Canvases viewport, DAG, agent soul, and starter deliverable", () => {
    expect(Object.keys(PROJECT_TEMPLATES)).toHaveLength(4);
    for (const template of Object.values(PROJECT_TEMPLATES)) {
      expect(template.id).toMatch(/^tpl_proj_/);
      expect(template.viewport).toMatchObject({ canvasPrimary: true, tab: "canvases" });
      expect(template.agent.systemPrompt.length).toBeGreaterThan(40);
      expect(template.agent.soul.length).toBeGreaterThan(20);
      expect(template.tasks.length).toBeGreaterThanOrEqual(4);
      expect(template.starterFiles.length).toBeGreaterThan(0);
      const taskIds = new Set(template.tasks.map(task => task.id));
      for (const task of template.tasks) for (const dependency of task.dependencies ?? []) expect(taskIds.has(dependency)).toBe(true);
    }
  });
});
