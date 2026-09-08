export interface MicroAppEnv {
  GATEKEEPER_SECRET?: string;
}

export interface McpToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export class MicroAppDO {
  private state: DurableObjectState;
  private env: MicroAppEnv;
  private initialized = false;

  constructor(state: DurableObjectState, env: MicroAppEnv) {
    this.state = state;
    this.env = env;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;

    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS facet_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facet_records (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_facet_collection ON facet_records(collection);
    `);

    this.initialized = true;
  }

  private verifyGatekeeperAuth(request: Request): boolean {
    const authHeader = request.headers.get("Authorization");
    const gatekeeperHeader = request.headers.get("X-Gatekeeper-Token");

    if (this.env.GATEKEEPER_SECRET) {
      if (gatekeeperHeader === this.env.GATEKEEPER_SECRET) {
        return true;
      }
      if (authHeader && authHeader === `Bearer ${this.env.GATEKEEPER_SECRET}`) {
        return true;
      }
      return false;
    }

    // Greenfield development fallback: allow if no secret configured
    return true;
  }

  public async executeQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    await this.ensureInit();
    const cursor = this.state.storage.sql.exec(sql, ...params);
    return [...cursor] as Record<string, unknown>[];
  }

  public async getMcpSchema(): Promise<{ tools: McpToolSchema[] }> {
    await this.ensureInit();

    // Introspect table schema for autoMcpV2 tool wrapping
    const tablesCursor = this.state.storage.sql.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );
    const tables = [...tablesCursor].map((t) => String((t as Record<string, unknown>).name));

    const tools: McpToolSchema[] = [
      {
        name: "facet_query",
        description: `Execute read-only SQL queries against this MicroApp DO facet. Available tables: ${tables.join(", ")}`,
        parameters: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "The SQL SELECT statement to execute",
            },
          },
          required: ["sql"],
        },
      },
      {
        name: "facet_put_record",
        description: "Insert or update a JSON document in a specified collection inside this MicroApp DO facet",
        parameters: {
          type: "object",
          properties: {
            collection: { type: "string", description: "Target collection name" },
            id: { type: "string", description: "Record primary key" },
            data: { type: "object", description: "JSON payload object" },
          },
          required: ["collection", "id", "data"],
        },
      },
    ];

    return { tools };
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInit();

    if (!this.verifyGatekeeperAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid Gatekeeper Token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);

    // Endpoint: /mcp (Model Context Protocol inspection)
    if (url.pathname.endsWith("/mcp")) {
      const schema = await this.getMcpSchema();
      return new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Endpoint: /facet/query
    if (url.pathname.endsWith("/facet/query") && request.method === "POST") {
      try {
        const body = (await request.json()) as { sql: string; params?: unknown[] };
        if (!body.sql || typeof body.sql !== "string") {
          return new Response(JSON.stringify({ error: "Missing SQL statement" }), { status: 400 });
        }
        const results = await this.executeQuery(body.sql, body.params ?? []);
        return new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Endpoint: /facet/records
    if (url.pathname.endsWith("/facet/records") && request.method === "POST") {
      try {
        const body = (await request.json()) as { id: string; collection: string; data: unknown };
        const now = new Date().toISOString();
        this.state.storage.sql.exec(
          `INSERT INTO facet_records (id, collection, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             collection = excluded.collection,
             data_json = excluded.data_json,
             updated_at = excluded.updated_at`,
          body.id,
          body.collection,
          JSON.stringify(body.data),
          now,
          now
        );
        return new Response(JSON.stringify({ success: true, id: body.id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ status: "ok", name: "MicroAppDO" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

import { generateMcpHandlerForGadget } from "../engine/AutoMcpFactory";

export class MicroAppDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const gadgetId = this.ctx.id.toString(); // Resolved via Tier-3 naming

    // 1. Route: Inbound Workspace Events (Ingestion)
    if (url.pathname === "/events/ingest") {
      const event = await request.json() as { type: string; filePath: string; content: string };
      await this.processWorkspaceChange(event);
      return new Response(JSON.stringify({ ok: true }));
    }

    // 2. Route: Stateless MCP v2 Endpoint
    if (url.pathname === "/mcp") {
      const handler = generateMcpHandlerForGadget(gadgetId, this.ctx.storage);
      return handler(request);
    }

    // 3. Fallback: Standard Micro-App UI/API (T1/T2)
    return new Response("Not Found", { status: 404 });
  }

  private async processWorkspaceChange(event: any) {
    // 1. Identify File Type (Code vs Data)
    // 2. Run Parser (Wasm Tree-sitter or CSV Stream)
    // 3. Perform atomic upsert into private DO Facet SQLite
    console.log(`Indexing ${event.filePath}...`);
  }
}
}
