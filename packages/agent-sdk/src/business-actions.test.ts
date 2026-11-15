import { describe, expect, it, vi } from "vitest";
import { createBusinessActionClient, RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA, ADJUST_STOCK_INPUT_SCHEMA, ADJUST_STOCK_OUTPUT_SCHEMA,
  LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA,
  validateExtensionBusinessAction, validateReceiveStockInput, validateReceiveStockOutput, validateAdjustStockInput, validateAdjustStockOutput,
  validateListLowStockInput, validateListLowStockOutput, parseExtensionPrimitive, validateExtensionManifest } from "./extensions.js";

const receiveStock = {
  schemaVersion: 1, id: "receiveStock", name: "Receive stock", description: "Record a stock delivery against the current inventory version.",
  operation: "inventory.receiveStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
  table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version",
  permission: "inventory.stock.receive", roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
  inputSchema: RECEIVE_STOCK_INPUT_SCHEMA, outputSchema: RECEIVE_STOCK_OUTPUT_SCHEMA,
} as const;
const adjustStock = {
  schemaVersion: 1, id: "adjustStock", name: "Adjust stock", description: "Set the counted on-hand quantity against the current inventory version.",
  operation: "inventory.adjustStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
  table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version",
  permission: "inventory.stock.adjust", roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
  inputSchema: ADJUST_STOCK_INPUT_SCHEMA, outputSchema: ADJUST_STOCK_OUTPUT_SCHEMA,
} as const;
const listLowStock = {
  schemaVersion: 1, id: "listLowStock", name: "List low stock", description: "Read a bounded page of products at or below the selected stock threshold.",
  operation: "inventory.listLowStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
  table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version",
  permission: "inventory.stock.read", roles: ["owner", "admin"], effects: "read_only", idempotency: "none", approval: "none",
  inputSchema: LIST_LOW_STOCK_INPUT_SCHEMA, outputSchema: LIST_LOW_STOCK_OUTPUT_SCHEMA,
} as const;

describe("typed microapp business actions", () => {
  it("accepts only the declared versioned inventory action and validates inputs and outputs", () => {
    expect(validateExtensionBusinessAction(receiveStock)).toMatchObject({ id: "receiveStock", operation: "inventory.receiveStock.v1", effects: "transactional_write" });
    expect(validateReceiveStockInput({ productId: "sku-1", quantity: 3, expectedVersion: 1, reason: "PO-2041", idempotencyKey: "receipt-2026-0001" }))
      .toMatchObject({ productId: "sku-1", quantity: 3, expectedVersion: 1 });
    expect(validateReceiveStockOutput({ productId: "sku-1", quantity: 7, version: 2, replayed: false })).toEqual({ productId: "sku-1", quantity: 7, version: 2, replayed: false });
    expect(() => validateReceiveStockInput({ productId: "sku-1", quantity: -3, expectedVersion: 1, reason: "PO", idempotencyKey: "receipt-2026-0001" }))
      .toThrow("business_action_input_invalid");
    expect(() => validateExtensionBusinessAction({ ...receiveStock, operation: "inventory.rawSql.v1" })).toThrow("invalid_business_action");
    expect(validateExtensionBusinessAction(adjustStock)).toMatchObject({ id: "adjustStock", operation: "inventory.adjustStock.v1" });
    expect(validateAdjustStockInput({ productId: "sku-1", newQuantity: 5, expectedVersion: 2, reason: "cycle count", idempotencyKey: "adjust-2026-0001" }))
      .toMatchObject({ productId: "sku-1", newQuantity: 5, expectedVersion: 2 });
    expect(validateAdjustStockOutput({ productId: "sku-1", previousQuantity: 7, quantity: 5, version: 3, replayed: false }))
      .toEqual({ productId: "sku-1", previousQuantity: 7, quantity: 5, version: 3, replayed: false });
    expect(() => validateAdjustStockInput({ productId: "sku-1", newQuantity: -1, expectedVersion: 2, reason: "count", idempotencyKey: "adjust-2026-0001" }))
      .toThrow("business_action_input_invalid");
    expect(validateExtensionBusinessAction(listLowStock)).toMatchObject({ id: "listLowStock", operation: "inventory.listLowStock.v1", effects: "read_only" });
    expect(validateListLowStockInput({ maximumQuantity: 10, limit: 25 })).toEqual({ maximumQuantity: 10, limit: 25, afterProductId: "" });
    expect(validateListLowStockOutput({ products: [{ productId: "sku-1", quantity: 4, version: 2 }], hasMore: false, nextCursor: "" }))
      .toEqual({ products: [{ productId: "sku-1", quantity: 4, version: 2 }], hasMore: false, nextCursor: "" });
    expect(() => validateListLowStockInput({ maximumQuantity: -1, limit: 25 })).toThrow("business_action_input_invalid");
    expect(() => validateListLowStockOutput({ products: [{ productId: "sku-1", quantity: -1, version: 2 }], hasMore: false, nextCursor: "" }))
      .toThrow("business_action_output_invalid");
    expect(() => validateListLowStockOutput({ products: [{ productId: "sku-2", quantity: 3, version: 1 },
      { productId: "sku-1", quantity: 4, version: 1 }], hasMore: false, nextCursor: "" }))
      .toThrow("business_action_output_invalid");
  });

  it("requires a capability and scoped write permission in the signed gadget primitive", () => {
    const gadget = { schemaVersion: "1.0", kind: "gadget", id: "inventory", version: "1.0.0", scope: "PROJECT_BOUND",
      permissions: [{ scope: "PROJECT_BOUND", actions: ["write"], resource: "inventory.stock.receive" }],
      capabilityRequirements: ["extension.gadget.business_action"], lifecycle: {},
      schemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
      businessActions: [receiveStock] };
    expect(parseExtensionPrimitive(gadget)).toMatchObject({ kind: "gadget", businessActions: [{ id: "receiveStock" }] });
    expect(() => parseExtensionPrimitive({ ...gadget, permissions: [] })).toThrow("business_action_permission_required");
    expect(() => parseExtensionPrimitive({ ...gadget, capabilityRequirements: [] })).toThrow("business_action_capability_required");
  });

  it("requires the named permission in a legacy top-level gadget manifest", () => {
    const manifest = { id: "ext_inventory_shop", releaseVersion: "1.0.0", type: "extension", declaredPermissions: [],
      capabilityRequirements: ["extension.gadget.business_action"], gadgets: [{ id: "inventory", name: "Inventory",
        viewportComponent: "./inventory.js", scope: "PROJECT_BOUND", gadgetTier: 2,
        defaultSchemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
        businessActions: [receiveStock] }], daemons: [], commands: [] };
    expect(() => validateExtensionManifest(manifest)).toThrow("business_action_permission_required");
    expect(validateExtensionManifest({ ...manifest, declaredPermissions: [receiveStock.permission] })).toMatchObject({
      declaredPermissions: [receiveStock.permission],
    });
  });

  it("requires a scoped read permission for the read-only action and refuses write-only grants", () => {
    const gadget = { schemaVersion: "1.0", kind: "gadget", id: "inventory", version: "1.0.0", scope: "PROJECT_BOUND",
      permissions: [{ scope: "PROJECT_BOUND", actions: ["read"], resource: "inventory.stock.read" }],
      capabilityRequirements: ["extension.gadget.business_action"], lifecycle: {},
      schemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
      businessActions: [listLowStock] };
    expect(parseExtensionPrimitive(gadget)).toMatchObject({ businessActions: [{ id: "listLowStock", effects: "read_only" }] });
    expect(() => parseExtensionPrimitive({ ...gadget, permissions: [{ ...gadget.permissions[0], actions: ["write"] }] }))
      .toThrow("business_action_permission_required");
  });

  it("offers the UI a same-origin list and invoke client whose calls stay inside the host API", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ version: 1, actions: [] })) as typeof fetch;
    const client = createBusinessActionClient("/spaces/s/projects/p/apps/inventory", fetcher);
    await expect(client.list()).resolves.toEqual({ version: 1, actions: [] });
    await client.invoke("receiveStock", { productId: "sku-1" });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/spaces/s/projects/p/apps/inventory/business-actions", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/spaces/s/projects/p/apps/inventory/business-actions/receiveStock", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ productId: "sku-1" }),
    }));
    expect(() => client.invoke("../other", {})).toThrow("business_action_id_invalid");
  });

  it("uses the opaque Canvas parent bridge for list and invoke requests", async () => {
    const parent = { postMessage: vi.fn() };
    const child = new EventTarget();
    Object.defineProperty(child, "parent", { value: parent });
    vi.stubGlobal("window", child);
    try {
      const fetcher = vi.fn() as typeof fetch;
      const client = createBusinessActionClient("/spaces/s/projects/p/apps/inventory", fetcher);
      const listed = client.list();
      const listRequest = parent.postMessage.mock.calls[0]?.[0] as { type: string; id: string; operation: string; appId: string };
      expect(listRequest).toMatchObject({ type: "naelao.extension.business-action", operation: "list", appId: "inventory" });
      const listResult = Object.assign(new Event("message"), { source: parent,
        data: { type: "naelao.extension.business-action.result", id: listRequest.id, ok: true, result: { version: 1, actions: [] } } });
      child.dispatchEvent(listResult);
      await expect(listed).resolves.toEqual({ version: 1, actions: [] });

      const invoked = client.invoke("receiveStock", { productId: "sku-1" });
      const invokeRequest = parent.postMessage.mock.calls[1]?.[0] as { type: string; id: string; operation: string; appId: string; actionId: string; input: unknown };
      expect(invokeRequest).toMatchObject({ type: "naelao.extension.business-action", operation: "invoke", appId: "inventory", actionId: "receiveStock", input: { productId: "sku-1" } });
      const invokeResult = Object.assign(new Event("message"), { source: parent,
        data: { type: "naelao.extension.business-action.result", id: invokeRequest.id, ok: true, result: { productId: "sku-1", quantity: 4, version: 2, replayed: false } } });
      child.dispatchEvent(invokeResult);
      await expect(invoked).resolves.toMatchObject({ productId: "sku-1", quantity: 4, replayed: false });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses a Web Crypto values fallback for opaque frames without randomUUID", async () => {
    const parent = { postMessage: vi.fn() };
    const child = new EventTarget();
    Object.defineProperty(child, "parent", { value: parent });
    vi.stubGlobal("window", child);
    vi.stubGlobal("crypto", { getRandomValues: vi.fn((bytes: Uint8Array) => { bytes.fill(7); return bytes; }) });
    try {
      const client = createBusinessActionClient("/spaces/s/apps/inventory");
      const listed = client.list();
      const request = parent.postMessage.mock.calls[0]?.[0] as { id: string };
      expect(request.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      child.dispatchEvent(Object.assign(new Event("message"), { source: parent,
        data: { type: "naelao.extension.business-action.result", id: request.id, ok: true, result: { version: 1, actions: [] } } }));
      await expect(listed).resolves.toEqual({ version: 1, actions: [] });
    } finally { vi.unstubAllGlobals(); }
  });
});
