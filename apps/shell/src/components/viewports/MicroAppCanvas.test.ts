import { describe, expect, it } from "vitest";
import { prepareCanvasBusinessActionReview, type CanvasBusinessActionReview } from "./MicroAppCanvas";
import type { BusinessActionDefinition } from "@/components/BusinessActionsPanel";

const action: BusinessActionDefinition = {
  id: "receiveStock", name: "Receive stock", description: "Record a delivery", permission: "inventory.receive",
  roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
  inputSchema: { type: "object", additionalProperties: false, required: ["productId", "quantity", "idempotencyKey"], properties: {
    productId: { type: "string", minLength: 1, maxLength: 64 }, quantity: { type: "integer", minimum: 1, maximum: 1000 },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 64 },
  } },
  outputSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
};

describe("MicroApp Canvas business action review", () => {
  it("binds the host review to an allowed installed Gadget and current signed action definition", () => {
    const input = { productId: "sku-1", quantity: 4, idempotencyKey: "request-1" };
    const review: CanvasBusinessActionReview = prepareCanvasBusinessActionReview("stock_app", "receiveStock", input, ["stock_app"], [action]);
    expect(review).toMatchObject({ appId: "stock_app", action: { id: "receiveStock", effects: "transactional_write" }, input });
  });

  it("rejects cross-installation and unknown-action requests before showing a confirmation", () => {
    const input = { productId: "sku-1", quantity: 4, idempotencyKey: "request-1" };
    expect(() => prepareCanvasBusinessActionReview("other_app", "receiveStock", input, ["stock_app"], [action]))
      .toThrow("business_action_app_not_allowed");
    expect(() => prepareCanvasBusinessActionReview("stock_app", "adjustEverything", input, ["stock_app"], [action]))
      .toThrow("business_action_not_available");
  });

  it("rejects malformed or oversized inputs and normalizes exactly what is reviewed", () => {
    expect(() => prepareCanvasBusinessActionReview("stock_app", "receiveStock", [], ["stock_app"], [action]))
      .toThrow("business_action_input_invalid");
    expect(() => prepareCanvasBusinessActionReview("stock_app", "receiveStock", { value: "x".repeat(64_001) }, ["stock_app"], [action]))
      .toThrow("business_action_input_too_large");
    const review = prepareCanvasBusinessActionReview("stock_app", "receiveStock", { quantity: 4, ignored: undefined }, ["stock_app"], [action]);
    expect(review.input).toEqual({ quantity: 4 });
  });
});
