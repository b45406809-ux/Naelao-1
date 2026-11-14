import { describe, expect, it } from "vitest";
import { safeTemplateProjectIds } from "./template-installation-review.js";

describe("template installation retained-resource links", () => {
  it("keeps only unique bounded opaque project IDs for generated-project links", () => {
    expect(safeTemplateProjectIds(["project-a", "550e8400-e29b-41d4-a716-446655440000", "project-a", "../other", "a/b", null]))
      .toEqual(["project-a", "550e8400-e29b-41d4-a716-446655440000"]);
    expect(safeTemplateProjectIds({ project: "project-a" })).toEqual([]);
    expect(safeTemplateProjectIds(["a".repeat(129)])).toEqual([]);
  });
});
