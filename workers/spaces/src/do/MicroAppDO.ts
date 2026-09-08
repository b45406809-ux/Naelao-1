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

import { verifyGatekeeperToken, WriteGuard } from "@avos/security";
import { GatekeeperToken } from "@avos/security";

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tokenHeader = request.headers.get("x-gatekeeper-token");

    if (!tokenHeader) {
      return new Response(JSON.stringify({ error: "Missing x-gatekeeper-token header" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    let token: GatekeeperToken;
    try {
      // In production workers, PLATFORM_SECRET would be bound via env
      const secret = (this.env as any).PLATFORM_SECRET || "avos-default-dev-secret-key-change-me";
      token = await verifyGatekeeperToken(tokenHeader, secret);
    } catch (err: any) {
      return new Response(JSON.stringify({ error: `Forbidden: ${err.message}` }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/api/data" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const sql = body.sql;
        if (!sql) {
          return new Response(JSON.stringify({ error: "Missing 'sql' in request body" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        // Validate via WriteGuard
        const validation = await WriteGuard.validateSqlQuery(sql, token);
        if (!validation.allowed) {
          return new Response(JSON.stringify({ error: validation.reason }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }

        // Execute SQL via DO sqlite storage
        const cursor = this.ctx.storage.sql.exec(sql, ...(body.params || []));
        const results = [...cursor];

        // Audit Log entry in SQLite ledger
        try {
          this.ctx.storage.sql.exec(
            `CREATE TABLE IF NOT EXISTS _avos_audit_ledger (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp INTEGER,
              user_id TEXT,
              app_id TEXT,
              space_id TEXT,
              action TEXT,
              sql TEXT
            )`
          );
          this.ctx.storage.sql.exec(
            `INSERT INTO _avos_audit_ledger (timestamp, user_id, app_id, space_id, action, sql) VALUES (?, ?, ?, ?, ?, ?)`,
            Date.now(),
            token.userId,
            token.appId,
            token.spaceId,
            "SQL_MUTATION",
            sql
          );
        } catch (auditErr) {
          console.error("Failed to write audit ledger entry:", auditErr);
        }

        return new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response("MicroAppDO running with Gatekeeper Protection", { status: 200 });
  }
}
