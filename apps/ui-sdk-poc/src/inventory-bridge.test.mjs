import assert from "node:assert/strict";
import test from "node:test";
import { readAuthorizedLowStock, resolveBusinessActionEndpoint } from "./inventory-bridge.mjs";
import { LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA } from "@naelao/agent-sdk";

const action = { id: "listLowStock", permission: "inventory.stock.read", effects: "read_only", idempotency: "none", approval: "none",
  roles: ["owner", "admin"], inputSchema: LIST_LOW_STOCK_INPUT_SCHEMA, outputSchema: LIST_LOW_STOCK_OUTPUT_SCHEMA };

test("resolves only a nested active Canvas app path, including Project-scoped paths", () => {
  assert.equal(resolveBusinessActionEndpoint("/spaces/space-a/apps/inventory/app", true), "/spaces/space-a/apps/inventory");
  assert.equal(resolveBusinessActionEndpoint("/spaces/space-a/projects/project-a/apps/inventory/app", true),
    "/spaces/space-a/projects/project-a/apps/inventory");
  assert.equal(resolveBusinessActionEndpoint("/spaces/space-a/apps/inventory/app", false), null);
  assert.equal(resolveBusinessActionEndpoint("/untrusted/apps/inventory/app", true), null);
});

test("reads bounded rows only through the declared owner/admin read action", async () => {
  const calls = [];
  const client = {
    async list() { calls.push(["list"]); return { version: 1, actions: [action] }; },
    async invoke(id, input) { calls.push(["invoke", id, input]); return { products: [{ productId: "sku-1", quantity: 6, version: 3 }], hasMore: false, nextCursor: "" }; },
  };
  assert.deepEqual(await readAuthorizedLowStock(client), {
    products: [{ productId: "sku-1", quantity: 6, version: 3 }], hasMore: false, nextCursor: "",
  });
  assert.deepEqual(calls, [["list"], ["invoke", "listLowStock", { maximumQuantity: 20, limit: 100 }]]);
});

test("does not invoke a write, altered schema, or malformed read result", async () => {
  let invoked = false;
  const client = { async list() { return { version: 1, actions: [{ ...action, effects: "transactional_write" }] }; },
    async invoke() { invoked = true; return {}; } };
  await assert.rejects(readAuthorizedLowStock(client), /host_low_stock_action_unavailable/);
  assert.equal(invoked, false);

  const malformedResult = { ...client, async list() { return { version: 1, actions: [action] }; },
    async invoke() { return { products: [{ productId: "sku-1", quantity: -1, version: 0 }], hasMore: false, nextCursor: "" }; } };
  await assert.rejects(readAuthorizedLowStock(malformedResult), /business_action_output_invalid/);
});
