import { DurableObject } from "cloudflare:workers";
import type { GadgetActorScope, GadgetScope } from "@naelao/agent-sdk";

export interface MicroAppDOEnv { PLATFORM_SECRET: string }

/** The exact stable name passed to DurableObjectNamespace.idFromName. */
export function gadgetStorageKey(input: GadgetActorScope): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.appId)) throw new Error("invalid_gadget_app_id");
  if (!input.spaceId) throw new Error("gadget_space_id_required");
  if (input.scope === "SPACE_WIDE") return `gadget:${input.appId}:space:${input.spaceId}`;
  if (input.scope === "PROJECT_BOUND") {
    if (!input.projectId) throw new Error("gadget_project_id_required");
    return `gadget:${input.appId}:project:${input.projectId}`;
  }
  if (!input.userId) throw new Error("gadget_user_id_required");
  return `gadget:${input.appId}:space:${input.spaceId}:user:${input.userId}`;
}

export function gadgetActorId(namespace: Pick<DurableObjectNamespace, "idFromName">, input: GadgetActorScope): DurableObjectId {
  return namespace.idFromName(gadgetStorageKey(input));
}

function validDdl(sql: string): string[] {
  if (sql.length > 64_000 || /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|DROP|ALTER)\b/i.test(sql)) throw new Error("unsafe_gadget_schema");
  const statements = sql.split(";").map((part) => part.trim()).filter(Boolean);
  if (!statements.every((statement) => /^CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_]/i.test(statement))) throw new Error("gadget_schema_ddl_only");
  return statements;
}

/** One instance per gadget scope; no database or data can be shared across actor IDs. */
export class MicroAppDO extends DurableObject<MicroAppDOEnv> {
  private initialized = false;

  private ensureBaseSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gadget_data (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureBaseSchema();
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/initialize") return await this.initialize(request);
      if (request.method === "GET" && url.pathname === "/app") return this.renderApp();
      if (request.method === "GET" && url.pathname === "/api/data") return this.readData(url);
      if (request.method === "POST" && url.pathname === "/api/data") return await this.writeData(request);
      if (request.method === "DELETE" && url.pathname === "/api/data") return this.deleteData(url);
      if (request.method === "POST" && url.pathname === "/mcp") return await this.handleMcp(request);
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "micro_app_error" }, { status: 400 });
    }
  }

  private appId(): string {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'app_id'")][0]?.value ?? "app";
  }

  private userTables(): string[] {
    return [...this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('gadget_metadata') ORDER BY name")].map(row => row.name);
  }

  private columns(table: string): Array<{ name: string; type: string; pk: number; notnull: number }> {
    if (!this.userTables().includes(table)) throw new Error("unknown_table");
    return [...this.ctx.storage.sql.exec<{ name: string; type: string; pk: number; notnull: number }>(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)];
  }

  /** Stateless MCP 2025 Streamable HTTP transport. Each request is a complete JSON-RPC turn. */
  private async handleMcp(request: Request): Promise<Response> {
    const rpc = await request.json<{ jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }>();
    const id = rpc.id ?? null, appId = this.appId().replace(/[^a-zA-Z0-9_]/g, "_");
    const result = (value: unknown) => Response.json({ jsonrpc: "2.0", id, result: value }, { headers: { "mcp-session-id": crypto.randomUUID() } });
    if (rpc.jsonrpc !== "2.0") return Response.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } }, { status: 400 });
    if (rpc.method === "initialize") return result({ protocolVersion: "2025-03-26", serverInfo: { name: `naelao-app-${appId}`, version: "2.0" }, capabilities: { tools: { listChanged: false } } });
    const tables = this.userTables();
    const schemas = tables.map(table => ({ table, columns: this.columns(table) }));
    const tools = [
      { name: `app_${appId}_list`, description: "List gadget records", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, filter: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["table"] } },
      { name: `app_${appId}_insert`, description: "Insert a schema-validated gadget record", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, record: { type: "object" } }, required: ["table", "record"] } },
      { name: `app_${appId}_get`, description: "Get one gadget record by primary key", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {} }, required: ["table", "id"] } },
    ];
    if (rpc.method === "tools/list") return result({ tools, schema: schemas });
    if (rpc.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, { status: 404 });
    const name = String(rpc.params?.name ?? ""), args = (rpc.params?.arguments ?? {}) as Record<string, unknown>, table = String(args.table ?? "");
    const columns = this.columns(table), quoted = `"${table.replaceAll('"', '""')}"`;
    let data: unknown;
    if (name === `app_${appId}_list`) {
      const filter = args.filter && typeof args.filter === "object" && !Array.isArray(args.filter) ? args.filter as Record<string, unknown> : {};
      const allowed = new Set(columns.map(c => c.name)); const pairs = Object.entries(filter).filter(([key]) => allowed.has(key));
      const where = pairs.length ? ` WHERE ${pairs.map(([key]) => `"${key.replaceAll('"','""')}" = ?`).join(" AND ")}` : "";
      data = [...this.ctx.storage.sql.exec(`SELECT * FROM ${quoted}${where} LIMIT ?`, ...pairs.map(([,v]) => v as SqlStorageValue), Math.min(Math.max(Number(args.limit ?? 100), 1), 500))];
    } else if (name === `app_${appId}_insert`) {
      if (!args.record || typeof args.record !== "object" || Array.isArray(args.record)) throw new Error("record_required");
      const record = args.record as Record<string, unknown>, allowed = new Set(columns.map(c => c.name)); const entries = Object.entries(record).filter(([key]) => allowed.has(key));
      if (!entries.length || entries.length !== Object.keys(record).length) throw new Error("record_does_not_match_schema");
      this.ctx.storage.sql.exec(`INSERT INTO ${quoted} (${entries.map(([key]) => `"${key.replaceAll('"','""')}"`).join(",")}) VALUES (${entries.map(() => "?").join(",")})`, ...entries.map(([,v]) => v as SqlStorageValue));
      data = { inserted: true };
    } else if (name === `app_${appId}_get`) {
      const pk = columns.find(c => c.pk)?.name ?? columns[0]?.name; if (!pk) throw new Error("table_has_no_columns");
      data = [...this.ctx.storage.sql.exec(`SELECT * FROM ${quoted} WHERE "${pk.replaceAll('"','""')}" = ? LIMIT 1`, args.id as SqlStorageValue)][0] ?? null;
    } else throw new Error("unknown_tool");
    return result({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
  }

  private async initialize(request: Request): Promise<Response> {
    const body = await request.json<{ appId?: string; scope?: GadgetScope; defaultSchemaSql?: string; html?: string }>();
    if (!body.appId || !body.scope) return Response.json({ error: "appId and scope are required" }, { status: 400 });
    const existing = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'app_id'")][0];
    if (existing && existing.value !== body.appId) return Response.json({ error: "actor_already_owned" }, { status: 409 });
    for (const statement of validDdl(body.defaultSchemaSql ?? "")) this.ctx.storage.sql.exec(statement);
    const html = body.html ?? `<main id="app"></main><script type="module">window.__NAELAO_GADGET__=${JSON.stringify(body.appId)}</script>`;
    if (html.length > 512_000) throw new Error("gadget_bundle_too_large");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES ('app_id',?),('scope',?),('html',?)", body.appId, body.scope, html);
    return Response.json({ initialized: true, appId: body.appId, scope: body.scope }, { status: 201 });
  }

  private renderApp(): Response {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'html'")][0];
    if (!row) return Response.json({ error: "gadget_not_initialized" }, { status: 404 });
    return new Response(row.value, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" } });
  }

  private readData(url: URL): Response {
    const key = url.searchParams.get("key");
    if (key) {
      const row = [...this.ctx.storage.sql.exec<{ key: string; value_json: string; updated_at: string }>("SELECT key,value_json,updated_at FROM gadget_data WHERE key = ?", key)][0];
      return row ? Response.json({ key: row.key, value: JSON.parse(row.value_json), updatedAt: row.updated_at }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
    const rows = [...this.ctx.storage.sql.exec<{ key: string; value_json: string; updated_at: string }>("SELECT key,value_json,updated_at FROM gadget_data ORDER BY key LIMIT ?", limit)];
    return Response.json({ data: rows.map((row) => ({ key: row.key, value: JSON.parse(row.value_json), updatedAt: row.updated_at })) });
  }

  private async writeData(request: Request): Promise<Response> {
    const body = await request.json<{ key?: string; value?: unknown }>();
    if (!body.key || body.key.length > 256) return Response.json({ error: "valid key is required" }, { status: 400 });
    const encoded = JSON.stringify(body.value);
    if (encoded === undefined || encoded.length > 1_000_000) return Response.json({ error: "invalid_or_oversized_value" }, { status: 413 });
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("INSERT INTO gadget_data(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", body.key, encoded, now);
    return Response.json({ key: body.key, value: body.value, updatedAt: now }, { status: 201 });
  }

  private deleteData(url: URL): Response {
    const key = url.searchParams.get("key");
    if (!key) return Response.json({ error: "key is required" }, { status: 400 });
    this.ctx.storage.sql.exec("DELETE FROM gadget_data WHERE key = ?", key);
    return Response.json({ deleted: true, key });
  }
}
