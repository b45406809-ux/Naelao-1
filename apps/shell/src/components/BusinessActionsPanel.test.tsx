import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA } from "@naelao/agent-sdk";
import { BusinessActionForm, buildBusinessActionPayload, isUncertainBusinessActionFailure, parseBusinessActionList,
  type BusinessActionDefinition } from "./BusinessActionsPanel";
import { ApiError } from "@/lib/api";

const schema = {
  type: "object" as const,
  properties: {
    productId: { type: "string" as const, description: "Inventory row identifier", minLength: 1, maxLength: 128 },
    quantity: { type: "integer" as const, minimum: 1, maximum: 1_000_000 },
    expectedVersion: { type: "integer" as const, minimum: 1, maximum: 2_147_483_646 },
    reason: { type: "string" as const, minLength: 3, maxLength: 256 },
    idempotencyKey: { type: "string" as const, minLength: 16, maxLength: 128 },
  },
  required: ["productId", "quantity", "expectedVersion", "reason", "idempotencyKey"],
  additionalProperties: false as const,
};
const action: BusinessActionDefinition = {
  id: "receiveStock", name: "Receive stock", description: "Record a stock delivery.", permission: "inventory.stock.receive",
  roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
  inputSchema: schema, outputSchema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"], additionalProperties: false },
};
const listAction: BusinessActionDefinition = {
  id: "listLowStock", name: "List low stock", description: "Read a bounded page of low-stock products.", permission: "inventory.stock.read",
  roles: ["owner", "admin"], effects: "read_only", idempotency: "none", approval: "none",
  inputSchema: LIST_LOW_STOCK_INPUT_SCHEMA, outputSchema: LIST_LOW_STOCK_OUTPUT_SCHEMA,
};

describe("BusinessActionsPanel host UI contract", () => {
  it("accepts only bounded signed action descriptions and the declared scalar schema", () => {
    expect(parseBusinessActionList({ version: 1, actions: [action] })).toEqual([action]);
    expect(parseBusinessActionList({ version: 1, actions: [listAction] })).toEqual([listAction]);
    expect(() => parseBusinessActionList({ version: 2, actions: [action] })).toThrow("business_action_response_invalid");
    expect(() => parseBusinessActionList({ version: 1, actions: [{ ...action, inputSchema: { ...schema, additionalProperties: true } }] }))
      .toThrow("business_action_response_invalid");
    expect(() => parseBusinessActionList({ version: 1, actions: [{ ...listAction, outputSchema: { ...LIST_LOW_STOCK_OUTPUT_SCHEMA,
      properties: { ...LIST_LOW_STOCK_OUTPUT_SCHEMA.properties, products: { ...LIST_LOW_STOCK_OUTPUT_SCHEMA.properties.products, maxItems: 1000 } } } }] }))
      .toThrow("business_action_response_invalid");
    expect(() => parseBusinessActionList({ version: 1, actions: [{ ...listAction, idempotency: "required" }] }))
      .toThrow("business_action_response_invalid");
    expect(() => parseBusinessActionList({ version: 1, actions: [{ ...listAction, inputSchema: { ...LIST_LOW_STOCK_INPUT_SCHEMA,
      properties: { ...LIST_LOW_STOCK_INPUT_SCHEMA.properties, ids: { type: "array", items: { type: "string" }, maxItems: 10 } } } }] }))
      .toThrow("business_action_response_invalid");
  });

  it("converts reviewed form text into a strict typed payload and rejects incomplete values", () => {
    expect(buildBusinessActionPayload(schema, { productId: "sku-1", quantity: "4", expectedVersion: "2", reason: "supplier delivery",
      idempotencyKey: "7fd19f22-1e91-4c82-9f7a-7020e1ad74aa" })).toEqual({ productId: "sku-1", quantity: 4, expectedVersion: 2,
      reason: "supplier delivery", idempotencyKey: "7fd19f22-1e91-4c82-9f7a-7020e1ad74aa" });
    expect(() => buildBusinessActionPayload(schema, { productId: "sku-1", quantity: "1.5", expectedVersion: "2", reason: "ok", idempotencyKey: "valid-idempotency-key" }))
      .toThrow("quantity_invalid");
    expect(() => buildBusinessActionPayload(schema, { productId: "sku-1" })).toThrow("business_action_required_fields_missing");
  });

  it("shows the authorized action and requires a payload review before any confirmation is available", () => {
    const markup = renderToStaticMarkup(<BusinessActionForm spaceId="space-a" appId="inventory" action={action}
      session={{ sessionToken: "cookie", endUserId: "owner-a" }} />);
    expect(markup).toContain("Receive stock");
    expect(markup).toContain("Authority is checked again when the action runs.");
    expect(markup).toContain("Review Receive stock");
    expect(markup).not.toContain("Confirm and run");
    expect(markup).toContain("idempotencyKey");
  });

  it("renders read-only actions with bounded data, explicit no-write wording and user review", () => {
    expect(buildBusinessActionPayload(LIST_LOW_STOCK_INPUT_SCHEMA, { maximumQuantity: "6", limit: "25" }))
      .toEqual({ maximumQuantity: 6, limit: 25 });
    const markup = renderToStaticMarkup(<BusinessActionForm spaceId="space-a" appId="inventory" action={listAction}
      session={{ sessionToken: "cookie", endUserId: "owner-a" }} />);
    expect(markup).toContain("read only; no data changes");
    expect(markup).toContain("Review List low stock");
    expect(markup).not.toContain("Confirm and run");
  });

  it("distinguishes a definite rejection from a lost or uncertain response", () => {
    expect(isUncertainBusinessActionFailure(new ApiError("request failed", 409, "business_action_version_conflict"))).toBe(false);
    expect(isUncertainBusinessActionFailure(new ApiError("connection lost", 0, "network_error"))).toBe(true);
    expect(isUncertainBusinessActionFailure(new ApiError("worker failed", 503, "worker_unavailable"))).toBe(true);
    expect(isUncertainBusinessActionFailure(new ApiError("rate limited", 429, "rate_limited"))).toBe(false);
  });
});
