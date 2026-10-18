import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { MicroAppDO } from "./MicroAppDO.js";

describe("Gadget MCP record operations", () => {
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
    expect((await call("delete", { table: "journal", id: "trade-1" })).status).toBe(200);
    const missing = await call("get", { table: "journal", id: "trade-1" });
    expect((await missing.json() as { result: { structuredContent: unknown } }).result.structuredContent).toBeNull();
    const audit = await gadget.fetch(new Request("http://gadget/api/actions/audit?after=0"));
    const auditBody = await audit.json() as { items: Array<Record<string, unknown>> };
    expect(auditBody.items.map(item => [item.actor_id, item.operation, item.table_name])).toEqual([["owner-a", "insert", "journal"], ["owner-a", "update", "journal"], ["owner-a", "get", "journal"], ["owner-a", "list", "journal"], ["owner-a", "delete", "journal"], ["owner-a", "get", "journal"]]);
    expect(JSON.stringify(auditBody)).not.toContain("trade-1");
  });
});
