import { RECIPE_CATALOG, getRecipe } from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";

describe("prebuilt recipe catalog", () => {
  it("contains deployable automation components", () => {
    for (const recipe of Object.values(RECIPE_CATALOG)) {
      expect(getRecipe(recipe.id)).toBe(recipe);
      expect(recipe.webhooks.length).toBeGreaterThan(0);
      expect(recipe.queues.length).toBeGreaterThan(0);
      expect(recipe.workflows.length).toBeGreaterThan(0);
      expect(recipe.viewports.length).toBeGreaterThan(0);
    }
  });

  it("quarantines both customer-service recipes", () => {
    for (const id of [
      "dental_receptionist_desk",
      "ecommerce_returns_assistant",
    ] as const) {
      expect(RECIPE_CATALOG[id]).toMatchObject({
        projectKind: "customer_bot",
        runtimeContext: "CustomerBotContext",
      });
      expect(RECIPE_CATALOG[id].workflows[0]?.steps).toContain(
        "customer_bot_guard"
      );
    }
  });
});
