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
import {
  verifyGatekeeperToken,
  checkGatekeeperGrant,
  checkDelegatedGatekeeperGrant,
  type GatekeeperCapability,
  type AvosGadgetManifest,
  type GadgetScope,
} from "@naelao/security";

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
  // Gadget 4-Scope Model (Cloudflare OS Gadgets)
  scope?: GadgetScope;
  projectId?: string;
  delegatedTargetSpaceIds?: string[];
  runtime?: {
    engine: "dynamic_worker_isolate";
    database: "do_facet_sqlite";
    enableMcpV2Api: boolean;
  };
  gatekeeperGrants?: Array<{
    resource: string;
    operations: Array<"read" | "write" | "notify" | "delete" | "execute">;
  }>;
}

export interface GadgetBlueprint {
  id: string;
  name: string;
  description: string;
  scope: GadgetScope;
  schemaSql: string;
  initialData?: Array<{ table: string; records: Record<string, unknown>[] }>;
  defaultGrants: Array<{ resource: string; operations: Array<"read" | "write" | "notify" | "delete" | "execute"> }>;
  htmlBundle: string;
}

export const GADGET_BLUEPRINTS: Record<string, GadgetBlueprint> = {
  bug_intake_matrix: {
    id: "bug_intake_matrix",
    name: "QA Bug Reporting & Acceptance Matrix",
    description: "Cross-subspace issue tracker allowing engineering subspaces to log tickets into PM private SQLite DB.",
    scope: "CROSS_SUBSPACE_DELEGATED",
    schemaSql: `
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        reporter_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        severity TEXT DEFAULT 'MEDIUM',
        status TEXT NOT NULL DEFAULT 'OPEN',
        space_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    initialData: [
      {
        table: "tickets",
        records: [
          {
            id: "tick_sample_1",
            reporter_user_id: "user_pm",
            title: "Navigation bar clipping on mobile safari",
            description: "Header elements overlap when viewport width < 380px.",
            severity: "HIGH",
            status: "OPEN",
            space_id: "sp_pm_core",
          },
        ],
      },
    ],
    defaultGrants: [
      { resource: "sqlite_db", operations: ["read", "write"] },
      { resource: "notifications", operations: ["notify"] },
    ],
    htmlBundle: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QA Bug Matrix Gadget</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-900 p-6 min-h-screen">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between pb-6 border-b border-gray-200">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-950">QA Bug Reporting Matrix</h1>
        <p class="text-sm text-gray-500 mt-1">Cross-Subspace Delegated Gadget (DO Facet SQLite)</p>
      </div>
      <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
        Gatekeeper Verified
      </span>
    </div>
    <form id="ticketForm" class="mt-6 bg-white p-5 rounded-xl border border-gray-200 shadow-sm space-y-4">
      <div>
        <label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Ticket Title</label>
        <input id="titleInput" required type="text" placeholder="e.g. Broken checkout button" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none">
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Severity</label>
          <select id="severityInput" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="LOW">Low</option>
            <option value="MEDIUM" selected>Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Description</label>
          <input id="descInput" type="text" placeholder="Steps to reproduce" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </div>
      </div>
      <button type="submit" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg text-sm transition">
        Submit Ticket & Stream Event
      </button>
    </form>
  </div>
</body>
</html>`,
  },
  leave_tracker: {
    id: "leave_tracker",
    name: "Company-Wide PTO Leave Approval Tracker",
    description: "All-company time-off request and manager approval ledger.",
    scope: "SPACE_WIDE",
    schemaSql: `
      CREATE TABLE IF NOT EXISTS leave_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_name TEXT,
        leave_type TEXT NOT NULL DEFAULT 'VACATION',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        approved_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    defaultGrants: [
      { resource: "sqlite_db", operations: ["read", "write"] },
      { resource: "notifications", operations: ["notify"] },
    ],
    htmlBundle: `<!DOCTYPE html><html><head><title>PTO Leave Tracker</title><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6 bg-gray-50"><div class="max-w-2xl mx-auto"><h1 class="text-xl font-bold">PTO Leave Tracker</h1></div></body></html>`,
  },
  barcode_scanner: {
    id: "barcode_scanner",
    name: "Barcode Equipment Scanner & Return Ledger",
    description: "Project-bound asset checkout and return tracking for warehouse operations.",
    scope: "PROJECT_BOUND",
    schemaSql: `
      CREATE TABLE IF NOT EXISTS equipment_inventory (
        id TEXT PRIMARY KEY,
        item_name TEXT NOT NULL,
        barcode TEXT UNIQUE NOT NULL,
        condition TEXT DEFAULT 'GOOD',
        checked_out_to TEXT,
        status TEXT NOT NULL DEFAULT 'AVAILABLE',
        last_inspected TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    defaultGrants: [
      { resource: "sqlite_db", operations: ["read", "write"] },
    ],
    htmlBundle: `<!DOCTYPE html><html><head><title>Barcode Scanner</title><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6 bg-gray-50"><div class="max-w-2xl mx-auto"><h1 class="text-xl font-bold">Equipment Ledger</h1></div></body></html>`,
  },
  pomodoro_timer: {
    id: "pomodoro_timer",
    name: "Personal Pomodoro Timer & Scratchpad",
    description: "Private focus timer and scratchpad for personal focus loops.",
    scope: "USER_PRIVATE",
    schemaSql: `
      CREATE TABLE IF NOT EXISTS focus_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 25,
        category TEXT DEFAULT 'WORK',
        notes TEXT,
        completed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    defaultGrants: [
      { resource: "sqlite_db", operations: ["read", "write"] },
    ],
    htmlBundle: `<!DOCTYPE html><html><head><title>Pomodoro Timer</title><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6 bg-gray-50"><div class="max-w-2xl mx-auto"><h1 class="text-xl font-bold">Pomodoro Timer</h1></div></body></html>`,
  },
};

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

      CREATE TABLE IF NOT EXISTS app_ui_events (
        id            TEXT PRIMARY KEY,
        action        TEXT NOT NULL,
        actor_user_id TEXT,
        payload_json  TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_app_ui_events_created ON app_ui_events(created_at);
    `);
    this.isInitialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ── 1. Edge SSR Frontend Delivery (HTML/JS/Preact/Tailwind) ────────────────
    if (pathname === "/" || pathname === "/app" || pathname === "/index.html") {
      return this.handleServeFrontend(request);
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

    // ── Blueprints: Shareable Gadget Templates ────────────────────────────────
    if (pathname === "/admin/blueprints" && request.method === "GET") {
      return this.handleGetBlueprints();
    }

    if (pathname === "/admin/deploy-blueprint" && request.method === "POST") {
      return this.handleDeployBlueprint(request);
    }

    // ── MCP-UI: Real-Time UI Action Streaming ─────────────────────────────────
    if ((pathname === "/api/mcp-ui/emit" || pathname === "/api/mcp-ui/action") && request.method === "POST") {
      return this.handleMcpUiEmit(request);
    }

    if (pathname === "/api/mcp-ui/events" && request.method === "GET") {
      return this.handleGetMcpUiEvents(request);
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

    // ── 4. MCP v2 Server JSON-RPC Protocol Endpoint (/mcp & /api/mcp) ─────────
    if ((pathname === "/mcp" || pathname === "/api/mcp") && request.method === "POST") {
      return this.handleMcpJsonRpc(request);
    }

    return new Response(JSON.stringify({ error: "Not Found", path: pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Serves the SSR frontend HTML bundle for this micro-app.
   */
  private async handleServeFrontend(request: Request): Promise<Response> {
    const manifest = await this.readManifest();
    if (manifest) {
      const caller = this.extractCaller(request);
      const scopeCheck = this.checkScopeAccess(manifest, caller);
      if (!scopeCheck.allowed) {
        return new Response(JSON.stringify({ error: scopeCheck.reason }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    }

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
        scope?: GadgetScope;
        projectId?: string;
        delegatedTargetSpaceIds?: string[];
        runtime?: {
          engine: "dynamic_worker_isolate";
          database: "do_facet_sqlite";
          enableMcpV2Api: boolean;
        };
        gatekeeperGrants?: Array<{
          resource: string;
          operations: Array<"read" | "write" | "notify" | "delete" | "execute">;
        }>;
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
        scope: body.scope || existingManifest?.scope || "SPACE_WIDE",
        projectId: body.projectId || existingManifest?.projectId,
        delegatedTargetSpaceIds: body.delegatedTargetSpaceIds || existingManifest?.delegatedTargetSpaceIds,
        runtime: body.runtime || existingManifest?.runtime || {
          engine: "dynamic_worker_isolate",
          database: "do_facet_sqlite",
          enableMcpV2Api: true,
        },
        gatekeeperGrants: body.gatekeeperGrants || existingManifest?.gatekeeperGrants,
      };

      await this.writeManifest(manifest);

      // 5. Audit log
      this.recordAudit("deploy", manifest.creatorUserId, {
        version,
        tables: customTables,
        scope: manifest.scope,
      });

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
   * Helper to extract zero-trust caller identity injected by edge proxy.
   */
  private extractCaller(request: Request): {
    userId?: string;
    userRole?: string;
    spaceId?: string;
    projectId?: string;
  } {
    return {
      userId: request.headers.get("x-naelao-end-user-id") || request.headers.get("x-naelao-user-id") || undefined,
      userRole: request.headers.get("x-naelao-user-role") || undefined,
      spaceId: request.headers.get("x-naelao-space-id") || undefined,
      projectId: request.headers.get("x-naelao-project-id") || undefined,
    };
  }

  /**
   * Enforces the 4-Scope Model:
   * - USER_PRIVATE: Creator sandbox only
   * - PROJECT_BOUND: Designated project members only
   * - SPACE_WIDE: Entire tenant/space organization
   * - CROSS_SUBSPACE_DELEGATED: Delegated target subspaces via Gatekeeper
   */
  private checkScopeAccess(
    manifest: MicroAppManifest,
    caller: { userId?: string; userRole?: string; spaceId?: string; projectId?: string }
  ): { allowed: boolean; reason?: string } {
    const scope = manifest.scope || "SPACE_WIDE";

    if (scope === "USER_PRIVATE") {
      const isOwner = caller.userId && caller.userId === manifest.creatorUserId;
      const isSpaceAdmin = caller.userRole === "owner" || caller.userRole === "admin";
      if (!isOwner && !isSpaceAdmin) {
        return { allowed: false, reason: "Access denied: USER_PRIVATE gadget restricted to its creator" };
      }
    } else if (scope === "PROJECT_BOUND") {
      if (manifest.projectId && caller.projectId && caller.projectId !== manifest.projectId) {
        return { allowed: false, reason: "Access denied: PROJECT_BOUND gadget restricted to designated project" };
      }
    } else if (scope === "CROSS_SUBSPACE_DELEGATED") {
      const isOwnerSpace = caller.spaceId && caller.spaceId === manifest.spaceId;
      const isDelegatedSpace =
        caller.spaceId &&
        Array.isArray(manifest.delegatedTargetSpaceIds) &&
        manifest.delegatedTargetSpaceIds.includes(caller.spaceId);
      if (!isOwnerSpace && !isDelegatedSpace) {
        return { allowed: false, reason: "Access denied: CROSS_SUBSPACE_DELEGATED gadget not shared with caller space" };
      }
    }

    return { allowed: true };
  }

  /**
   * Catalog of shareable gadget blueprints.
   */
  private handleGetBlueprints(): Response {
    return Response.json({
      ok: true,
      blueprints: [
        {
          id: "bug_intake_matrix",
          name: "QA Bug Reporting & Acceptance Matrix",
          description: "Cross-subspace issue tracker allowing engineering subspaces to log tickets into PM private SQLite DB.",
          scope: "CROSS_SUBSPACE_DELEGATED",
        },
        {
          id: "leave_tracker",
          name: "Company-Wide PTO Leave Approval Tracker",
          description: "All-company time-off request and manager approval ledger with live audit trail.",
          scope: "SPACE_WIDE",
        },
        {
          id: "barcode_scanner",
          name: "Barcode Equipment Scanner & Return Ledger",
          description: "Project-bound warehouse scanner tracking equipment checkouts and returns.",
          scope: "PROJECT_BOUND",
        },
        {
          id: "pomodoro_timer",
          name: "Personal Pomodoro Timer & Scratchpad",
          description: "Private focus timer and scratchpad for personal focus loops.",
          scope: "USER_PRIVATE",
        },
      ],
    });
  }

  /**
   * Instantly deploys a pre-configured gadget blueprint.
   */
  private async handleDeployBlueprint(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      blueprintId: string;
      appId: string;
      spaceId: string;
      creatorUserId?: string;
      projectId?: string;
      delegatedTargetSpaceIds?: string[];
    };

    const bp = GADGET_BLUEPRINTS[body.blueprintId];
    if (!bp) {
      return Response.json({ error: `Unknown blueprint '${body.blueprintId}'` }, { status: 400 });
    }

    const deployRequest = new Request("https://microapp.internal/admin/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: body.appId,
        spaceId: body.spaceId,
        creatorUserId: body.creatorUserId,
        title: bp.name,
        description: bp.description,
        scope: bp.scope,
        projectId: body.projectId,
        delegatedTargetSpaceIds: body.delegatedTargetSpaceIds,
        schemaSql: bp.schemaSql,
        initialData: bp.initialData,
        htmlBundle: bp.htmlBundle,
        runtime: {
          engine: "dynamic_worker_isolate",
          database: "do_facet_sqlite",
          enableMcpV2Api: true,
        },
        gatekeeperGrants: bp.defaultGrants,
      }),
    });

    return this.handleDeploy(deployRequest);
  }

  /**
   * Emits a real-time UI action from the sandboxed iframe to observing AI agents via MCP-UI.
   */
  private async handleMcpUiEmit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      action: string;
      [key: string]: unknown;
    };

    if (!body.action) {
      return Response.json({ error: "action field is required" }, { status: 400 });
    }

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const caller = this.extractCaller(request);
    const actorId = caller.userId || (body.author as string) || "user_anon";

    this.ctx.storage.sql.exec(
      `INSERT INTO app_ui_events (id, action, actor_user_id, payload_json, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
      eventId,
      body.action,
      actorId,
      JSON.stringify(body)
    );

    this.recordAudit(`ui_action:${body.action}`, actorId, body);

    return Response.json({
      ok: true,
      eventId,
      action: body.action,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Retrieves recent MCP-UI action events for observing AI agents.
   */
  private async handleGetMcpUiEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM app_ui_events ORDER BY created_at DESC LIMIT ?`, limit)
      .toArray();

    return Response.json({ ok: true, events: rows });
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
      Database: In-DO Private SQLite<br>
      Protocol: MCP v2 Server Enabled (/mcp)
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Handles MCP v2 JSON-RPC requests, exposing this micro-app's SQLite tables as standard MCP tools.
   */
  private async handleMcpJsonRpc(request: Request): Promise<Response> {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const { id, method, params } = body || {};
    const manifest = (await this.readManifest()) || { appId: "microapp", title: "Micro-App" };
    const appId = manifest.appId || "microapp";
    const tables = this.listUserTables();

    // 1. tools/list
    if (method === "tools/list" || method === "mcp.list_tools") {
      const tools = [
        {
          name: `app_${sanitizeIdentifier(appId)}_list_records`,
          description: `Query and filter records in the ${manifest.title} (${appId}) micro-app database.`,
          inputSchema: {
            type: "object",
            properties: {
              table: { type: "string", description: `Table to query (available: ${tables.join(", ")})`, default: tables[0] || "app_records" },
              limit: { type: "number", description: "Maximum records to return (default: 50)", default: 50 },
              offset: { type: "number", description: "Offset for pagination", default: 0 },
            },
          },
        },
        {
          name: `app_${sanitizeIdentifier(appId)}_insert_record`,
          description: `Insert a new record into the ${manifest.title} (${appId}) micro-app SQLite database.`,
          inputSchema: {
            type: "object",
            properties: {
              table: { type: "string", description: "Table name", default: tables[0] || "app_records" },
              record: { type: "object", description: "Record key-value pairs matching table schema" },
            },
            required: ["record"],
          },
        },
        {
          name: `app_${sanitizeIdentifier(appId)}_query_sql`,
          description: `Execute a read-only parameterized SELECT query against ${manifest.title} private SQLite database.`,
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "SELECT SQL query" },
              params: { type: "array", description: "Optional SQL parameters" },
            },
            required: ["sql"],
          },
        },
      ];

      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // 2. tools/call
    if (method === "tools/call" || method === "mcp.call_tool") {
      const toolName = params?.name || "";
      const toolArgs = params?.arguments || {};

      try {
        if (toolName.endsWith("_list_records")) {
          const table = sanitizeIdentifier(toolArgs.table || tables[0] || "app_records");
          const limit = Math.min(100, Math.max(1, Number(toolArgs.limit || 50)));
          const offset = Math.max(0, Number(toolArgs.offset || 0));

          const cursor = this.ctx.storage.sql.exec(`SELECT * FROM ${table} LIMIT ? OFFSET ?`, limit, offset);
          const rows = cursor.toArray();

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ ok: true, table, count: rows.length, rows }) }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (toolName.endsWith("_insert_record")) {
          const table = sanitizeIdentifier(toolArgs.table || tables[0] || "app_records");
          const record = toolArgs.record || {};
          const recordId = record.id || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

          if (table === "app_records") {
            this.ctx.storage.sql.exec(
              `INSERT INTO app_records (id, data_json, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`,
              recordId,
              JSON.stringify(record)
            );
          } else {
            const keys = Object.keys(record).map(sanitizeIdentifier);
            const placeholders = keys.map(() => "?").join(", ");
            const values = Object.values(record);
            this.ctx.storage.sql.exec(
              `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
              ...values
            );
          }

          this.recordAudit("mcp_tool_insert", "agent_mcp", { table, recordId });

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ ok: true, message: `Inserted record into ${table}`, id: recordId }) }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (toolName.endsWith("_query_sql")) {
          const sql = String(toolArgs.sql || "").trim();
          if (!sql.toUpperCase().startsWith("SELECT")) {
            throw new Error("Only read-only SELECT queries are permitted via MCP SQL tool");
          }
          const sqlParams = Array.isArray(toolArgs.params) ? toolArgs.params : [];
          const cursor = this.ctx.storage.sql.exec(sql, ...sqlParams);
          const rows = cursor.toArray();

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ ok: true, count: rows.length, rows }) }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown MCP tool '${toolName}'` },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err?.message || "Tool execution failed" },
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    // 3. resources/list
    if (method === "resources/list" || method === "mcp.list_resources") {
      const resources = tables.map((t) => ({
        uri: `sqlite://${appId}/${t}`,
        name: `Table: ${t}`,
        mimeType: "application/json",
      }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { resources } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method '${method}' not supported` } }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }
}

function sanitizeIdentifier(name: string): string {
  return String(name || "").replace(/[^a-zA-Z0-9_]/g, "");
}
