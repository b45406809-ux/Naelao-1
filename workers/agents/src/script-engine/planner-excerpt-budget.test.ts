import { describe, expect, it } from "vitest";
import { createPlannerExcerptBudget } from "./planner-excerpt-budget.js";

describe("persistent planner excerpt budget", () => {
  it("caps calls and cumulative requested response bytes per host run", () => {
    const consume = createPlannerExcerptBudget();
    expect(consume(8 * 1024)).toBe(true);
    expect(consume(8 * 1024)).toBe(true);
    expect(consume(8 * 1024)).toBe(true);
    expect(consume(1)).toBe(false);
    expect(consume(0)).toBe(false);
    expect(consume(8 * 1024 + 1)).toBe(false);
  });

  it("allows at most four small reads", () => {
    const consume = createPlannerExcerptBudget();
    expect([consume(1024), consume(1024), consume(1024), consume(1024), consume(1)])
      .toEqual([true, true, true, true, false]);
  });
});
