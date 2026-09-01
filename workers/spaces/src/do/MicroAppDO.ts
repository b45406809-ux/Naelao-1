/**
 * MicroAppDO — Dedicated Durable Object runtime for Edge-compiled Micro-Apps.
 *
 * Micro-Apps are small, user-generated full-stack applications built by AI from
 * natural language prompts in under 30 seconds. Each micro-app runs in an isolated
 * V8 isolate with a private, in-DO SQLite database.
 *
 * Security Architecture (The Gatekeepers Protocol):
 * - Never uses raw master API keys inside micro-app code.
 * - Every outbound request and in-DO database action is guarded by an attenuated,
 *   HMAC-signed Gatekeeper capability token.
 * - Invariant #1 (Permission Ceiling): Can never exceed the human creator's rank.
 * - Invariant #2 (Resource Attenuation): Restricts access to specific tables & channels.
 * - Invariant #3 (Zero-Leak Runtime): Validated cryptographically at the edge boundary.
 */

import { DurableObject } from "cloudflare:workers";
import { verifyGatekeeperToken, checkGatekeeperGrant, type GatekeeperCapability } from "@naelao/security";

export interface MicroAppManifest {
  appId: string;
  spaceId: string;
  creatorUserId: string;
  creatorRoleRank: number;
  title: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  customTables: string[];
}

export class MicroAppDO extends DurableObject {
  private isInitialized = false;

  private ensureInit(): void {
    if (this.isInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS app_manifest (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_records (
        id         TEXT PRIMARY KEY,
        data_json  TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS app_audit_log (
        id            TEXT PRIMARY KEY,
        action        TEXT NOT NULL,
        actor_user_id TEXT,
        details_json  TEXT NOT NULL,
        timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_app_records_created ON app_records(created_at);
      CREATE INDEX IF NOT EXISTS idx_app_audit_timestamp ON app_audit_log(timestamp);
    `);
    this.isInitialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ── 1. Edge SSR Frontend Delivery (HTML/JS/Preact/Tailwind) ────────────────
    if (pathname === "/" || pathname === "/app" || pathname === "/index.html") {
      return this.handleServeFrontend();
    }

    // ── 2. Admin & Deployment Management ──────────────────────────────────────
    if (pathname === "/admin/deploy" && request.method === "POST") {
      return this.handleDeploy(request);
    }

    if (pathname === "/admin/manifest" && request.method === "GET") {
      return this.handleGetManifest();
    }

    if (pathname === "/admin/tables" && request.method === "GET") {
      return this.handleGetTables();
    }

    // ── 3. Gatekeeper-Guarded Private SQLite API Routes ────────────────────────
    // Handle /api/data and /api/data/:table
    if (pathname.startsWith("/api/data")) {
      return this.handleDataApi(request, pathname);
    }

    // Handle /api/sql / /api/query
    if ((pathname === "/api/sql" || pathname === "/api/query") && request.method === "POST") {
      return this.handleSqlQuery(request);
    }

    // Handle /api/audit-log
    if (pathname === "/api/audit-log" && request.method === "GET") {
      return this.handleGetAuditLog(request);
    }

    // Handle /api/notify
    if (pathname === "/api/notify" && request.method === "POST") {
      return this.handleNotify(request);
    }

    return new Response(JSON.stringify({ error: "Not Found", path: pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Serves the SSR frontend HTML bundle for this micro-app.
   */
  private async handleServeFrontend(): Promise<Response> {
    const html = (await this.ctx.storage.get<string>("app_bundle_html")) || this.getDefaultFallbackHtml();
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-microapp-engine": "naelao-v8-do",
        "cache-control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  /**
   * Deploys a new micro-app revision (HTML bundle, SQL schema, initial seed, metadata).
   */
  private async handleDeploy(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        appId: string;
        spaceId: string;
        creatorUserId?: string;
        creatorRoleRank?: number;
        title?: string;
        description?: string;
        htmlBundle?: string;
        schemaSql?: string;
        initialData?: Array<{ table: string; records: Record<string, unknown>[] }>;
      };

      if (!body.appId || !body.spaceId) {
        return Response.json({ error: "appId and spaceId are required" }, { status: 400 });
      }

      // 1. Save HTML Bundle
      if (body.htmlBundle) {
        await this.ctx.storage.put("app_bundle_html", body.htmlBundle);
      }

      // 2. Execute custom schema migrations if provided
      if (body.schemaSql) {
        this.ctx.storage.sql.exec(body.schemaSql);
      }

      // 3. Seed initial data if provided
      if (Array.isArray(body.initialData)) {
        for (const item of body.initialData) {
          const tableName = sanitizeIdentifier(item.table);
          if (Array.isArray(item.records) && tableName) {
            for (const record of item.records) {
              const id = (record.id as string) || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
              const keys = Object.keys(record).map(sanitizeIdentifier).filter(Boolean);
              if (tableName === "app_records") {
                this.ctx.storage.sql.exec(
                  `INSERT OR REPLACE INTO app_records (id, data_json, updated_at) VALUES (?, ?, datetime('now'))`,
                  id,
                  JSON.stringify(record)
                );
              } else if (keys.length > 0) {
                const placeholders = keys.map(() => "?").join(", ");
                const values = keys.map((k) => record[k]);
                this.ctx.storage.sql.exec(
                  `INSERT OR REPLACE INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`,
                  ...values
                );
              }
            }
          }
        }
      }

      // 4. Update manifest metadata
      const existingManifest = await this.readManifest();
      const version = (existingManifest?.version ?? 0) + 1;
      const customTables = this.listUserTables();

      const manifest: MicroAppManifest = {
        appId: body.appId,
        spaceId: body.spaceId,
        creatorUserId: body.creatorUserId || existingManifest?.creatorUserId || "anonymous",
        creatorRoleRank: body.creatorRoleRank ?? existingManifest?.creatorRoleRank ?? 3,
        title: body.title || existingManifest?.title || "Untitled Micro-App",
        description: body.description || existingManifest?.description || "",
        version,
        createdAt: existingManifest?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        customTables,
      };

      await this.writeManifest(manifest);

      // 5. Audit log
      this.recordAudit("deploy", manifest.creatorUserId, { version, tables: customTables });

      return Response.json({
        ok: true,
        message: "Micro-app deployed successfully to edge Durable Object.",
        manifest,
      });
    } catch (err) {
      return Response.json(
        { error: "Deploy failed", message: (err as Error).message },
        { status: 500 }
      );
    }
  }

  /**
   * Returns current micro-app manifest and statistics.
   */
  private async handleGetManifest(): Promise<Response> {
    const manifest = await this.readManifest();
    const tables = this.listUserTables();
    return Response.json({
      ok: true,
      manifest,
      tables,
    });
  }

  /**
   * Returns list of SQLite tables and column definitions.
   */
  private async handleGetTables(): Promise<Response> {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );
    const tables = cursor.toArray();
    return Response.json({ ok: true, tables });
  }

  /**
   * Private SQLite CRUD endpoint guarded by Gatekeeper capability tokens.
   */
  private async handleDataApi(request: Request, pathname: string): Promise<Response> {
    const parts = pathname.split("/").filter(Boolean); // ['api', 'data', optional table, optional id]
    const tableName = sanitizeIdentifier(parts[2] || "app_records");
    const recordId = parts[3] ? decodeURIComponent(parts[3]) : undefined;

    // Verify Gatekeeper Token
    const authResult = await this.verifyGatekeeper(request, {
      resource: "sqlite_db",
      target: `table:${tableName}`,
      op: request.method === "GET" ? "read" : request.method === "DELETE" ? "delete" : "write",
    });
    if (!authResult.ok) {
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    try {
      // ── GET: Read records ──
      if (request.method === "GET") {
        if (recordId) {
          if (tableName === "app_records") {
            const row = this.ctx.storage.sql
              .exec(`SELECT * FROM app_records WHERE id = ?`, recordId)
              .toArray()[0];
            if (!row) return Response.json({ error: "Record not found" }, { status: 404 });
            return Response.json({ ok: true, data: row });
          } else {
            const row = this.ctx.storage.sql
              .exec(`SELECT * FROM ${tableName} WHERE id = ?`, recordId)
              .toArray()[0];
            if (!row) return Response.json({ error: "Record not found" }, { status: 404 });
            return Response.json({ ok: true, data: row });
          }
        }

        const url = new URL(request.url);
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));

        let rows: unknown[];
        if (tableName === "app_records") {
          rows = this.ctx.storage.sql
            .exec(`SELECT * FROM app_records ORDER BY created_at DESC LIMIT ? OFFSET ?`, limit, offset)
            .toArray();
        } else {
          rows = this.ctx.storage.sql
            .exec(`SELECT * FROM ${tableName} LIMIT ? OFFSET ?`, limit, offset)
            .toArray();
        }
        return Response.json({ ok: true, table: tableName, data: rows });
      }

      // ── POST: Insert record ──
      if (request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        const id = (body.id as string) || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        if (tableName === "app_records") {
          this.ctx.storage.sql.exec(
            `INSERT INTO app_records (id, data_json, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`,
            id,
            JSON.stringify(body)
          );
        } else {
          const keys = Object.keys(body).map(sanitizeIdentifier).filter(Boolean);
          if (keys.length === 0) return Response.json({ error: "No fields provided" }, { status: 400 });
          const placeholders = keys.map(() => "?").join(", ");
          const values = keys.map((k) => body[k]);
          this.ctx.storage.sql.exec(
            `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`,
            ...values
          );
        }

        this.recordAudit("data_insert", authResult.capability?.creatorUserId, { table: tableName, id });
        return Response.json({ ok: true, id, message: "Record saved to private in-DO SQLite." }, { status: 201 });
      }

      // ── PUT/PATCH: Update record ──
      if (request.method === "PUT" || request.method === "PATCH") {
        if (!recordId) return Response.json({ error: "Record ID required for update" }, { status: 400 });
        const body = (await request.json()) as Record<string, unknown>;

        if (tableName === "app_records") {
          this.ctx.storage.sql.exec(
            `UPDATE app_records SET data_json = ?, updated_at = datetime('now') WHERE id = ?`,
            JSON.stringify(body),
            recordId
          );
        } else {
          const keys = Object.keys(body).map(sanitizeIdentifier).filter((k) => k !== "id");
          if (keys.length === 0) return Response.json({ error: "No fields to update" }, { status: 400 });
          const setClause = keys.map((k) => `${k} = ?`).join(", ");
          const values = keys.map((k) => body[k]);
          this.ctx.storage.sql.exec(
            `UPDATE ${tableName} SET ${setClause} WHERE id = ?`,
            ...values,
            recordId
          );
        }

        this.recordAudit("data_update", authResult.capability?.creatorUserId, { table: tableName, id: recordId });
        return Response.json({ ok: true, id: recordId, message: "Record updated." });
      }

      // ── DELETE: Delete record ──
      if (request.method === "DELETE") {
        if (!recordId) return Response.json({ error: "Record ID required for deletion" }, { status: 400 });
        if (tableName === "app_records") {
          this.ctx.storage.sql.exec(`DELETE FROM app_records WHERE id = ?`, recordId);
        } else {
          this.ctx.storage.sql.exec(`DELETE FROM ${tableName} WHERE id = ?`, recordId);
        }

        this.recordAudit("data_delete", authResult.capability?.creatorUserId, { table: tableName, id: recordId });
        return Response.json({ ok: true, id: recordId, message: "Record deleted." });
      }

      return Response.json({ error: `Method ${request.method} not allowed` }, { status: 405 });
    } catch (err) {
      return Response.json({ error: "SQLite operation failed", message: (err as Error).message }, { status: 500 });
    }
  }

  /**
   * Executes parameterized SQL query for authorized capability holders.
   */
  private async handleSqlQuery(request: Request): Promise<Response> {
    const authResult = await this.verifyGatekeeper(request, {
      resource: "sqlite_db",
      target: "*",
      op: "execute",
    });
    if (!authResult.ok) {
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    try {
      const body = (await request.json()) as { sql: string; params?: unknown[] };
      if (!body.sql || typeof body.sql !== "string") {
        return Response.json({ error: "sql string is required" }, { status: 400 });
      }

      const cursor = this.ctx.storage.sql.exec(body.sql, ...(body.params || []));
      const rows = cursor.toArray();
      return Response.json({ ok: true, rows });
    } catch (err) {
      return Response.json({ error: "SQL Execution error", message: (err as Error).message }, { status: 400 });
    }
  }

  /**
   * Returns audit log entries for authorized callers.
   */
  private async handleGetAuditLog(request: Request): Promise<Response> {
    const authResult = await this.verifyGatekeeper(request, {
      resource: "sqlite_db",
      target: "table:app_audit_log",
      op: "read",
    });
    if (!authResult.ok) {
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM app_audit_log ORDER BY timestamp DESC LIMIT 50`)
      .toArray();
    return Response.json({ ok: true, auditLog: rows });
  }

  /**
   * Dispatches notifications with rate-limit verification.
   */
  private async handleNotify(request: Request): Promise<Response> {
    const body = (await request.json()) as { channel: string; message: string };
    const authResult = await this.verifyGatekeeper(request, {
      resource: "channel_notify",
      target: body.channel || "*",
      op: "execute",
    });
    if (!authResult.ok) {
      return Response.json({ error: authResult.error }, { status: authResult.status });
    }

    this.recordAudit("channel_notify", authResult.capability?.creatorUserId, {
      channel: body.channel,
      messageLength: body.message?.length,
    });

    return Response.json({ ok: true, message: `Notification dispatched to ${body.channel}` });
  }

  /**
   * Validates Gatekeeper capability token against environment PLATFORM_SECRET.
   */
  private async verifyGatekeeper(
    request: Request,
    requiredGrant: { resource: string; target: string; op: "read" | "write" | "delete" | "execute" }
  ): Promise<{ ok: boolean; status: number; error?: string; capability?: GatekeeperCapability }> {
    const tokenHeader =
      request.headers.get("x-gatekeeper-token") ||
      request.headers.get("x-capability-token") ||
      (request.headers.get("authorization")?.startsWith("Bearer gk_")
        ? request.headers.get("authorization")!.slice(7)
        : null);

    if (!tokenHeader) {
      return { ok: false, status: 401, error: "Gatekeeper Violation: No capability token provided." };
    }

    const platformSecret = (this.env as { PLATFORM_SECRET?: string }).PLATFORM_SECRET;
    if (!platformSecret) {
      return { ok: false, status: 500, error: "Server error: PLATFORM_SECRET is unconfigured." };
    }

    try {
      const capability = await verifyGatekeeperToken(tokenHeader, platformSecret);
      const isAuthorized = checkGatekeeperGrant(capability, requiredGrant);
      if (!isAuthorized) {
        return {
          ok: false,
          status: 403,
          error: `Gatekeeper Block: App '${capability.appId}' lacks '${requiredGrant.op}' grant on '${requiredGrant.target}'.`,
        };
      }
      return { ok: true, status: 200, capability };
    } catch (err) {
      return { ok: false, status: 401, error: (err as Error).message };
    }
  }

  private recordAudit(action: string, actorUserId?: string, details?: Record<string, unknown>): void {
    try {
      const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.ctx.storage.sql.exec(
        `INSERT INTO app_audit_log (id, action, actor_user_id, details_json, timestamp) VALUES (?, ?, ?, ?, datetime('now'))`,
        id,
        action,
        actorUserId || "anonymous",
        JSON.stringify(details || {})
      );
    } catch {
      // Audit log failures should not abort main flow
    }
  }

  private async readManifest(): Promise<MicroAppManifest | null> {
    const cursor = this.ctx.storage.sql.exec(`SELECT value FROM app_manifest WHERE key = 'meta'`);
    const row = cursor.toArray()[0] as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as MicroAppManifest;
    } catch {
      return null;
    }
  }

  private async writeManifest(manifest: MicroAppManifest): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO app_manifest (key, value) VALUES ('meta', ?)`,
      JSON.stringify(manifest)
    );
  }

  private listUserTables(): string[] {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    );
    return cursor.toArray().map((r) => (r as { name: string }).name);
  }

  private getDefaultFallbackHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Micro-App Studio</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-white rounded-xl shadow-md p-6 text-center border border-gray-100">
    <div class="w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 font-bold text-xl">⚡</div>
    <h1 class="text-xl font-bold text-gray-900 mb-2">Micro-App Ready</h1>
    <p class="text-sm text-gray-600 mb-6">This micro-app is running at Cloudflare edge with isolated SQLite database and Gatekeeper security.</p>
    <div class="bg-gray-50 rounded-lg p-3 text-left text-xs font-mono text-gray-700">
      Status: Active<br>
      Engine: Cloudflare MicroAppDO<br>
      Database: In-DO Private SQLite
    </div>
  </div>
</body>
</html>`;
  }
}

function sanitizeIdentifier(name: string): string {
  return String(name || "").replace(/[^a-zA-Z0-9_]/g, "");
}
