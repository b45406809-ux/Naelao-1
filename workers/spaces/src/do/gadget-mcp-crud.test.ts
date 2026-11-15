import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { MicroAppDO } from "./MicroAppDO.js";
import { digestExtensionManifest, RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA, ADJUST_STOCK_INPUT_SCHEMA,
  ADJUST_STOCK_OUTPUT_SCHEMA, LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA, validateExtensionManifest } from "@naelao/agent-sdk";
import { signHmac } from "@naelao/crypto";
import { mintInternalToken } from "@naelao/http";

async function signedBusinessActionFixture(actionInput: Record<string, unknown> | Record<string, unknown>[], secret: string) {
  const actions = Array.isArray(actionInput) ? actionInput : [actionInput];
  const extensionId = "ext_inventory_shop", version = "1.0.0", html = "<main>Inventory receiving</main>";
  const manifestJson = JSON.stringify({ id: extensionId, bundle: { id: extensionId, version, primitives: [
    { kind: "canvas", component: "./inventory.html" },
    { kind: "gadget", id: "inventory", scope: "PROJECT_BOUND", permissions: actions.map(action =>
      ({ scope: "PROJECT_BOUND", actions: [action.effects === "read_only" ? "read" : "write"], resource: action.permission })), businessActions: actions },
  ] }, capabilityRequirements: ["extension.gadget.business_action"] });
  const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const artifactSha256 = "a".repeat(64), canvasSha256 = await hash(html);
  const hostSignature = await signHmac(JSON.stringify([extensionId, version, manifestJson, artifactSha256]), secret);
  const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactSha256, hostSignature, "./inventory.html", canvasSha256]);
  return { html, releaseProof: { extensionId, version, manifestJson, artifactSha256, hostSignature, canvasPath: "./inventory.html", canvasSha256,
    bindingSignature: await signHmac(bindingPayload, secret) } };
}

async function signedMicroAppArchiveFixture(secret: string, installationId = "install-archive-1",
  gadgetScope: "PROJECT_BOUND" | "USER_PRIVATE" = "PROJECT_BOUND", userId = "user-archive-a") {
  const extensionId = "ext_archive_demo", version = "1.0.0", appId = "archive_canvas", html = "<main>Archive demo</main>";
  const manifest = { id: extensionId, type: "extension", declaredPermissions: [], capabilityRequirements: ["extension.canvas"],
    gadgets: gadgetScope === "USER_PRIVATE" ? [{ id: appId, name: "Personal archive", viewportComponent: "./archive.ts",
      scope: "USER_PRIVATE", gadgetTier: 1, defaultSchemaSql: "CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY)" }] : [],
    daemons: [], commands: [], bundle: { schemaVersion: "1.0", kind: "extension_bundle", id: extensionId, version,
      primitives: [{ schemaVersion: "1.0", kind: "canvas", id: "archive_canvas", version, permissions: [], capabilityRequirements: [], lifecycle: {},
        layout: "DualPane.DataGrid", component: "./archive.html", dynamicPage: false }] } };
  const canonicalManifest = validateExtensionManifest(manifest);
  const manifestJson = JSON.stringify(manifest), manifestSha256 = await digestExtensionManifest(canonicalManifest);
  const artifactSha256 = "a".repeat(64);
  const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const canvasSha256 = await hash(html);
  const hostSignature = await signHmac(JSON.stringify([extensionId, version, manifestJson, artifactSha256]), secret);
  const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactSha256, hostSignature, "./archive.html", canvasSha256]);
  return { appId, html, extensionId, version, manifestSha256, artifactSha256,
    releaseProof: { extensionId, version, manifestJson, artifactSha256, hostSignature, canvasPath: "./archive.html", canvasSha256,
      bindingSignature: await signHmac(bindingPayload, secret) },
    scope: { tenantId: "tenant-archive", spaceId: "space-archive", projectId: gadgetScope === "PROJECT_BOUND" ? "project-archive" : null, installationId,
      extensionId, releaseVersion: version, artifactSha256, manifestSha256, appId, gadgetScope,
      ...(gadgetScope === "USER_PRIVATE" ? { userId } : {}) } };
}

function microAppWithStorage(storage: ReturnType<typeof createDOStorage>, secret: string) {
  const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
    const result = storage.sql.exec<T>(query, ...args);
    return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
  } };
  return new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never,
    { PLATFORM_SECRET: secret } as never);
}

describe("Gadget MCP record operations", () => {
  it("backfills legacy inventory event rows when adding the versioned operation and quantity delta fields", async () => {
    const storage = createDOStorage();
    storage.sql.exec(`CREATE TABLE gadget_business_action_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, actor_id TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity_received INTEGER NOT NULL, quantity_before INTEGER NOT NULL, quantity_after INTEGER NOT NULL,
      version_before INTEGER NOT NULL, version_after INTEGER NOT NULL, reason TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256)=64), created_at INTEGER NOT NULL,
      UNIQUE(action_id,idempotency_key_sha256)
    )`);
    storage.sql.exec(`INSERT INTO gadget_business_action_events(action_id,actor_id,product_id,quantity_received,quantity_before,
      quantity_after,version_before,version_after,reason,idempotency_key_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    "receiveStock", "owner-a", "sku-1", 3, 4, 7, 1, 2, "PO-2041", "c".repeat(64), 101);
    const gadget = microAppWithStorage(storage, "gadget-test-secret");
    const response = await gadget.fetch(new Request("http://gadget/api/actions/audit?after=0"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ business_events: [{ action_id: "receiveStock", action_operation: "inventory.receiveStock.v1", quantity_delta: 3 }] });
  });

  it("runs the same authorized inventory business action through UI HTTP and assistant MCP with CAS, receipts, and audit", async () => {
    const storage = createDOStorage();
    const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
      const result = storage.sql.exec<T>(query, ...args);
      return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
    } };
    const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "gadget-test-secret" } as never);
    const action = { schemaVersion: 1, id: "receiveStock", name: "Receive stock", description: "Record delivered units against the current stock version.",
      operation: "inventory.receiveStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
      table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version",
      permission: "inventory.stock.receive", roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
      inputSchema: RECEIVE_STOCK_INPUT_SCHEMA, outputSchema: RECEIVE_STOCK_OUTPUT_SCHEMA };
    const adjustAction = { schemaVersion: 1, id: "adjustStock", name: "Adjust stock", description: "Set the counted on-hand quantity against the current stock version.",
      operation: "inventory.adjustStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
      table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version",
      permission: "inventory.stock.adjust", roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
      inputSchema: ADJUST_STOCK_INPUT_SCHEMA, outputSchema: ADJUST_STOCK_OUTPUT_SCHEMA };
    const listAction = { schemaVersion: 1, id: "listLowStock", name: "List low stock", description: "Read a bounded page of products at or below the selected stock threshold.",
      operation: "inventory.listLowStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
      table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version",
      permission: "inventory.stock.read", roles: ["owner", "admin"], effects: "read_only", idempotency: "none", approval: "none",
      inputSchema: LIST_LOW_STOCK_INPUT_SCHEMA, outputSchema: LIST_LOW_STOCK_OUTPUT_SCHEMA };
    const actions = [action, adjustAction, listAction];
    const signed = await signedBusinessActionFixture(actions, "gadget-test-secret");
    const unsigned = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "inventory_shop", scope: "PROJECT_BOUND", gadgetTier: 2,
        defaultSchemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)", businessActions: actions }) }));
    expect(unsigned.status).toBe(403);
    const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "inventory_shop", scope: "PROJECT_BOUND", gadgetTier: 2,
        defaultSchemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
        extensionInstallationId: "install-inventory-1", sourceGadgetId: "inventory", businessActions: actions, html: signed.html, releaseProof: signed.releaseProof }) }));
    expect(initialized.status).toBe(201);
    storage.sql.exec("INSERT INTO inventory(id,quantity,version) VALUES(?,?,?)", "sku-1", 4, 1);
    storage.sql.exec("INSERT INTO inventory(id,quantity,version) VALUES(?,?,?)", "sku-2", 5, 1);
    storage.sql.exec("INSERT INTO inventory(id,quantity,version) VALUES(?,?,?)", "sku-3", 20, 1);

    const input = { productId: "sku-1", quantity: 3, expectedVersion: 1, reason: "PO-2041", idempotencyKey: "receipt-2026-0001" };
    const headers = (actor: string, role: string) => ({ "content-type": "application/json", "x-naelao-user-id": actor, "x-naelao-role": role,
      "x-naelao-active-installation-id": "install-inventory-1", "x-naelao-active-release-version": "1.0.0" });
    const denied = await gadget.fetch(new Request("http://gadget/business-actions/receiveStock", { method: "POST", headers: headers("member-a", "member"), body: JSON.stringify(input) }));
    expect(denied.status).toBe(403);
    const unpinned = await gadget.fetch(new Request("http://gadget/business-actions/receiveStock", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-user-id": "owner-a", "x-naelao-role": "admin" }, body: JSON.stringify(input) }));
    expect(unpinned.status).toBe(409);
    const uiCall = await gadget.fetch(new Request("http://gadget/business-actions/receiveStock", { method: "POST", headers: headers("owner-a", "admin"), body: JSON.stringify(input) }));
    expect(uiCall.status).toBe(200);
    expect(await uiCall.json()).toEqual({ productId: "sku-1", quantity: 7, version: 2, replayed: false });

    const lowStockInput = { maximumQuantity: 10, limit: 1 };
    const memberRead = await gadget.fetch(new Request("http://gadget/business-actions/listLowStock", { method: "POST",
      headers: headers("member-a", "member"), body: JSON.stringify(lowStockInput) }));
    expect(memberRead.status).toBe(403);
    const staleRead = await gadget.fetch(new Request("http://gadget/business-actions/listLowStock", { method: "POST",
      headers: { ...headers("owner-a", "admin"), "x-naelao-active-release-version": "0.9.0" }, body: JSON.stringify(lowStockInput) }));
    expect(staleRead.status).toBe(409);
    const malformedRead = await gadget.fetch(new Request("http://gadget/business-actions/listLowStock", { method: "POST",
      headers: headers("owner-a", "admin"), body: JSON.stringify({ ...lowStockInput, maximumQuantity: -1 }) }));
    expect(malformedRead.status).toBe(400);
    const beforeReadReceipts = [...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM gadget_business_action_receipts")][0]?.count ?? 0;
    const uiRead = await gadget.fetch(new Request("http://gadget/business-actions/listLowStock", { method: "POST",
      headers: headers("owner-a", "admin"), body: JSON.stringify(lowStockInput) }));
    expect(uiRead.status).toBe(200);
    expect(await uiRead.json()).toEqual({ products: [{ productId: "sku-1", quantity: 7, version: 2 }], hasMore: true, nextCursor: "sku-1" });

    const call = async (name: string, args: Record<string, unknown>, actor = "owner-a", role = "admin", target = gadget) => target.fetch(new Request("http://gadget/mcp", {
      method: "POST", headers: headers(actor, role), body: JSON.stringify({ jsonrpc: "2.0", id: "action", method: "tools/call",
        params: { name: ["receiveStock", "adjustStock", "listLowStock"].includes(name) ? `app_inventory_shop_action_${name}` : `app_inventory_shop_${name}`, arguments: args } }),
    }));
    const assistantRead = await call("listLowStock", { ...lowStockInput, afterProductId: "sku-1" });
    expect((await assistantRead.json() as { result: { structuredContent: unknown } }).result.structuredContent)
      .toEqual({ products: [{ productId: "sku-2", quantity: 5, version: 1 }], hasMore: false, nextCursor: "" });
    expect([...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM gadget_business_action_receipts")][0]?.count).toBe(beforeReadReceipts);
    const memberTools = await gadget.fetch(new Request("http://gadget/mcp", { method: "POST", headers: headers("member-a", "member"),
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools-member", method: "tools/list" }) }));
    expect((await memberTools.json() as { result: { tools: Array<{ name: string }> } }).result.tools.some(tool => tool.name.endsWith("action_listLowStock"))).toBe(false);
    const memberMcpRead = await call("listLowStock", lowStockInput, "member-a", "member");
    expect((await memberMcpRead.json() as { error: { message: string } }).error.message).toBe("business_action_forbidden");
    const restarted = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "gadget-test-secret" } as never);
    const replay = await call("receiveStock", input, "owner-a", "admin", restarted);
    expect((await replay.json() as { result: { structuredContent: unknown } }).result.structuredContent)
      .toEqual({ productId: "sku-1", quantity: 7, version: 2, replayed: true });
    const adjustInput = { productId: "sku-1", newQuantity: 5, expectedVersion: 2, reason: "cycle count correction", idempotencyKey: "adjust-2026-0001" };
    const adjusted = await gadget.fetch(new Request("http://gadget/business-actions/adjustStock", { method: "POST", headers: headers("owner-a", "admin"), body: JSON.stringify(adjustInput) }));
    expect(adjusted.status).toBe(200);
    expect(await adjusted.json()).toEqual({ productId: "sku-1", previousQuantity: 7, quantity: 5, version: 3, replayed: false });
    const adjustmentReplay = await call("adjustStock", adjustInput, "owner-a", "admin", restarted);
    expect((await adjustmentReplay.json() as { result: { structuredContent: unknown } }).result.structuredContent)
      .toEqual({ productId: "sku-1", previousQuantity: 7, quantity: 5, version: 3, replayed: true });
    const conflict = await call("receiveStock", { ...input, quantity: 4 });
    expect((await conflict.json() as { error: { message: string } }).error.message).toBe("business_action_idempotency_conflict");
    const stale = await call("receiveStock", { ...input, idempotencyKey: "receipt-2026-0002" });
    expect((await stale.json() as { error: { message: string } }).error.message).toBe("business_action_version_conflict");
    const listing = await gadget.fetch(new Request("http://gadget/mcp", { method: "POST", headers: headers("owner-a", "admin"),
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }) }));
    const listed = await listing.json() as { result: { tools: Array<{ name: string; outputSchema?: unknown }> } };
    expect(listed.result.tools.find(tool => tool.name === "app_inventory_shop_action_receiveStock")?.outputSchema)
      .toEqual(RECEIVE_STOCK_OUTPUT_SCHEMA);
    expect(listed.result.tools.find(tool => tool.name === "app_inventory_shop_action_adjustStock")?.outputSchema)
      .toEqual(ADJUST_STOCK_OUTPUT_SCHEMA);
    expect(listed.result.tools.find(tool => tool.name === "app_inventory_shop_action_listLowStock")?.inputSchema)
      .toEqual(LIST_LOW_STOCK_INPUT_SCHEMA);
    expect(listed.result.tools.find(tool => tool.name === "app_inventory_shop_action_listLowStock")?.outputSchema)
      .toEqual(LIST_LOW_STOCK_OUTPUT_SCHEMA);

    const genericWrite = await call("update", { table: "inventory", id: "sku-1", record: { quantity: 99 } });
    expect(genericWrite.status).toBe(400);
    const genericInsert = await call("insert", { table: "inventory", record: { id: "sku-2", quantity: 5, version: 1 } });
    expect(genericInsert.status).toBe(400);
    const deleted = await call("delete", { table: "inventory", id: "sku-1" });
    expect(deleted.status).toBe(400);
    const current = [...sql.exec<{ quantity: number; version: number }>("SELECT quantity,version FROM inventory WHERE id=?", "sku-1")][0];
    expect(current).toEqual({ quantity: 5, version: 3 });
    const audit = await gadget.fetch(new Request("http://gadget/api/actions/audit?after=0"));
    const auditBody = await audit.json() as {
      items: Array<{ actor_id: string; operation: string; target_hash: string | null }>;
      business_events: Array<{ action_id: string; actor_id: string; product_id: string; quantity_received: number;
        quantity_before: number; quantity_after: number; version_before: number; version_after: number; reason: string;
        action_operation: string; quantity_delta: number }>;
    };
    const auditItems = auditBody.items;
    expect(auditItems.map(item => item.operation)).toEqual(["business:receiveStock:completed",
      "business:listLowStock:read", "business:listLowStock:read", "business:receiveStock:replayed",
      "business:adjustStock:completed", "business:adjustStock:replayed", "business:receiveStock:idempotency_conflict",
      "business:receiveStock:version_conflict"]);
    expect(auditItems.every(item => item.actor_id === "owner-a" && item.target_hash !== "sku-1")).toBe(true);
    expect(auditBody.business_events).toEqual([
      { id: 1, action_id: "receiveStock", actor_id: "owner-a", product_id: "sku-1", quantity_received: 3, quantity_before: 4,
        quantity_after: 7, version_before: 1, version_after: 2, reason: "PO-2041", created_at: expect.any(Number),
        action_operation: "inventory.receiveStock.v1", quantity_delta: 3 },
      { id: 2, action_id: "adjustStock", actor_id: "owner-a", product_id: "sku-1", quantity_received: 0, quantity_before: 7,
        quantity_after: 5, version_before: 2, version_after: 3, reason: "cycle count correction", created_at: expect.any(Number),
        action_operation: "inventory.adjustStock.v1", quantity_delta: -2 },
    ]);
  });

  it("binds signed business actions to their installed manifest and current release pin", async () => {
    const storage = createDOStorage();
    const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
      const result = storage.sql.exec<T>(query, ...args);
      return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
    } };
    const secret = "signed-business-action-test";
    const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: secret } as never);
    const action = { schemaVersion: 1, id: "receiveStock", name: "Receive stock", description: "Receive a stock delivery.",
      operation: "inventory.receiveStock.v1", installationScope: "PROJECT_BOUND", dataScope: "PROJECT_BOUND",
      table: "inventory", idColumn: "id", quantityColumn: "quantity", versionColumn: "version", permission: "inventory.stock.receive",
      roles: ["owner", "admin"], effects: "transactional_write", idempotency: "required", approval: "none",
      inputSchema: RECEIVE_STOCK_INPUT_SCHEMA, outputSchema: RECEIVE_STOCK_OUTPUT_SCHEMA };
    const signed = await signedBusinessActionFixture(action, secret);
    const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "store_inventory", scope: "PROJECT_BOUND", gadgetTier: 2, defaultSchemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
        extensionInstallationId: "install-inventory-1", sourceGadgetId: "inventory", businessActions: [action], html: signed.html, releaseProof: signed.releaseProof }) }));
    expect(initialized.status).toBe(201);
    storage.sql.exec("INSERT INTO inventory(id,quantity,version) VALUES(?,?,?)", "sku-1", 4, 1);
    const input = { productId: "sku-1", quantity: 1, expectedVersion: 1, reason: "PO-2042", idempotencyKey: "receipt-2026-0003" };
    const invoke = (pin: Record<string, string> = {}) => gadget.fetch(new Request("http://gadget/business-actions/receiveStock", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-user-id": "owner-a", "x-naelao-role": "admin", ...pin }, body: JSON.stringify(input) }));
    expect((await invoke()).status).toBe(409);
    expect((await invoke({ "x-naelao-active-installation-id": "install-inventory-1", "x-naelao-active-release-version": "1.0.1" })).status).toBe(409);
    const accepted = await invoke({ "x-naelao-active-installation-id": "install-inventory-1", "x-naelao-active-release-version": "1.0.0" });
    expect(accepted.status).toBe(200);
  });

  it("exports signed MicroAppDO business data and restores it with exact scope, additive conflicts, and replay receipts", async () => {
    const secret = "microapp-archive-secret";
    const signed = await signedMicroAppArchiveFixture(secret);
    const sourceStorage = createDOStorage(), source = microAppWithStorage(sourceStorage, secret);
    const initialized = await source.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: signed.appId, scope: "PROJECT_BOUND", gadgetTier: 2, extensionInstallationId: signed.scope.installationId,
        defaultSchemaSql: "CREATE TABLE todos(id TEXT PRIMARY KEY, payload BLOB NOT NULL); CREATE TABLE scoped_records(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,installation_id TEXT NOT NULL); CREATE TABLE archive_parents(id TEXT PRIMARY KEY); CREATE TABLE archive_children(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES archive_parents(id))",
        html: signed.html, releaseProof: signed.releaseProof }) }));
    expect(initialized.status).toBe(201);
    sourceStorage.sql.exec("INSERT INTO todos(id,payload) VALUES(?,?)", "source-row", new Uint8Array([0, 7, 255]));
    sourceStorage.sql.exec("INSERT INTO scoped_records(id,tenant_id,space_id,installation_id) VALUES(?,?,?,?)",
      "scoped-row", signed.scope.tenantId, signed.scope.spaceId, signed.scope.installationId);
    sourceStorage.sql.exec("INSERT INTO gadget_business_action_receipts(action_id,actor_id,idempotency_key,request_sha256,response_json,created_at) VALUES(?,?,?,?,?,?)",
      "receiveStock", "owner-a", "request-1", "b".repeat(64), "{\"quantity\":7}", 100);
    sourceStorage.sql.exec(`INSERT INTO gadget_business_action_events(action_id,actor_id,product_id,quantity_received,quantity_before,quantity_after,
      version_before,version_after,reason,idempotency_key_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    "receiveStock", "owner-a", "sku-1", 3, 4, 7, 1, 2, "PO-1", "c".repeat(64), 101);

    const internalHeaders = async (tenantId = "tenant-archive") => ({ "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(secret, tenantId) });
    const exported = await source.fetch(new Request("http://gadget/internal/archive/export", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ scope: signed.scope }) }));
    expect(exported.status).toBe(200);
    const archive = await exported.json() as { present: boolean; snapshot: { scope: unknown; tables: Array<{ name: string; schemaSha256: string; rows: Array<Record<string, unknown>> }> } };
    expect(archive.present).toBe(true);
    expect(archive.snapshot.scope).toEqual(signed.scope);
    expect(archive.snapshot.tables.map(table => table.name)).toContain("todos");
    expect(archive.snapshot.tables.map(table => table.name)).toContain("scoped_records");
    expect(archive.snapshot.tables.map(table => table.name)).toContain("gadget_business_action_receipts");
    expect(archive.snapshot.tables.map(table => table.name)).toContain("gadget_business_action_events");
    expect(archive.snapshot.tables.map(table => table.name)).not.toContain("gadget_metadata");
    expect(archive.snapshot.tables.map(table => table.name)).not.toContain("canvas_presence");

    const targetStorage = createDOStorage(), target = microAppWithStorage(targetStorage, secret);
    const targetInit = await target.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: signed.appId, scope: "PROJECT_BOUND", gadgetTier: 2, extensionInstallationId: signed.scope.installationId,
        defaultSchemaSql: "CREATE TABLE todos(id TEXT PRIMARY KEY, payload BLOB NOT NULL); CREATE TABLE scoped_records(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,installation_id TEXT NOT NULL); CREATE TABLE archive_parents(id TEXT PRIMARY KEY); CREATE TABLE archive_children(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES archive_parents(id))",
        html: signed.html, releaseProof: signed.releaseProof }) }));
    expect(targetInit.status).toBe(201);
    targetStorage.sql.exec("INSERT INTO todos(id,payload) VALUES(?,?)", "source-row", "current-value");
    const restoreSnapshot = archive.snapshot;
    const tamperedScope = structuredClone(restoreSnapshot);
    tamperedScope.tables.find(table => table.name === "scoped_records")!.rows[0]!.tenant_id = "tenant-other";
    const wrongRowScope = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: tamperedScope }) }));
    expect(wrongRowScope.status).toBe(422);
    const incompleteSnapshot = structuredClone(restoreSnapshot);
    incompleteSnapshot.tables = incompleteSnapshot.tables.filter(table => table.name !== "scoped_records");
    const incomplete = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: incompleteSnapshot }) }));
    expect(incomplete.status).toBe(422);
    const incompatibleSchema = structuredClone(restoreSnapshot);
    incompatibleSchema.tables.find(table => table.name === "scoped_records")!.schemaSha256 = "e".repeat(64);
    const schemaMismatch = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: incompatibleSchema }) }));
    expect(schemaMismatch.status).toBe(409);
    const interruptedSnapshot = structuredClone(restoreSnapshot);
    interruptedSnapshot.tables.find(table => table.name === "archive_children")!.rows.push({ id: "orphan", parent_id: "missing-parent" });
    const interruptedPreview = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: interruptedSnapshot }) }));
    expect(interruptedPreview.status).toBe(409);
    expect(await interruptedPreview.json()).toMatchObject({ error_code: "micro_app_archive_foreign_key_conflict" });
    const interruptedRestore = await target.fetch(new Request("http://gadget/internal/archive/restore", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: interruptedSnapshot, restoreId: "f".repeat(64), restoredBy: "owner-a" }) }));
    expect(interruptedRestore.status).toBe(409);
    expect(await interruptedRestore.json()).toMatchObject({ error_code: "micro_app_archive_foreign_key_conflict" });
    expect(targetStorage.sql.exec("SELECT id FROM archive_children").toArray()).toHaveLength(0);
    expect(targetStorage.sql.exec("SELECT action_id FROM gadget_business_action_receipts").toArray()).toHaveLength(0);
    expect(targetStorage.sql.exec("SELECT restore_id FROM gadget_archive_restore_receipts").toArray()).toHaveLength(0);
    const preview = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: restoreSnapshot }) }));
    expect(preview.status).toBe(200);
    expect(targetStorage.sql.exec<{ id: string }>("SELECT id FROM todos").toArray().map(row => row.id)).toEqual(["source-row"]);

    const restoreId = "d".repeat(64);
    const restore = async () => target.fetch(new Request("http://gadget/internal/archive/restore", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: restoreSnapshot, restoreId, restoredBy: "owner-a" }) }));
    const firstRestore = await restore();
    expect(firstRestore.status).toBe(200);
    expect(await firstRestore.json()).toMatchObject({ replayed: false, inserted: { todos: 0 }, skipped: { todos: 1 } });
    const preserved = targetStorage.sql.exec<{ payload: string }>("SELECT payload FROM todos WHERE id=?", "source-row").toArray()[0]?.payload;
    expect(preserved).toBe("current-value");
    expect(targetStorage.sql.exec("SELECT action_id FROM gadget_business_action_receipts").toArray()).toHaveLength(1);
    expect(targetStorage.sql.exec("SELECT product_id FROM gadget_business_action_events").toArray()).toHaveLength(1);
    expect(targetStorage.sql.exec("SELECT id FROM scoped_records").toArray()).toHaveLength(1);
    const replay = await restore();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });

    targetStorage.sql.exec("DELETE FROM gadget_business_action_events");
    const legacySnapshot = structuredClone(restoreSnapshot);
    const legacyEventSchema = `CREATE TABLE gadget_business_action_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, actor_id TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity_received INTEGER NOT NULL, quantity_before INTEGER NOT NULL, quantity_after INTEGER NOT NULL,
      version_before INTEGER NOT NULL, version_after INTEGER NOT NULL, reason TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256)=64), created_at INTEGER NOT NULL,
      UNIQUE(action_id,idempotency_key_sha256)
    )`;
    const legacyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacyEventSchema)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const legacyEvents = legacySnapshot.tables.find(table => table.name === "gadget_business_action_events")!;
    legacyEvents.schemaSha256 = legacyHash;
    legacyEvents.rows = legacyEvents.rows.map(row => {
      const legacy = { ...row };
      delete legacy.action_operation; delete legacy.quantity_delta;
      return legacy;
    });
    const legacyPreview = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: legacySnapshot }) }));
    expect(legacyPreview.status).toBe(200);
    const legacyRestore = await target.fetch(new Request("http://gadget/internal/archive/restore", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: legacySnapshot, restoreId: "b".repeat(64), restoredBy: "owner-a" }) }));
    expect(legacyRestore.status).toBe(200);
    expect(targetStorage.sql.exec<{ action_operation: string; quantity_delta: number }>(
      "SELECT action_operation,quantity_delta FROM gadget_business_action_events").toArray())
      .toEqual([{ action_operation: "inventory.receiveStock.v1", quantity_delta: 3 }]);

    const wrongTenant = await target.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: { ...restoreSnapshot, scope: { ...signed.scope, tenantId: "tenant-other" } } }) }));
    expect(wrongTenant.status).toBe(422);
    const wrongInstallationStorage = createDOStorage(), wrongInstallation = microAppWithStorage(wrongInstallationStorage, secret);
    const other = await signedMicroAppArchiveFixture(secret, "install-other");
    const otherInit = await wrongInstallation.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: other.appId, scope: "PROJECT_BOUND", gadgetTier: 2, extensionInstallationId: other.scope.installationId,
        defaultSchemaSql: "CREATE TABLE todos(id TEXT PRIMARY KEY, payload BLOB NOT NULL); CREATE TABLE scoped_records(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,installation_id TEXT NOT NULL); CREATE TABLE archive_parents(id TEXT PRIMARY KEY); CREATE TABLE archive_children(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES archive_parents(id))",
        html: other.html, releaseProof: other.releaseProof }) }));
    expect(otherInit.status).toBe(201);
    const crossInstall = await wrongInstallation.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot: restoreSnapshot }) }));
    expect(crossInstall.status).toBe(409);
    const unauthorized = await target.fetch(new Request("http://gadget/internal/archive/export", { method: "POST", headers: { "x-naelao-tenant-id": "tenant-archive" },
      body: JSON.stringify({ scope: signed.scope }) }));
    expect(unauthorized.status).toBe(403);
  });

  it("binds private-scope archive snapshots to the initialized product user", async () => {
    const secret = "microapp-private-archive-secret";
    const signed = await signedMicroAppArchiveFixture(secret, "install-private-archive", "USER_PRIVATE", "user-a");
    const sourceStorage = createDOStorage(), source = microAppWithStorage(sourceStorage, secret);
    const initialize = (instance: MicroAppDO, scope: typeof signed.scope, userId: string | undefined = scope.userId) => instance.fetch(new Request("http://gadget/initialize", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: signed.appId, scope: "USER_PRIVATE",
        gadgetTier: 1, userId, sourceGadgetId: "archive_canvas", extensionInstallationId: scope.installationId, html: signed.html, releaseProof: signed.releaseProof }),
    }));
    expect((await initialize(source, signed.scope)).status).toBe(201);
    const missingIdentity = await initialize(microAppWithStorage(createDOStorage(), secret), signed.scope, "");
    expect(missingIdentity.status).toBe(400);

    const internalHeaders = async () => ({ "content-type": "application/json", "x-naelao-tenant-id": signed.scope.tenantId,
      "x-naelao-internal-token": await mintInternalToken(secret, signed.scope.tenantId) });
    const exported = await source.fetch(new Request("http://gadget/internal/archive/export", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ scope: signed.scope }) }));
    expect(exported.status).toBe(200);
    const { snapshot } = await exported.json() as { snapshot: { scope: typeof signed.scope } };
    expect(snapshot.scope).toMatchObject({ gadgetScope: "USER_PRIVATE", userId: "user-a" });

    const otherUser = microAppWithStorage(createDOStorage(), secret);
    const otherScope = { ...signed.scope, userId: "user-b" };
    expect((await initialize(otherUser, otherScope, "user-b")).status).toBe(201);
    const crossUser = await otherUser.fetch(new Request("http://gadget/internal/archive/preview", { method: "POST", headers: await internalHeaders(),
      body: JSON.stringify({ snapshot }) }));
    expect(crossUser.status).toBe(409);
    expect(await crossUser.json()).toMatchObject({ error_code: "micro_app_archive_installation_mismatch" });
  });

  it("erases a user actor once, replays safely, and permanently blocks reinitialization", async () => {
    const secret = "microapp-user-erasure-secret";
    const signed = await signedMicroAppArchiveFixture(secret, "install-erasure", "USER_PRIVATE", "user-a");
    const storage = createDOStorage(), actor = microAppWithStorage(storage, secret);
    const initialized = await actor.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: signed.appId, scope: "USER_PRIVATE", gadgetTier: 1, userId: "user-a", tenantId: signed.scope.tenantId,
        spaceId: signed.scope.spaceId, extensionInstallationId: signed.scope.installationId, sourceGadgetId: "archive_canvas",
        defaultSchemaSql: "CREATE TABLE todos(id TEXT PRIMARY KEY)", html: signed.html, releaseProof: signed.releaseProof }) }));
    expect(initialized.status).toBe(201);
    storage.sql.exec("INSERT INTO todos(id) VALUES(?)", "private-row");

    const token = await mintInternalToken(secret, signed.scope.tenantId);
    const erase = (userId = "user-a", headers: Record<string, string> = {}) => actor.fetch(new Request("http://gadget/internal/erase-user", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": signed.scope.tenantId,
        "x-naelao-internal-token": token, ...headers },
      body: JSON.stringify({ tenantId: signed.scope.tenantId, spaceId: signed.scope.spaceId, userId, appId: signed.appId, gadgetScope: "USER_PRIVATE" }),
    }));
    expect((await erase("user-a", { "x-naelao-internal-token": "invalid" })).status).toBe(403);
    const erased = await erase();
    expect(erased.status).toBe(200);
    expect(await erased.json()).toMatchObject({ erased: true, replayed: false });
    expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='todos'").toArray()).toHaveLength(0);
    expect(await (await erase()).json()).toMatchObject({ erased: true, replayed: true });
    expect((await erase("user-b")).status).toBe(409);
    expect((await actor.fetch(new Request("http://gadget/api/data?key=private-row"))).status).toBe(410);
    const reinitialize = await actor.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: signed.appId, scope: "USER_PRIVATE", gadgetTier: 1, userId: "user-a" }) }));
    expect(reinitialize.status).toBe(410);
  });

  it("maintains bounded Canvas cursors and actor-attributed collaboration events", async () => {
    const storage = createDOStorage();
    const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
      const result = storage.sql.exec<T>(query, ...args);
      return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
    } };
    const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "gadget-test-secret" } as never);
    const write = (actor: string, body: unknown) => gadget.fetch(new Request("http://gadget/api/collaboration", { method: "POST", headers: { "content-type": "application/json", "x-naelao-user-id": actor }, body: JSON.stringify(body) }));
    expect((await write("member-a", { kind: "cursor", payload: { x: 0.25, y: 0.75, label: "Planner" } })).status).toBe(200);
    const comment = await write("member-b", { kind: "comment", payload: { text: "Review this panel" } });
    expect(comment.status).toBe(201);
    expect((await write("member-a", { kind: "cursor", payload: { x: 2, y: 0 } })).status).toBe(400);
    expect((await write("member-a", { kind: "operation", payload: { operation: "javascript.eval", source: "secret" } })).status).toBe(400);
    const page = await (await gadget.fetch(new Request("http://gadget/api/collaboration?after=0"))).json();
    expect(page).toMatchObject({ next_after: 1, events: [{ id: 1, actor_id: "member-b", kind: "comment", payload: { text: "Review this panel" } }], presence: [{ actor_id: "member-a", cursor: { x: 0.25, y: 0.75, label: "Planner" } }] });
  });

  it("lists, inserts, gets, updates, and deletes only schema columns", async () => {
    const storage = createDOStorage();
    const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
      if (/^PRAGMA table_info/i.test(query)) {
        const rows = [
          { name: "id", type: "TEXT", pk: 1, notnull: 0 },
          { name: "status", type: "TEXT", pk: 0, notnull: 1 },
          { name: "quantity", type: "REAL", pk: 0, notnull: 1 },
        ] as T[];
        return { toArray: () => rows, rowsWritten: 0, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
      const result = storage.sql.exec<T>(query, ...args);
      return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
    } };
    const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "gadget-test-secret" } as never);
    const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST", body: JSON.stringify({ appId: "journal", scope: "PROJECT_BOUND", gadgetTier: 2,
      defaultSchemaSql: "CREATE TABLE journal(id TEXT PRIMARY KEY, status TEXT NOT NULL, quantity REAL NOT NULL)" }) }));
    expect(initialized.status).toBe(201);
    const listedTools = await gadget.fetch(new Request("http://gadget/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list" }) }));
    const listedBody = await listedTools.json() as { result: { schema: Array<{ table: string }> } };
    expect(listedBody.result.schema.map(item => item.table)).toEqual(["journal"]);
    expect(JSON.stringify(listedBody)).not.toContain("gadget_data");
    const call = async (name: string, args: Record<string, unknown>) => gadget.fetch(new Request("http://gadget/mcp", { method: "POST", headers: { "content-type": "application/json", "x-naelao-user-id": "owner-a" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "test", method: "tools/call", params: { name: `app_journal_${name}`, arguments: args } }) }));
    const inserted = await call("insert", { table: "journal", record: { id: "trade-1", status: "open", quantity: 2 } });
    const insertBody = await inserted.json() as { result?: { structuredContent?: unknown }; error?: unknown };
    expect(insertBody, JSON.stringify(insertBody)).toHaveProperty("result.structuredContent", { inserted: true });
    const updated = await call("update", { table: "journal", id: "trade-1", record: { status: "closed" } });
    expect((await updated.json() as { result: { structuredContent: unknown } }).result.structuredContent).toEqual({ updated: true });
    const record = await call("get", { table: "journal", id: "trade-1" });
    expect((await record.json() as { result: { structuredContent: unknown } }).result.structuredContent).toMatchObject({ id: "trade-1", status: "closed", quantity: 2 });
    const boundedList = await call("list", { table: "journal", limit: "Infinity" });
    expect((await boundedList.json() as { result: { structuredContent: unknown[] } }).result.structuredContent).toHaveLength(1);
    expect((await call("update", { table: "journal", id: "trade-1", record: { unapproved: true } })).status).toBe(400);
    const internalTable = await gadget.fetch(new Request("http://gadget/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "internal", method: "tools/call", params: { name: "app_journal_list", arguments: { table: "gadget_data" } } }) }));
    expect(internalTable.status).toBe(400);
    expect((await call("delete", { table: "journal", id: "trade-1" })).status).toBe(200);
    const missing = await call("get", { table: "journal", id: "trade-1" });
    expect((await missing.json() as { result: { structuredContent: unknown } }).result.structuredContent).toBeNull();
    const audit = await gadget.fetch(new Request("http://gadget/api/actions/audit?after=0"));
    const auditBody = await audit.json() as { items: Array<Record<string, unknown>> };
    expect(auditBody.items.map(item => [item.actor_id, item.operation, item.table_name])).toEqual([["owner-a", "insert", "journal"], ["owner-a", "update", "journal"], ["owner-a", "get", "journal"], ["owner-a", "list", "journal"], ["owner-a", "delete", "journal"], ["owner-a", "get", "journal"]]);
    expect(JSON.stringify(auditBody)).not.toContain("trade-1");
  });
});
