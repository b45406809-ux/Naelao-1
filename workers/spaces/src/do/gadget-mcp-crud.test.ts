import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { MicroAppDO } from "./MicroAppDO.js";
import { RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA } from "@naelao/agent-sdk";
import { signHmac } from "@naelao/crypto";

async function signedBusinessActionFixture(action: Record<string, unknown>, secret: string) {
  const extensionId = "ext_inventory_shop", version = "1.0.0", html = "<main>Inventory receiving</main>";
  const manifestJson = JSON.stringify({ id: extensionId, bundle: { id: extensionId, version, primitives: [
    { kind: "canvas", component: "./inventory.html" },
    { kind: "gadget", id: "inventory", scope: "PROJECT_BOUND", permissions: [
      { scope: "PROJECT_BOUND", actions: ["write"], resource: action.permission },
    ], businessActions: [action] },
  ] }, capabilityRequirements: ["extension.gadget.business_action"] });
  const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const artifactSha256 = "a".repeat(64), canvasSha256 = await hash(html);
  const hostSignature = await signHmac(JSON.stringify([extensionId, version, manifestJson, artifactSha256]), secret);
  const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactSha256, hostSignature, "./inventory.html", canvasSha256]);
  return { html, releaseProof: { extensionId, version, manifestJson, artifactSha256, hostSignature, canvasPath: "./inventory.html", canvasSha256,
    bindingSignature: await signHmac(bindingPayload, secret) } };
}

describe("Gadget MCP record operations", () => {
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
    const signed = await signedBusinessActionFixture(action, "gadget-test-secret");
    const unsigned = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "inventory_shop", scope: "PROJECT_BOUND", gadgetTier: 2,
        defaultSchemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)", businessActions: [action] }) }));
    expect(unsigned.status).toBe(403);
    const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "inventory_shop", scope: "PROJECT_BOUND", gadgetTier: 2,
        defaultSchemaSql: "CREATE TABLE inventory(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)",
        extensionInstallationId: "install-inventory-1", sourceGadgetId: "inventory", businessActions: [action], html: signed.html, releaseProof: signed.releaseProof }) }));
    expect(initialized.status).toBe(201);
    storage.sql.exec("INSERT INTO inventory(id,quantity,version) VALUES(?,?,?)", "sku-1", 4, 1);

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

    const call = async (name: string, args: Record<string, unknown>, actor = "owner-a", role = "admin", target = gadget) => target.fetch(new Request("http://gadget/mcp", {
      method: "POST", headers: headers(actor, role), body: JSON.stringify({ jsonrpc: "2.0", id: "action", method: "tools/call",
        params: { name: name === "receiveStock" ? "app_inventory_shop_action_receiveStock" : `app_inventory_shop_${name}`, arguments: args } }),
    }));
    const restarted = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "gadget-test-secret" } as never);
    const replay = await call("receiveStock", input, "owner-a", "admin", restarted);
    expect((await replay.json() as { result: { structuredContent: unknown } }).result.structuredContent)
      .toEqual({ productId: "sku-1", quantity: 7, version: 2, replayed: true });
    const conflict = await call("receiveStock", { ...input, quantity: 4 });
    expect((await conflict.json() as { error: { message: string } }).error.message).toBe("business_action_idempotency_conflict");
    const stale = await call("receiveStock", { ...input, idempotencyKey: "receipt-2026-0002" });
    expect((await stale.json() as { error: { message: string } }).error.message).toBe("business_action_version_conflict");
    const listing = await gadget.fetch(new Request("http://gadget/mcp", { method: "POST", headers: headers("owner-a", "admin"),
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }) }));
    const listed = await listing.json() as { result: { tools: Array<{ name: string; outputSchema?: unknown }> } };
    expect(listed.result.tools.find(tool => tool.name === "app_inventory_shop_action_receiveStock")?.outputSchema)
      .toEqual(RECEIVE_STOCK_OUTPUT_SCHEMA);

    const genericWrite = await call("update", { table: "inventory", id: "sku-1", record: { quantity: 99 } });
    expect(genericWrite.status).toBe(400);
    const genericInsert = await call("insert", { table: "inventory", record: { id: "sku-2", quantity: 5, version: 1 } });
    expect(genericInsert.status).toBe(400);
    const deleted = await call("delete", { table: "inventory", id: "sku-1" });
    expect(deleted.status).toBe(400);
    const current = [...sql.exec<{ quantity: number; version: number }>("SELECT quantity,version FROM inventory WHERE id=?", "sku-1")][0];
    expect(current).toEqual({ quantity: 7, version: 2 });
    const audit = await gadget.fetch(new Request("http://gadget/api/actions/audit?after=0"));
    const auditBody = await audit.json() as {
      items: Array<{ actor_id: string; operation: string; target_hash: string | null }>;
      business_events: Array<{ action_id: string; actor_id: string; product_id: string; quantity_received: number;
        quantity_before: number; quantity_after: number; version_before: number; version_after: number; reason: string }>;
    };
    const auditItems = auditBody.items;
    expect(auditItems.map(item => item.operation)).toEqual(["business:receiveStock:completed", "business:receiveStock:replayed",
      "business:receiveStock:idempotency_conflict", "business:receiveStock:version_conflict"]);
    expect(auditItems.every(item => item.actor_id === "owner-a" && item.target_hash !== "sku-1")).toBe(true);
    expect(auditBody.business_events).toEqual([{ id: 1, action_id: "receiveStock", actor_id: "owner-a", product_id: "sku-1",
      quantity_received: 3, quantity_before: 4, quantity_after: 7, version_before: 1, version_after: 2, reason: "PO-2041", created_at: expect.any(Number) }]);
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
