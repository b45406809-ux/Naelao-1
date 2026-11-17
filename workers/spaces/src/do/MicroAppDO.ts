import { DurableObject } from "cloudflare:workers";
import type { GadgetActorScope, GadgetScope, GadgetTier } from "@naelao/agent-sdk";
import { signHmac, verifyHmac } from "@naelao/crypto";
import { parseBoundedInteger, readBoundedRequestBytes, RequestBodyTooLargeError, verifyInternalToken } from "@naelao/http";
import { digestExtensionManifest, validateExtensionManifest, RECEIVE_STOCK_INPUT_SCHEMA, RECEIVE_STOCK_OUTPUT_SCHEMA,
  validateBusinessActionInput, validateBusinessActionOutput, validateExtensionBusinessAction,
  type ExtensionBusinessAction, type ListLowStockInput, type ReceiveStockInput, type AdjustStockInput } from "@naelao/agent-sdk";
import { decodeMicroAppArchiveValue, encodeMicroAppArchiveValue, isMicroAppArchiveSnapshot,
  MAX_MICRO_APP_ARCHIVE_SNAPSHOT_BYTES, MAX_MICRO_APP_ARCHIVE_TABLE_ROWS, type MicroAppArchiveSnapshot } from "./microapp-archive.js";

export interface MicroAppDOEnv { PLATFORM_SECRET: string }

interface CanvasReleaseProof {
  extensionId: string;
  version: string;
  manifestJson: string;
  artifactSha256: string;
  hostSignature: string;
  canvasPath: string;
  canvasSha256: string;
  bindingSignature: string;
}

interface ExtensionSchemaUpdateClaims {
  version: 1;
  purpose: "space_shared_gadget_schema_update";
  tenantId: string;
  spaceId: string;
  installationId: string;
  extensionId: string;
  appId: string;
  fromVersion: string;
  toVersion: string;
  sourceManifestSha256: string;
  candidateManifestSha256: string;
  sourceArtifactSha256: string;
  artifactSha256: string;
  publisherKeyId: string;
  migrationsSha256: string;
  operationKey: string;
}

export const TIER_ONE_STORAGE_LIMIT_BYTES = 25 * 1024 * 1024;
/** Hard logical allocation ceilings for each gadget tier. These are platform safety limits,
 * not provider billing estimates. They bound user-written SQLite pages without promising an
 * exact Cloudflare storage charge. */
export const GADGET_STORAGE_LIMIT_BYTES: Record<GadgetTier, number> = {
  1: TIER_ONE_STORAGE_LIMIT_BYTES,
  2: 100 * 1024 * 1024,
  3: 250 * 1024 * 1024,
};
export const TIER_ONE_IDLE_TTL_MS = 14 * 86_400 * 1000;
const PUBLIC_ACTION_TTL_MS = 15 * 60 * 1000;
const MAX_BUSINESS_ACTION_RECEIPTS = 10_000;
const MAX_ARCHIVE_RESTORE_RECEIPTS = 10_000;
const GADGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LEGACY_BUSINESS_ACTION_EVENTS_SCHEMA = `CREATE TABLE gadget_business_action_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, actor_id TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity_received INTEGER NOT NULL, quantity_before INTEGER NOT NULL, quantity_after INTEGER NOT NULL,
      version_before INTEGER NOT NULL, version_after INTEGER NOT NULL, reason TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256)=64), created_at INTEGER NOT NULL,
      UNIQUE(action_id,idempotency_key_sha256)
    )`;
const LEGACY_BUSINESS_ACTION_EVENT_COLUMNS = ["action_id", "actor_id", "created_at", "id", "idempotency_key_sha256", "product_id",
  "quantity_after", "quantity_before", "quantity_received", "reason", "version_after", "version_before"] as const;
const PLATFORM_TABLES = new Set([
  "gadget_metadata",
  "gadget_schema_migrations",
  "gadget_extension_schema_update_receipts",
  "gadget_business_action_receipts",
  "gadget_business_action_events",
  "gadget_archive_restore_receipts",
  "gadget_public_pages",
  "consumed_public_action_nonces",
  "canvas_collaboration_events",
  "canvas_presence",
  "gadget_action_audit",
  "gadget_data",
]);
const ARCHIVE_PLATFORM_TABLES = ["gadget_data", "gadget_schema_migrations", "gadget_extension_schema_update_receipts",
  "gadget_business_action_receipts", "gadget_business_action_events", "gadget_action_audit", "gadget_public_pages",
  "consumed_public_action_nonces", "canvas_collaboration_events"] as const;
const ARCHIVE_REQUEST_MAX_BYTES = MAX_MICRO_APP_ARCHIVE_SNAPSHOT_BYTES + 16 * 1024;
function isGadgetId(value: unknown): value is string { return typeof value === "string" && GADGET_ID_PATTERN.test(value); }

interface PublicPageAction { key: string; fields: string[] }
interface PublicPageClaims { spaceId: string; appId: string; slug: string; action: string; key: string; fields: string[]; nonce: string; exp: number }
function pagePathPart(value: string): boolean { return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value); }
function encodeToken(value: string): string { return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function decodeToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error("invalid_public_action_token");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
}

/** The exact stable name passed to DurableObjectNamespace.idFromName. */
export function gadgetStorageKey(input: GadgetActorScope): string {
  if (!isGadgetId(input.appId)) throw new Error("invalid_gadget_app_id");
  if (!isGadgetId(input.spaceId)) throw new Error("invalid_gadget_space_id");
  if (input.scope === "SPACE_WIDE" || input.scope === "SPACE_SHARED") return `gadget:${input.appId}:space:${input.spaceId}`;
  if (input.scope === "SPACE_USER" || input.scope === "USER_PRIVATE") {
    if (!isGadgetId(input.userId)) throw new Error("invalid_gadget_user_id");
    return `gadget:${input.appId}:space:${input.spaceId}:user:${input.userId}`;
  }
  if (input.scope === "PROJECT_BOUND") {
    if (!isGadgetId(input.projectId)) throw new Error("invalid_gadget_project_id");
    return `gadget:${input.appId}:project:${input.projectId}`;
  }
  if (input.scope === "PROJECT_SHARED") {
    if (!isGadgetId(input.projectId)) throw new Error("invalid_gadget_project_id");
    return `gadget:${input.appId}:space:${input.spaceId}:project:${input.projectId}`;
  }
  if (input.scope === "PROJECT_USER") {
    if (!isGadgetId(input.projectId)) throw new Error("invalid_gadget_project_id");
    if (!isGadgetId(input.userId)) throw new Error("invalid_gadget_user_id");
    return `gadget:${input.appId}:space:${input.spaceId}:project:${input.projectId}:user:${input.userId}`;
  }
  throw new Error("invalid_gadget_scope");
}

export function gadgetActorId(namespace: Pick<DurableObjectNamespace, "idFromName">, input: GadgetActorScope): DurableObjectId {
  return namespace.idFromName(gadgetStorageKey(input));
}

function validDdl(sql: string, allowAdditiveAlter = false): string[] {
  if (sql.length > 64_000 || /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|DROP|RENAME|TRIGGER|VIEW)\b/i.test(sql) || (!allowAdditiveAlter && /\bALTER\b/i.test(sql))) throw new Error("unsafe_gadget_schema");
  const statements = sql.split(";").map((part) => part.trim()).filter(Boolean);
  if (!statements.every((statement) => /^CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_]/i.test(statement) || (allowAdditiveAlter && /^ALTER\s+TABLE\s+[a-zA-Z_][\w]*\s+ADD\s+COLUMN\s+[a-zA-Z_][\w]*\s+(?:TEXT|INTEGER|REAL|BLOB)(?:\s+NOT\s+NULL)?(?:\s+DEFAULT\s+(?:NULL|-?\d+(?:\.\d+)?|'[^']{0,256}'))?$/i.test(statement)))) throw new Error("gadget_schema_ddl_only");
  return statements;
}

/** One instance per gadget scope; no database or data can be shared across actor IDs. */
export class MicroAppDO extends DurableObject<MicroAppDOEnv> {
  private initialized = false;

  private ensureBaseSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gadget_data (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gadget_schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS gadget_public_pages (slug TEXT PRIMARY KEY, html TEXT NOT NULL, actions_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumed_public_action_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS canvas_collaboration_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_presence (actor_id TEXT PRIMARY KEY, cursor_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, operation TEXT NOT NULL, table_name TEXT NOT NULL, target_hash TEXT, created_at INTEGER NOT NULL
    );`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_business_action_receipts (
      action_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(action_id,idempotency_key)
    );`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_business_action_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, actor_id TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity_received INTEGER NOT NULL, quantity_before INTEGER NOT NULL, quantity_after INTEGER NOT NULL,
      version_before INTEGER NOT NULL, version_after INTEGER NOT NULL, reason TEXT NOT NULL,
      idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256)=64), created_at INTEGER NOT NULL,
      UNIQUE(action_id,idempotency_key_sha256)
    );`);
    const actionEventColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(gadget_business_action_events)").toArray();
    const hasActionOperation = actionEventColumns.some(column => column.name === "action_operation");
    const hasQuantityDelta = actionEventColumns.some(column => column.name === "quantity_delta");
    if (!hasActionOperation)
      this.ctx.storage.sql.exec("ALTER TABLE gadget_business_action_events ADD COLUMN action_operation TEXT NOT NULL DEFAULT 'inventory.receiveStock.v1'");
    if (!hasQuantityDelta)
      this.ctx.storage.sql.exec("ALTER TABLE gadget_business_action_events ADD COLUMN quantity_delta INTEGER NOT NULL DEFAULT 0");
    if (!hasActionOperation || !hasQuantityDelta) this.ctx.storage.sql.exec(`UPDATE gadget_business_action_events SET quantity_delta=quantity_received
      WHERE action_operation='inventory.receiveStock.v1' AND quantity_delta=0 AND quantity_received<>0`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_archive_restore_receipts (
      restore_id TEXT PRIMARY KEY, snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
      result_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
    const migrationColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(gadget_schema_migrations)").toArray();
    if (!migrationColumns.some(column => column.name === "migration_sha256"))
      this.ctx.storage.sql.exec("ALTER TABLE gadget_schema_migrations ADD COLUMN migration_sha256 TEXT NOT NULL DEFAULT ''");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gadget_extension_schema_update_receipts (
      operation_key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, installation_id TEXT NOT NULL,
      extension_id TEXT NOT NULL, app_id TEXT NOT NULL, from_version TEXT NOT NULL, to_version TEXT NOT NULL,
      source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256)=64),
      candidate_manifest_sha256 TEXT NOT NULL CHECK(length(candidate_manifest_sha256)=64),
      source_artifact_sha256 TEXT NOT NULL CHECK(length(source_artifact_sha256)=64),
      artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64), publisher_key_id TEXT NOT NULL CHECK(length(publisher_key_id)=64),
      migrations_sha256 TEXT NOT NULL CHECK(length(migrations_sha256)=64), applied_at TEXT NOT NULL
    )`);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 4 * 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureBaseSchema();
    const url = new URL(request.url);
    if (this.metadata("product_user_erased") === "1" && !(request.method === "POST" && url.pathname === "/internal/erase-user"))
      return Response.json({ error_code: "micro_app_user_erased" }, { status: 410 });
    try {
      if (request.method === "POST" && url.pathname === "/internal/erase-user") return await this.eraseUserActor(request);
      if (request.method === "POST" && url.pathname === "/initialize") return await this.initialize(request);
      if (request.method === "POST" && url.pathname === "/internal/archive/export") return await this.exportArchiveSnapshot(request);
      if (request.method === "POST" && url.pathname === "/internal/archive/preview") return await this.previewArchiveRestore(request);
      if (request.method === "POST" && url.pathname === "/internal/archive/restore") return await this.applyArchiveRestore(request);
      if (request.method === "POST" && url.pathname === "/extension-schema-update") return await this.applyExtensionSchemaUpdate(request);
      if (request.method === "GET" && url.pathname === "/app") return await this.renderApp();
      if (request.method === "POST" && url.pathname === "/page/publish") return await this.publishPage(request);
      if (request.method === "GET" && url.pathname === "/page/render") return await this.renderPublicPage(url);
      if (request.method === "POST" && url.pathname === "/page/action") return await this.submitPublicAction(request, url);
      if (request.method === "GET" && url.pathname === "/api/storage") return this.readStorageUsage(request);
      if (request.method === "GET" && url.pathname === "/api/data") return this.readData(url);
      if (request.method === "POST" && url.pathname === "/api/data") return await this.writeData(request);
      if (request.method === "DELETE" && url.pathname === "/api/data") return this.deleteData(url);
      if (request.method === "GET" && url.pathname === "/business-actions") return this.readBusinessActions(request);
      if (request.method === "POST" && url.pathname.startsWith("/business-actions/")) return await this.invokeBusinessAction(request, decodeURIComponent(url.pathname.slice("/business-actions/".length)));
      if (request.method === "GET" && url.pathname === "/api/collaboration") return this.readCollaboration(url);
      if (request.method === "POST" && url.pathname === "/api/collaboration") return await this.writeCollaboration(request);
      if (request.method === "GET" && url.pathname === "/api/actions/audit") return this.readActionAudit(url);
      if (request.method === "POST" && url.pathname === "/mcp") return await this.handleMcp(request);
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "micro_app_error" }, { status: 400 });
    } finally {
      await this.refreshLifecycleAlarm();
    }
  }

  private metadata(key: string): string | undefined {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = ?", key)][0]?.value;
  }

  private gadgetTier(): GadgetTier | undefined {
    const value = Number(this.metadata("gadget_tier"));
    return value === 1 || value === 2 || value === 3 ? value : undefined;
  }

  private async refreshLifecycleAlarm(): Promise<void> {
    const tier = this.gadgetTier();
    if (tier === 1) await this.ctx.storage.setAlarm(Date.now() + TIER_ONE_IDLE_TTL_MS);
    else if (tier === 2 || tier === 3) await this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    this.ensureBaseSchema();
    if (this.gadgetTier() !== 1) return;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("deleted", true);
    this.initialized = false;
  }

  private appId(): string {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'app_id'")][0]?.value ?? "app";
  }

  private userTables(): string[] {
    return [...this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
      .map(row => row.name)
      .filter(name => !PLATFORM_TABLES.has(name));
  }

  private columns(table: string): Array<{ name: string; type: string; pk: number; notnull: number }> {
    if (!this.userTables().includes(table)) throw new Error("unknown_table");
    return [...this.ctx.storage.sql.exec<{ name: string; type: string; pk: number; notnull: number }>(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)];
  }

  private readStorageUsage(request: Request): Response {
    const pageCount = [...this.ctx.storage.sql.exec<Record<string, number>>("PRAGMA page_count")][0];
    const pageSize = [...this.ctx.storage.sql.exec<Record<string, number>>("PRAGMA page_size")][0];
    const count = Number(pageCount?.page_count ?? Object.values(pageCount ?? {})[0] ?? 0);
    const size = Number(pageSize?.page_size ?? Object.values(pageSize ?? {})[0] ?? 0);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(size) || size < 0) {
      return Response.json({ error: "storage_measurement_unavailable" }, { status: 503 });
    }
    const allocatedBytes = count * size;
    const tier = this.gadgetTier();
    const limitBytes = tier === undefined ? null : GADGET_STORAGE_LIMIT_BYTES[tier];
    let structuredDataUsage: { installationId: string; tableCount: number; rowCount: number; valueBytes: number;
      measurement: "sqlite_user_table_value_bytes" } | null = null;
    const activeInstallationId = request.headers.get("x-naelao-active-installation-id");
    if (activeInstallationId) {
      if (this.metadata("extension_installation_id") !== activeInstallationId) {
        return Response.json({ error_code: "gadget_installation_identity_mismatch" }, { status: 409 });
      }
      let tableCount = 0, rowCount = 0, valueBytes = 0;
      try {
        for (const table of this.userTables()) {
          const columns = this.columns(table).map(column => `COALESCE(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)),0)`);
          if (!columns.length) continue;
          const quotedTable = `"${table.replaceAll('"', '""')}"`;
          const totals = [...this.ctx.storage.sql.exec<{ row_count: number; value_bytes: number }>(
            `SELECT COUNT(*) AS row_count, COALESCE(SUM(${columns.join("+")}),0) AS value_bytes FROM ${quotedTable}`)][0];
          const rows = Number(totals?.row_count ?? 0), bytes = Number(totals?.value_bytes ?? 0);
          if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(bytes) || bytes < 0
            || !Number.isSafeInteger(rowCount + rows) || !Number.isSafeInteger(valueBytes + bytes)) {
            return Response.json({ error_code: "structured_data_usage_unavailable" }, { status: 503 });
          }
          tableCount++;
          rowCount += rows;
          valueBytes += bytes;
        }
      } catch {
        return Response.json({ error_code: "structured_data_usage_unavailable" }, { status: 503 });
      }
      structuredDataUsage = { installationId: activeInstallationId, tableCount, rowCount, valueBytes,
        measurement: "sqlite_user_table_value_bytes" };
    }
    return Response.json({
      appId: this.appId(),
      tier: tier ?? null,
      allocatedBytes,
      allocatedMiB: Math.round((allocatedBytes / (1024 * 1024)) * 100) / 100,
      limitBytes,
      utilizationPercent: limitBytes ? Math.round((allocatedBytes / limitBytes) * 10_000) / 100 : null,
      measurement: "sqlite_page_count_times_page_size",
      measuredAt: new Date().toISOString(),
      monthlyCostEstimateUsd: null,
      costEstimateReason: "Durable Object billing is not attributable to this gadget from SQLite page usage alone.",
      structuredDataUsage,
    });
  }

  private allocationBytes(): number {
    const pageCount = [...this.ctx.storage.sql.exec<Record<string, number>>("PRAGMA page_count")][0];
    const pageSize = [...this.ctx.storage.sql.exec<Record<string, number>>("PRAGMA page_size")][0];
    const count = Number(pageCount?.page_count ?? Object.values(pageCount ?? {})[0] ?? 0);
    const size = Number(pageSize?.page_size ?? Object.values(pageSize ?? {})[0] ?? 0);
    return Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(size) && size >= 0 ? count * size : Number.POSITIVE_INFINITY;
  }

  private storageLimitExceeded(incomingBytes: number): { tier: GadgetTier; limitBytes: number } | null {
    const tier = this.gadgetTier();
    if (tier === undefined) return null;
    const limitBytes = GADGET_STORAGE_LIMIT_BYTES[tier];
    if (this.allocationBytes() + incomingBytes > limitBytes) {
      return { tier, limitBytes };
    }
    return null;
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
    const role = request.headers.get("x-naelao-role") ?? "";
    const actions = this.businessActions().filter(action => action.roles.includes(role as "owner" | "admin"));
    const pinError = this.businessActionPinError(request);
    if (actions.length && pinError) return Response.json({ jsonrpc: "2.0", id, error: { code: -32009, message: pinError } }, { status: 409 });
    const tools: Array<{ name: string; description: string; inputSchema: unknown; outputSchema?: unknown }> = [
      { name: `app_${appId}_list`, description: "List gadget records", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, filter: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["table"] } },
      { name: `app_${appId}_insert`, description: "Insert a schema-validated gadget record", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, record: { type: "object" } }, required: ["table", "record"] } },
      { name: `app_${appId}_get`, description: "Get one gadget record by primary key", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {} }, required: ["table", "id"] } },
      { name: `app_${appId}_update`, description: "Update schema-validated fields on one Gadget record", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {}, record: { type: "object" } }, required: ["table", "id", "record"] } },
      { name: `app_${appId}_delete`, description: "Delete one Gadget record by primary key", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {} }, required: ["table", "id"] } },
    ];
    if (role !== "owner" && role !== "admin") {
      for (let index = tools.length - 1; index >= 0; index--) if (["insert", "update", "delete"].some(operation => tools[index]!.name === `app_${appId}_${operation}`)) tools.splice(index, 1);
    }
    tools.push(...actions.map(action => ({ name: `app_${appId}_action_${action.id}`, description: action.description,
      inputSchema: action.inputSchema, outputSchema: action.outputSchema })));
    if (rpc.method === "tools/list") return result({ tools, schema: schemas });
    if (rpc.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }, { status: 404 });
    const name = String(rpc.params?.name ?? ""), args = (rpc.params?.arguments ?? {}) as Record<string, unknown>, table = String(args.table ?? "");
    const actionPrefix = `app_${appId}_action_`;
    if (name.startsWith(actionPrefix)) {
      const outcome = await this.runBusinessAction(request, name.slice(actionPrefix.length), args);
      return outcome.status >= 400
        ? Response.json({ jsonrpc: "2.0", id, error: { code: -32000 - outcome.status, message: outcome.errorCode } })
        : result({ content: [{ type: "text", text: JSON.stringify(outcome.data) }], structuredContent: outcome.data });
    }
    const columns = this.columns(table), quoted = `"${table.replaceAll('"', '""')}"`;
    const protectedColumns = new Set(actions.filter(action => action.table === table)
      .flatMap(action => [action.quantityColumn, action.versionColumn]));
    let data: unknown, auditTarget: unknown = args.id;
    if (name === `app_${appId}_list`) {
      const filter = args.filter && typeof args.filter === "object" && !Array.isArray(args.filter) ? args.filter as Record<string, unknown> : {};
      const allowed = new Set(columns.map(c => c.name)); const pairs = Object.entries(filter).filter(([key]) => allowed.has(key));
      const where = pairs.length ? ` WHERE ${pairs.map(([key]) => `"${key.replaceAll('"','""')}" = ?`).join(" AND ")}` : "";
      const limit = parseBoundedInteger(String(args.limit ?? 100), 100, 1, 500);
      data = [...this.ctx.storage.sql.exec(`SELECT * FROM ${quoted}${where} LIMIT ?`, ...pairs.map(([,v]) => v as SqlStorageValue), limit)];
    } else if (name === `app_${appId}_insert`) {
      if (!args.record || typeof args.record !== "object" || Array.isArray(args.record)) throw new Error("record_required");
      const record = args.record as Record<string, unknown>, allowed = new Set(columns.map(c => c.name)); const entries = Object.entries(record).filter(([key]) => allowed.has(key));
      if (!entries.length || entries.length !== Object.keys(record).length) throw new Error("record_does_not_match_schema");
      if (entries.some(([key]) => protectedColumns.has(key))) throw new Error("business_action_required");
      const storageError = this.storageLimitExceeded(new TextEncoder().encode(JSON.stringify(record)).byteLength + 512);
      if (storageError) return Response.json({ jsonrpc: "2.0", id, error: { code: -32013, message: "storage_limit_exceeded", data: storageError } }, { status: 413 });
      this.ctx.storage.sql.exec(`INSERT INTO ${quoted} (${entries.map(([key]) => `"${key.replaceAll('"','""')}"`).join(",")}) VALUES (${entries.map(() => "?").join(",")})`, ...entries.map(([,v]) => v as SqlStorageValue));
      auditTarget = record[columns.find(column => column.pk)?.name ?? "id"];
      data = { inserted: true };
    } else if (name === `app_${appId}_get`) {
      const pk = columns.find(c => c.pk)?.name ?? columns[0]?.name; if (!pk) throw new Error("table_has_no_columns");
      if (args.id === undefined || args.id === null) throw new Error("record_id_required");
      data = [...this.ctx.storage.sql.exec(`SELECT * FROM ${quoted} WHERE "${pk.replaceAll('"','""')}" = ? LIMIT 1`, args.id as SqlStorageValue)][0] ?? null;
    } else if (name === `app_${appId}_update`) {
      const pk = columns.find(c => c.pk)?.name ?? columns[0]?.name; if (!pk) throw new Error("table_has_no_columns");
      if (args.id === undefined || args.id === null) throw new Error("record_id_required");
      if (!args.record || typeof args.record !== "object" || Array.isArray(args.record)) throw new Error("record_required");
      const record = args.record as Record<string, unknown>, allowed = new Set(columns.map(c => c.name));
      const entries = Object.entries(record).filter(([key]) => allowed.has(key) && key !== pk);
      if (!entries.length || entries.length !== Object.keys(record).length) throw new Error("record_does_not_match_schema");
      if (entries.some(([key]) => protectedColumns.has(key))) throw new Error("business_action_required");
      const storageError = this.storageLimitExceeded(new TextEncoder().encode(JSON.stringify(record)).byteLength);
      if (storageError) return Response.json({ jsonrpc: "2.0", id, error: { code: -32013, message: "storage_limit_exceeded", data: storageError } }, { status: 413 });
      this.ctx.storage.sql.exec(`UPDATE ${quoted} SET ${entries.map(([key]) => `"${key.replaceAll('"','""')}" = ?`).join(",")} WHERE "${pk.replaceAll('"','""')}" = ?`, ...entries.map(([,value]) => value as SqlStorageValue), args.id as SqlStorageValue);
      data = { updated: true };
    } else if (name === `app_${appId}_delete`) {
      if (actions.some(action => action.table === table)) throw new Error("business_action_required");
      const pk = columns.find(c => c.pk)?.name ?? columns[0]?.name; if (!pk) throw new Error("table_has_no_columns");
      if (args.id === undefined || args.id === null) throw new Error("record_id_required");
      this.ctx.storage.sql.exec(`DELETE FROM ${quoted} WHERE "${pk.replaceAll('"','""')}" = ?`, args.id as SqlStorageValue);
      data = { deleted: true };
    } else throw new Error("unknown_tool");
    const operation = name.slice(`app_${appId}_`.length);
    const actorId = request.headers.get("x-naelao-user-id") ?? "unknown";
    const targetHash = auditTarget === undefined || auditTarget === null ? null : [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(auditTarget))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.sql.exec("INSERT INTO gadget_action_audit(actor_id,operation,table_name,target_hash,created_at) VALUES(?,?,?,?,?)", actorId, operation, table, targetHash, Date.now());
    this.ctx.storage.sql.exec("DELETE FROM gadget_action_audit WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM gadget_action_audit)");
    return result({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
  }

  private businessActions(): ExtensionBusinessAction[] {
    const encoded = this.metadata("business_actions_json");
    if (!encoded) return [];
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value) || value.length > 32) throw new Error("business_action_contract_unavailable");
    return value.map(validateExtensionBusinessAction);
  }

  private readBusinessActions(request: Request): Response {
    const role = request.headers.get("x-naelao-role") ?? "";
    const available = this.businessActions().filter(action => action.roles.includes(role as "owner" | "admin"));
    const pinError = this.businessActionPinError(request);
    if (available.length && pinError) return Response.json({ error_code: pinError }, { status: 409, headers: { "cache-control": "private, no-store" } });
    return Response.json({ version: 1, actions: available.map(action => ({ id: action.id, name: action.name,
      description: action.description, permission: action.permission, roles: action.roles, effects: action.effects,
      idempotency: action.idempotency, approval: action.approval, inputSchema: action.inputSchema, outputSchema: action.outputSchema })) },
    { headers: { "cache-control": "private, no-store" } });
  }

  private async invokeBusinessAction(request: Request, actionId: string): Promise<Response> {
    let input: unknown;
    try { input = await request.json(); } catch { return Response.json({ error_code: "business_action_input_invalid" }, { status: 400 }); }
    const outcome = await this.runBusinessAction(request, actionId, input);
    return Response.json(outcome.status >= 400 ? { error_code: outcome.errorCode } : outcome.data, { status: outcome.status,
      headers: { "cache-control": "private, no-store" } });
  }

  private async runBusinessAction(request: Request, actionId: string, rawInput: unknown): Promise<{ status: number; data?: unknown; errorCode?: string }> {
    const action = this.businessActions().find(candidate => candidate.id === actionId);
    if (!action) return { status: 404, errorCode: "business_action_not_found" };
    const pinError = this.businessActionPinError(request);
    if (pinError) return { status: 409, errorCode: pinError };
    const actorId = request.headers.get("x-naelao-user-id") ?? "";
    const role = request.headers.get("x-naelao-role") ?? "";
    if (!actorId || actorId.length > 256 || !action.roles.includes(role as "owner" | "admin"))
      return { status: 403, errorCode: "business_action_forbidden" };
    let input: ReturnType<typeof validateBusinessActionInput>;
    try { input = validateBusinessActionInput(action, rawInput); }
    catch { return { status: 400, errorCode: "business_action_input_invalid" }; }
    if (action.operation === "inventory.listLowStock.v1")
      return this.runListLowStockAction(action, input as ListLowStockInput, actorId);
    const writeInput = input as ReceiveStockInput | AdjustStockInput;
    let columns: ReturnType<MicroAppDO["columns"]>;
    try { columns = this.columns(action.table); }
    catch { return { status: 503, errorCode: "business_action_schema_unavailable" }; }
    const idColumn = columns.find(column => column.name === action.idColumn);
    const quantityColumn = columns.find(column => column.name === action.quantityColumn);
    const versionColumn = columns.find(column => column.name === action.versionColumn);
    if (!idColumn || !idColumn.pk || !/^TEXT$/i.test(idColumn.type.trim()) || !quantityColumn || !/INT/i.test(quantityColumn.type)
      || !versionColumn || !/INT/i.test(versionColumn.type)) return { status: 503, errorCode: "business_action_schema_unavailable" };
    if (typeof this.ctx.storage.transactionSync !== "function") return { status: 503, errorCode: "business_action_atomicity_unavailable" };
    const requestSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(writeInput))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const targetHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(writeInput.productId)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const idempotencyKeySha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(writeInput.idempotencyKey)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const auditOutcome = (state: string, at = Date.now()) => {
      this.ctx.storage.sql.exec("INSERT INTO gadget_action_audit(actor_id,operation,table_name,target_hash,created_at) VALUES(?,?,?,?,?)",
        actorId, `business:${action.id}:${state}`, action.table, targetHash, at);
      this.ctx.storage.sql.exec("DELETE FROM gadget_action_audit WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM gadget_action_audit)");
    };
    const table = `"${action.table.replaceAll('"', '""')}"`;
    const key = `"${action.idColumn.replaceAll('"', '""')}"`;
    const quantity = `"${action.quantityColumn.replaceAll('"', '""')}"`;
    const version = `"${action.versionColumn.replaceAll('"', '""')}"`;
    let outcome: { status: number; data?: unknown; errorCode?: string } = { status: 500, errorCode: "business_action_failed" };
    try {
      this.ctx.storage.transactionSync(() => {
        const receipt = [...this.ctx.storage.sql.exec<{ actor_id: string; request_sha256: string; response_json: string }>(
          "SELECT actor_id,request_sha256,response_json FROM gadget_business_action_receipts WHERE action_id=? AND idempotency_key=?",
          action.id, writeInput.idempotencyKey)][0];
        if (receipt) {
          if (receipt.actor_id !== actorId || receipt.request_sha256 !== requestSha256) {
            auditOutcome("idempotency_conflict"); outcome = { status: 409, errorCode: "business_action_idempotency_conflict" }; return;
          }
          const replay = validateBusinessActionOutput(action, { ...JSON.parse(receipt.response_json), replayed: true });
          auditOutcome("replayed");
          outcome = { status: 200, data: replay };
          return;
        }
        const count = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM gadget_business_action_receipts")][0]?.count ?? 0;
        if (count >= MAX_BUSINESS_ACTION_RECEIPTS) { outcome = { status: 429, errorCode: "business_action_receipt_limit_reached" }; return; }
        const row = [...this.ctx.storage.sql.exec<{ quantity: number; version: number }>(
          `SELECT ${quantity} AS quantity,${version} AS version FROM ${table} WHERE ${key}=? LIMIT 1`, writeInput.productId)][0];
        if (!row) { auditOutcome("record_not_found"); outcome = { status: 404, errorCode: "business_action_record_not_found" }; return; }
        if (!Number.isSafeInteger(row.quantity) || row.quantity < 0 || row.quantity > 2_147_483_647
          || !Number.isSafeInteger(row.version) || row.version < 1 || row.version > 2_147_483_646) {
          auditOutcome("record_invalid"); outcome = { status: 409, errorCode: "business_action_record_invalid" }; return;
        }
        if (row.version !== writeInput.expectedVersion) { auditOutcome("version_conflict"); outcome = { status: 409, errorCode: "business_action_version_conflict" }; return; }
        const nextQuantity = "quantity" in writeInput ? row.quantity + writeInput.quantity : writeInput.newQuantity, nextVersion = row.version + 1;
        if (nextQuantity > 2_147_483_647) { auditOutcome("quantity_overflow"); outcome = { status: 409, errorCode: "business_action_quantity_overflow" }; return; }
        if (this.storageLimitExceeded(new TextEncoder().encode(JSON.stringify(writeInput)).byteLength
          + new TextEncoder().encode(JSON.stringify({ productId: writeInput.productId, quantity: nextQuantity, version: nextVersion, replayed: false })).byteLength + 2048)) {
          outcome = { status: 413, errorCode: "storage_limit_exceeded" }; return;
        }
        const updated = this.ctx.storage.sql.exec(`UPDATE ${table} SET ${quantity}=?,${version}=? WHERE ${key}=? AND ${version}=?`,
          nextQuantity, nextVersion, writeInput.productId, writeInput.expectedVersion);
        if (updated.rowsWritten !== 1) { auditOutcome("version_conflict"); outcome = { status: 409, errorCode: "business_action_version_conflict" }; return; }
        const data = action.operation === "inventory.receiveStock.v1"
          ? validateBusinessActionOutput(action, { productId: writeInput.productId, quantity: nextQuantity, version: nextVersion, replayed: false })
          : validateBusinessActionOutput(action, { productId: writeInput.productId, previousQuantity: row.quantity, quantity: nextQuantity, version: nextVersion, replayed: false });
        const createdAt = Date.now();
        this.ctx.storage.sql.exec(`INSERT INTO gadget_business_action_receipts(action_id,actor_id,idempotency_key,request_sha256,response_json,created_at) VALUES(?,?,?,?,?,?)`,
          action.id, actorId, writeInput.idempotencyKey, requestSha256, JSON.stringify(data), createdAt);
        this.ctx.storage.sql.exec(`INSERT INTO gadget_business_action_events(action_id,actor_id,product_id,quantity_received,quantity_before,
          quantity_after,version_before,version_after,reason,idempotency_key_sha256,created_at,action_operation,quantity_delta)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          action.id, actorId, writeInput.productId, "quantity" in writeInput ? writeInput.quantity : 0, row.quantity, nextQuantity, row.version, nextVersion,
          writeInput.reason, idempotencyKeySha256, createdAt, action.operation, nextQuantity - row.quantity);
        auditOutcome("completed", createdAt);
        outcome = { status: 200, data };
      });
    } catch { return { status: 503, errorCode: "business_action_storage_unavailable" }; }
    return outcome;
  }

  private runListLowStockAction(action: ExtensionBusinessAction, input: ListLowStockInput, actorId: string): { status: number; data?: unknown; errorCode?: string } {
    if (typeof this.ctx.storage.transactionSync !== "function") return { status: 503, errorCode: "business_action_atomicity_unavailable" };
    let columns: ReturnType<MicroAppDO["columns"]>;
    try { columns = this.columns(action.table); }
    catch { return { status: 503, errorCode: "business_action_schema_unavailable" }; }
    const idColumn = columns.find(column => column.name === action.idColumn);
    const quantityColumn = columns.find(column => column.name === action.quantityColumn);
    const versionColumn = columns.find(column => column.name === action.versionColumn);
    if (!idColumn || !idColumn.pk || !/^TEXT$/i.test(idColumn.type.trim()) || !quantityColumn || !/INT/i.test(quantityColumn.type)
      || !versionColumn || !/INT/i.test(versionColumn.type)) return { status: 503, errorCode: "business_action_schema_unavailable" };
    const table = `"${action.table.replaceAll('"', '""')}"`;
    const key = `"${action.idColumn.replaceAll('"', '""')}"`;
    const quantity = `"${action.quantityColumn.replaceAll('"', '""')}"`;
    const version = `"${action.versionColumn.replaceAll('"', '""')}"`;
    let outcome: { status: number; data?: unknown; errorCode?: string } = { status: 503, errorCode: "business_action_storage_unavailable" };
    try {
      this.ctx.storage.transactionSync(() => {
        const rows = [...this.ctx.storage.sql.exec<{ product_id: string; quantity: number; version: number }>(
          `SELECT ${key} AS product_id,${quantity} AS quantity,${version} AS version FROM ${table}
           WHERE ${quantity}<=? AND ${key}>? ORDER BY ${key} LIMIT ?`,
          input.maximumQuantity, input.afterProductId, input.limit + 1)];
        const hasMore = rows.length > input.limit;
        const products = rows.slice(0, input.limit).map(row => ({ productId: row.product_id, quantity: row.quantity, version: row.version }));
        let data: unknown;
        try { data = validateBusinessActionOutput(action, { products, hasMore, nextCursor: hasMore ? products.at(-1)?.productId ?? "" : "" }); }
        catch {
          this.ctx.storage.sql.exec("INSERT INTO gadget_action_audit(actor_id,operation,table_name,target_hash,created_at) VALUES(?,?,?,?,?)",
            actorId, `business:${action.id}:invalid_rows`, action.table, null, Date.now());
          outcome = { status: 409, errorCode: "business_action_record_invalid" };
          return;
        }
        this.ctx.storage.sql.exec("INSERT INTO gadget_action_audit(actor_id,operation,table_name,target_hash,created_at) VALUES(?,?,?,?,?)",
          actorId, `business:${action.id}:read`, action.table, null, Date.now());
        this.ctx.storage.sql.exec("DELETE FROM gadget_action_audit WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM gadget_action_audit)");
        outcome = { status: 200, data };
      });
    } catch { return { status: 503, errorCode: "business_action_storage_unavailable" }; }
    return outcome;
  }

  private businessActionPinError(request: Request): string | null {
    if (!this.businessActions().length) return null;
    if (!this.metadata("release_proof")) return "business_action_release_proof_required";
    const installationId = this.metadata("extension_installation_id");
    const activeInstallationId = request.headers.get("x-naelao-active-installation-id");
    const activeVersion = request.headers.get("x-naelao-active-release-version");
    let pinnedVersion: string | undefined;
    try { pinnedVersion = JSON.parse(this.metadata("release_proof")!)?.version; } catch { return "business_action_release_pin_invalid"; }
    return installationId && activeInstallationId === installationId && typeof pinnedVersion === "string" && activeVersion === pinnedVersion
      ? null : "business_action_installation_pin_mismatch";
  }

  private readCollaboration(url: URL): Response {
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "invalid_event_cursor" }, { status: 400 });
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM canvas_presence WHERE updated_at<?", now - 30_000);
    const events = this.ctx.storage.sql.exec<{ id: number; actor_id: string; kind: string; payload_json: string; created_at: number }>(
      "SELECT id,actor_id,kind,payload_json,created_at FROM canvas_collaboration_events WHERE id>? ORDER BY id LIMIT 100", after).toArray()
      .map(event => ({ id: event.id, actor_id: event.actor_id, kind: event.kind, payload: JSON.parse(event.payload_json), created_at: event.created_at }));
    const presence = this.ctx.storage.sql.exec<{ actor_id: string; cursor_json: string; updated_at: number }>(
      "SELECT actor_id,cursor_json,updated_at FROM canvas_presence WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 100", now - 30_000).toArray()
      .map(item => ({ actor_id: item.actor_id, cursor: JSON.parse(item.cursor_json), updated_at: item.updated_at }));
    return Response.json({ events, presence, next_after: events[events.length - 1]?.id ?? after });
  }

  private readActionAudit(url: URL): Response {
    const after = Number(url.searchParams.get("after") ?? 0);
    const businessAfter = Number(url.searchParams.get("business_after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(businessAfter) || businessAfter < 0)
      return Response.json({ error: "invalid_audit_cursor" }, { status: 400 });
    const items = this.ctx.storage.sql.exec<{ id: number; actor_id: string; operation: string; table_name: string; target_hash: string | null; created_at: number }>(
      "SELECT id,actor_id,operation,table_name,target_hash,created_at FROM gadget_action_audit WHERE id>? ORDER BY id LIMIT 100", after).toArray();
    const businessEvents = this.ctx.storage.sql.exec<{ id: number; action_id: string; actor_id: string; product_id: string;
      quantity_received: number; quantity_before: number; quantity_after: number; version_before: number; version_after: number;
      reason: string; created_at: number; action_operation: string; quantity_delta: number }>(`SELECT id,action_id,actor_id,product_id,quantity_received,quantity_before,quantity_after,
        version_before,version_after,reason,created_at,action_operation,quantity_delta FROM gadget_business_action_events WHERE id>? ORDER BY id LIMIT 100`, businessAfter).toArray();
    return Response.json({ items, next_after: items[items.length - 1]?.id ?? after,
      business_events: businessEvents, business_events_next_after: businessEvents[businessEvents.length - 1]?.id ?? businessAfter });
  }

  private async exportArchiveSnapshot(request: Request): Promise<Response> {
    const body = await this.readArchiveRequest(request);
    if (body instanceof Response) return body;
    const scope = body.scope;
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (Object.keys(body).some(key => key !== "scope")
      || !isMicroAppArchiveSnapshot({ version: 1, createdAt: new Date().toISOString(), scope, tables: [] }, { tenantId }))
      return Response.json({ error_code: "micro_app_archive_scope_invalid" }, { status: 400 });
    const typedScope = scope as MicroAppArchiveSnapshot["scope"];
    if (!this.metadata("app_id")) return Response.json({ present: false });
    const identity = await this.verifyMicroAppArchiveScope(typedScope);
    if (!identity.ok) return Response.json({ error_code: identity.error }, { status: identity.status });
    try {
      const names = new Set([...this.userTables(), ...ARCHIVE_PLATFORM_TABLES]);
      if (names.size > 128) return Response.json({ error_code: "micro_app_archive_table_limit_exceeded" }, { status: 413 });
      const captured = this.ctx.storage.transactionSync(() => {
        const result: Array<{ name: string; schema: string; rows: Array<Record<string, unknown>> }> = [];
        let rowCount = 0;
        for (const name of [...names].sort()) {
          const definition = [...this.ctx.storage.sql.exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name)][0]?.sql;
          if (typeof definition !== "string" || definition.startsWith("CREATE VIRTUAL TABLE")) continue;
          const rows = [...this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
            `SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT ?`, MAX_MICRO_APP_ARCHIVE_TABLE_ROWS + 1)];
          if (rows.length > MAX_MICRO_APP_ARCHIVE_TABLE_ROWS) throw new Error(`micro_app_archive_row_limit_exceeded:${name}`);
          rowCount += rows.length;
          if (rowCount > MAX_MICRO_APP_ARCHIVE_TABLE_ROWS) throw new Error("micro_app_archive_row_limit_exceeded");
          result.push({ name, schema: definition, rows: rows.map(row => Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, encodeMicroAppArchiveValue(value)]))) });
        }
        return result;
      });
      const tables: MicroAppArchiveSnapshot["tables"] = await Promise.all(captured.map(async table => ({
        name: table.name, schemaSha256: await this.archiveSha256(table.schema), rows: table.rows,
      })));
      if (!this.microAppArchiveRowsMatchScope(typedScope, captured))
        return Response.json({ error_code: "micro_app_archive_row_scope_mismatch" }, { status: 409 });
      const snapshot: MicroAppArchiveSnapshot = { version: 1, createdAt: new Date().toISOString(), scope: typedScope, tables };
      if (!isMicroAppArchiveSnapshot(snapshot) || new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_MICRO_APP_ARCHIVE_SNAPSHOT_BYTES)
        return Response.json({ error_code: "micro_app_archive_snapshot_limit_exceeded" }, { status: 413 });
      return Response.json({ present: true, snapshot }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("micro_app_archive_row_limit_exceeded")) return Response.json({ error_code: "micro_app_archive_row_limit_exceeded" }, { status: 413 });
      return Response.json({ error_code: "micro_app_archive_export_failed" }, { status: 503 });
    }
  }

  private async previewArchiveRestore(request: Request): Promise<Response> {
    const body = await this.readArchiveRequest(request);
    if (body instanceof Response) return body;
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (Object.keys(body).some(key => key !== "snapshot")) return Response.json({ error_code: "micro_app_archive_request_invalid" }, { status: 400 });
    if (!isMicroAppArchiveSnapshot(body.snapshot, { tenantId })) return Response.json({ error_code: "micro_app_archive_snapshot_invalid" }, { status: 422 });
    const identity = await this.verifyMicroAppArchiveScope((body.snapshot as MicroAppArchiveSnapshot).scope);
    if (!identity.ok) return Response.json({ error_code: identity.error }, { status: identity.status });
    const plan = await this.prepareMicroAppArchiveMerge(body.snapshot as MicroAppArchiveSnapshot);
    if (plan instanceof Response) return plan;
    try {
      const preview = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("SAVEPOINT micro_app_archive_preview");
        try {
          const merged = this.mergeMicroAppArchiveRows(plan);
          this.assertMicroAppArchiveForeignKeys();
          return merged;
        }
        finally {
          this.ctx.storage.sql.exec("ROLLBACK TO micro_app_archive_preview");
          this.ctx.storage.sql.exec("RELEASE micro_app_archive_preview");
        }
      });
      return Response.json({ preview, restore_mode: "idempotent_merge_missing_rows" }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const code = error instanceof Error && error.message === "micro_app_archive_foreign_key_conflict"
        ? error.message : "micro_app_archive_preview_failed";
      return Response.json({ error_code: code }, { status: 409 });
    }
  }

  private async applyArchiveRestore(request: Request): Promise<Response> {
    const body = await this.readArchiveRequest(request);
    if (body instanceof Response) return body;
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    const snapshot = body.snapshot;
    if (Object.keys(body).some(key => !["snapshot", "restoreId", "restoredBy"].includes(key))
      || !isMicroAppArchiveSnapshot(snapshot, { tenantId }) || typeof body.restoreId !== "string" || !/^[a-f0-9]{64}$/.test(body.restoreId)
      || typeof body.restoredBy !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.restoredBy))
      return Response.json({ error_code: "micro_app_archive_restore_invalid" }, { status: 422 });
    const typedSnapshot = snapshot as MicroAppArchiveSnapshot;
    const identity = await this.verifyMicroAppArchiveScope(typedSnapshot.scope);
    if (!identity.ok) return Response.json({ error_code: identity.error }, { status: identity.status });
    const plan = await this.prepareMicroAppArchiveMerge(typedSnapshot);
    if (plan instanceof Response) return plan;
    const snapshotSha256 = await this.archiveSha256(JSON.stringify(typedSnapshot));
    let result: { inserted: Record<string, number>; skipped: Record<string, number>; replayed: boolean } | null = null;
    try {
      this.ctx.storage.transactionSync(() => {
        const prior = [...this.ctx.storage.sql.exec<{ snapshot_sha256: string; result_json: string }>(
          "SELECT snapshot_sha256,result_json FROM gadget_archive_restore_receipts WHERE restore_id=?", body.restoreId)][0];
        if (prior) {
          if (prior.snapshot_sha256 !== snapshotSha256) throw new Error("micro_app_archive_restore_conflict");
          result = { ...(JSON.parse(prior.result_json) as { inserted: Record<string, number>; skipped: Record<string, number> }), replayed: true };
          return;
        }
        const receiptCount = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM gadget_archive_restore_receipts")][0]?.count ?? 0;
        if (receiptCount >= MAX_ARCHIVE_RESTORE_RECEIPTS) throw new Error("micro_app_archive_restore_receipt_limit_exceeded");
        const merged = this.mergeMicroAppArchiveRows(plan);
        this.assertMicroAppArchiveForeignKeys();
        this.ctx.storage.sql.exec("INSERT INTO gadget_action_audit(actor_id,operation,table_name,target_hash,created_at) VALUES(?,?,?,?,?)",
          body.restoredBy, "business:archive_restore", "gadget_business_action_events", null, Date.now());
        this.ctx.storage.sql.exec("DELETE FROM gadget_action_audit WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM gadget_action_audit)");
        this.ctx.storage.sql.exec("INSERT INTO gadget_archive_restore_receipts(restore_id,snapshot_sha256,result_json,created_at) VALUES(?,?,?,?)",
          body.restoreId, snapshotSha256, JSON.stringify(merged), Date.now());
        result = { ...merged, replayed: false };
      });
    } catch (error) {
      const code = error instanceof Error && ["micro_app_archive_restore_conflict", "micro_app_archive_restore_receipt_limit_exceeded",
        "micro_app_archive_foreign_key_conflict"].includes(error.message) ? error.message : "micro_app_archive_restore_failed";
      return Response.json({ error_code: code }, { status: code === "micro_app_archive_restore_failed" ? 503 : 409 });
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }

  private async readArchiveRequest(request: Request): Promise<Record<string, unknown> | Response> {
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (!tenantId || !(await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, this.env.PLATFORM_SECRET)))
      return Response.json({ error_code: "forbidden" }, { status: 403 });
    try {
      const bytes = await readBoundedRequestBytes(request, ARCHIVE_REQUEST_MAX_BYTES);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error_code: "bad_request" }, { status: 400 });
      return value as Record<string, unknown>;
    } catch (error) {
      return Response.json({ error_code: error instanceof RequestBodyTooLargeError ? "payload_too_large" : "bad_request" },
        { status: error instanceof RequestBodyTooLargeError ? 413 : 400 });
    }
  }

  private async verifyMicroAppArchiveScope(scope: MicroAppArchiveSnapshot["scope"]): Promise<{ ok: true } | { ok: false; status: 403 | 409 | 503; error: string }> {
    const proofJson = this.metadata("release_proof"), html = this.metadata("html");
    if (this.appId() !== scope.appId || this.metadata("scope") !== scope.gadgetScope
      || this.metadata("extension_installation_id") !== scope.installationId || !proofJson || html === undefined
      || (scope.userId ?? null) !== (this.metadata("user_id") ?? null))
      return { ok: false, status: 409, error: "micro_app_archive_installation_mismatch" };
    let proof: CanvasReleaseProof;
    try { proof = JSON.parse(proofJson) as CanvasReleaseProof; }
    catch { return { ok: false, status: 503, error: "micro_app_archive_release_invalid" }; }
    if (proof.extensionId !== scope.extensionId || proof.version !== scope.releaseVersion || proof.artifactSha256 !== scope.artifactSha256
      || !await this.verifyCanvasReleaseProof(proof, html)) return { ok: false, status: 403, error: "micro_app_archive_release_invalid" };
    try {
      const rawManifest = JSON.parse(proof.manifestJson) as { gadgets?: Array<{ id?: unknown; scope?: unknown }>;
        bundle?: { primitives?: Array<{ kind?: unknown; id?: unknown; scope?: unknown }> } };
      const manifest = validateExtensionManifest(rawManifest);
      if (await digestExtensionManifest(manifest) !== scope.manifestSha256) return { ok: false, status: 409, error: "micro_app_archive_manifest_mismatch" };
      if (["USER_PRIVATE", "SPACE_USER", "PROJECT_USER"].includes(scope.gadgetScope)) {
        const sourceGadgetId = this.metadata("source_gadget_id");
        const declared = sourceGadgetId && ([...(rawManifest.gadgets ?? []), ...(rawManifest.bundle?.primitives ?? [])]
          .some(item => item.id === sourceGadgetId && item.scope === scope.gadgetScope));
        if (!declared) return { ok: false, status: 409, error: "micro_app_archive_user_scope_mismatch" };
      }
    } catch { return { ok: false, status: 503, error: "micro_app_archive_manifest_invalid" }; }
    return { ok: true };
  }

  private async prepareMicroAppArchiveMerge(snapshot: MicroAppArchiveSnapshot): Promise<Array<{ name: string; rows: Array<Record<string, unknown>> }> | Response> {
    const allowed = new Set([...this.userTables(), ...ARCHIVE_PLATFORM_TABLES]);
    const tables: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
    const archivedNames = new Set(snapshot.tables.map(table => table.name));
    for (const name of allowed) {
      const definition = [...this.ctx.storage.sql.exec<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name)][0]?.sql;
      if (typeof definition === "string" && !definition.startsWith("CREATE VIRTUAL TABLE") && !archivedNames.has(name))
        return Response.json({ error_code: "micro_app_archive_table_set_incomplete", table: name }, { status: 422 });
    }
    for (const archived of snapshot.tables) {
      if (!allowed.has(archived.name) || archived.name === "canvas_presence" || archived.name === "gadget_archive_restore_receipts")
        return Response.json({ error_code: "micro_app_archive_table_forbidden" }, { status: 422 });
      const schema = [...this.ctx.storage.sql.exec<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", archived.name)][0]?.sql;
      const isLegacyBusinessEvents = archived.name === "gadget_business_action_events"
        && archived.schemaSha256 === await this.archiveSha256(LEGACY_BUSINESS_ACTION_EVENTS_SCHEMA);
      if (typeof schema !== "string" || schema.startsWith("CREATE VIRTUAL TABLE")
        || await this.archiveSha256(schema) !== archived.schemaSha256 && !isLegacyBusinessEvents)
        return Response.json({ error_code: "micro_app_archive_schema_incompatible", table: archived.name }, { status: 409 });
      const columns = [...this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info("${archived.name.replaceAll('"', '""')}")`)].map(column => column.name).sort();
      const rows: Array<Record<string, unknown>> = [];
      for (const row of archived.rows) {
        const archivedColumns = Object.keys(row).sort();
        if (isLegacyBusinessEvents ? archivedColumns.join("\u0000") !== [...LEGACY_BUSINESS_ACTION_EVENT_COLUMNS].sort().join("\u0000")
          : archivedColumns.join("\u0000") !== columns.join("\u0000"))
          return Response.json({ error_code: "micro_app_archive_columns_incompatible", table: archived.name }, { status: 409 });
        try {
          const decoded = Object.fromEntries(Object.entries(row).map(([column, value]) => [column, decodeMicroAppArchiveValue(value)]));
          if (isLegacyBusinessEvents) {
            if (!Number.isSafeInteger(decoded.quantity_received)) return Response.json({ error_code: "micro_app_archive_columns_incompatible", table: archived.name }, { status: 409 });
            decoded.action_operation = "inventory.receiveStock.v1";
            decoded.quantity_delta = decoded.quantity_received;
          }
          rows.push(decoded);
        }
        catch { return Response.json({ error_code: "micro_app_archive_value_invalid", table: archived.name }, { status: 422 }); }
      }
      tables.push({ name: archived.name, rows });
    }
    if (!this.microAppArchiveRowsMatchScope(snapshot.scope, tables))
      return Response.json({ error_code: "micro_app_archive_row_scope_mismatch" }, { status: 422 });
    return tables;
  }

  private microAppArchiveRowsMatchScope(scope: MicroAppArchiveSnapshot["scope"], tables: Array<{ name: string; rows: Array<Record<string, unknown>> }>): boolean {
    for (const table of tables) {
      for (const row of table.rows) {
        if (row.tenant_id !== undefined && row.tenant_id !== scope.tenantId) return false;
        if (row.space_id !== undefined && row.space_id !== scope.spaceId) return false;
        if (scope.projectId && row.project_id !== undefined && row.project_id !== null && row.project_id !== scope.projectId) return false;
        if (row.extension_installation_id !== undefined && row.extension_installation_id !== scope.installationId) return false;
        if (table.name === "gadget_extension_schema_update_receipts"
          && (row.installation_id !== scope.installationId || row.extension_id !== scope.extensionId || row.app_id !== scope.appId)) return false;
      }
    }
    return true;
  }

  private mergeMicroAppArchiveRows(tables: Array<{ name: string; rows: Array<Record<string, unknown>> }>): { inserted: Record<string, number>; skipped: Record<string, number> } {
    const inserted: Record<string, number> = {}, skipped: Record<string, number> = {};
    this.ctx.storage.sql.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of tables) {
      const columns = [...this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`)].map(column => column.name);
      const placeholders = columns.map(() => "?").join(",");
      let count = 0;
      for (const row of table.rows) {
        const result = this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO "${table.name.replaceAll('"', '""')}" (${columns.map(column => `"${column.replaceAll('"', '""')}"`).join(",")}) VALUES (${placeholders})`,
          ...columns.map(column => row[column] as SqlStorageValue));
        count += result.rowsWritten;
      }
      inserted[table.name] = count;
      skipped[table.name] = table.rows.length - count;
    }
    return { inserted, skipped };
  }

  private assertMicroAppArchiveForeignKeys(): void {
    const violations = [...this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM pragma_foreign_key_check")];
    if (violations.length) throw new Error("micro_app_archive_foreign_key_conflict");
  }

  private async archiveSha256(value: string): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async writeCollaboration(request: Request): Promise<Response> {
    const body = await request.json<{ kind?: unknown; payload?: unknown }>().catch(() => ({} as { kind?: unknown; payload?: unknown }));
    const actorId = request.headers.get("x-naelao-user-id") ?? "";
    if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(actorId) || !["cursor", "comment", "operation"].includes(String(body.kind))
      || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) return Response.json({ error: "canvas_collaboration_event_invalid" }, { status: 400 });
    const payload = body.payload as Record<string, unknown>, bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (bytes > 4_096) return Response.json({ error: "canvas_collaboration_payload_too_large" }, { status: 413 });
    const now = Date.now();
    if (body.kind === "cursor") {
      const { x, y } = payload;
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1 || typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 1
        || Object.keys(payload).some(key => !["x", "y", "label"].includes(key)) || payload.label !== undefined && (typeof payload.label !== "string" || payload.label.length > 40)) return Response.json({ error: "canvas_cursor_invalid" }, { status: 400 });
      this.ctx.storage.sql.exec(`INSERT INTO canvas_presence(actor_id,cursor_json,updated_at) VALUES(?,?,?) ON CONFLICT(actor_id) DO UPDATE SET cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`, actorId, JSON.stringify(payload), now);
      return Response.json({ saved: true, kind: "cursor", updated_at: now });
    }
    if (body.kind === "comment" && (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 1_000)) return Response.json({ error: "canvas_comment_invalid" }, { status: 400 });
    if (body.kind === "operation" && (typeof payload.operation !== "string" || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(payload.operation)
      || Object.keys(payload).some(key => !["operation", "detail"].includes(key)) || payload.detail !== undefined && (typeof payload.detail !== "string" || payload.detail.length > 256))) return Response.json({ error: "canvas_operation_invalid" }, { status: 400 });
    this.ctx.storage.sql.exec("INSERT INTO canvas_collaboration_events(actor_id,kind,payload_json,created_at) VALUES(?,?,?,?)", actorId, body.kind as string, JSON.stringify(payload), now);
    const id = Number(this.ctx.storage.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").toArray()[0]?.id ?? 0);
    this.ctx.storage.sql.exec("DELETE FROM canvas_collaboration_events WHERE id <= (SELECT COALESCE(MAX(id),0)-1000 FROM canvas_collaboration_events)");
    return Response.json({ saved: true, id, kind: body.kind, created_at: now }, { status: 201 });
  }

  private async initialize(request: Request): Promise<Response> {
    const body = await request.json<{ appId?: string; scope?: GadgetScope; gadgetTier?: GadgetTier; defaultSchemaSql?: string;
      migrations?: Array<{ version: number; description: string; up: string }>; html?: string; releaseProof?: CanvasReleaseProof;
      extensionInstallationId?: string; sourceGadgetId?: string; userId?: string; tenantId?: string; spaceId?: string; businessActions?: unknown }>();
    if (!body.appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(body.appId) || !body.scope || !body.gadgetTier) return Response.json({ error: "valid appId, scope and gadgetTier are required" }, { status: 400 });
    if ((body.gadgetTier === 1 && !["USER_PRIVATE", "PROJECT_USER", "SPACE_USER"].includes(body.scope)) ||
      (body.gadgetTier === 2 && !["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(body.scope)) ||
      (body.gadgetTier === 3 && !["PROJECT_BOUND", "PROJECT_SHARED", "SPACE_WIDE", "SPACE_SHARED"].includes(body.scope))) {
      return Response.json({ error: "gadget_tier_scope_mismatch" }, { status: 400 });
    }
    const userScoped = ["USER_PRIVATE", "SPACE_USER", "PROJECT_USER"].includes(body.scope);
    if (userScoped !== (typeof body.userId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.userId)))
      return Response.json({ error: "gadget_user_scope_identity_invalid" }, { status: 400 });
    const existing = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'app_id'")][0];
    if (existing && existing.value !== body.appId) return Response.json({ error: "actor_already_owned" }, { status: 409 });
    const existingTier = this.gadgetTier();
    if (existingTier !== undefined && existingTier !== body.gadgetTier) return Response.json({ error: "gadget_tier_immutable" }, { status: 409 });
    const existingScope = this.metadata("scope");
    if (existingScope !== undefined && existingScope !== body.scope) return Response.json({ error: "gadget_scope_immutable" }, { status: 409 });
    const existingUserId = this.metadata("user_id");
    if (existingUserId !== undefined && existingUserId !== body.userId)
      return Response.json({ error: "gadget_user_identity_immutable" }, { status: 409 });
    if (body.tenantId !== undefined && (typeof body.tenantId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.tenantId))
      || body.spaceId !== undefined && (typeof body.spaceId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.spaceId))
      || (body.tenantId === undefined) !== (body.spaceId === undefined))
      return Response.json({ error: "gadget_storage_identity_invalid" }, { status: 400 });
    const existingTenantId = this.metadata("tenant_id"), existingSpaceId = this.metadata("space_id");
    if (existingTenantId !== undefined && existingTenantId !== body.tenantId || existingSpaceId !== undefined && existingSpaceId !== body.spaceId)
      return Response.json({ error: "gadget_storage_identity_immutable" }, { status: 409 });
    const existingExtensionInstallationId = this.metadata("extension_installation_id");
    if (body.extensionInstallationId !== undefined && (!/^[A-Za-z0-9._:-]{1,768}$/.test(body.extensionInstallationId)
      || !body.releaseProof || existingExtensionInstallationId && existingExtensionInstallationId !== body.extensionInstallationId))
      return Response.json({ error: "gadget_extension_installation_mismatch" }, { status: 409 });
    const migrations = body.migrations ?? [];
    if (!Array.isArray(migrations) || migrations.length > 128) throw new Error("invalid_gadget_migrations");
    let priorVersion = 0;
    for (const migration of migrations) {
      if (!migration || !Number.isSafeInteger(migration.version) || migration.version <= priorVersion || typeof migration.description !== "string" || !migration.description.trim() || migration.description.length > 256 || typeof migration.up !== "string") throw new Error("invalid_gadget_migration");
      validDdl(migration.up, true);
      priorVersion = migration.version;
    }
    const html = body.html ?? `<main id="app" data-naelao-gadget="${body.appId}"></main>`;
    if (typeof html !== "string" || new TextEncoder().encode(html).byteLength > 512_000) throw new Error("gadget_bundle_too_large");
    const htmlSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const existingReleaseProof = this.metadata("release_proof");
    if (existingReleaseProof && !body.releaseProof) return Response.json({ error: "extension_canvas_install_route_required" }, { status: 409 });
    if (body.releaseProof && !await this.verifyCanvasReleaseProof(body.releaseProof, html)) return Response.json({ error: "extension_canvas_release_proof_invalid" }, { status: 403 });
    let businessActions: ExtensionBusinessAction[];
    try {
      if (body.businessActions !== undefined && (!Array.isArray(body.businessActions) || body.businessActions.length > 32)) throw new Error("invalid_business_actions");
      businessActions = (body.businessActions ?? []).map(validateExtensionBusinessAction);
      if (new Set(businessActions.map(action => action.id)).size !== businessActions.length
        || businessActions.some(action => action.installationScope !== body.scope || action.dataScope !== body.scope)) throw new Error("duplicate_or_mismatched_business_action");
    } catch { return Response.json({ error: "gadget_business_action_contract_invalid" }, { status: 400 }); }
    if (businessActions.length > 0 && (!body.releaseProof || !body.extensionInstallationId || typeof body.sourceGadgetId !== "string"))
      return Response.json({ error: "gadget_business_action_signed_release_required" }, { status: 403 });
    if (body.releaseProof && (businessActions.length > 0 || body.sourceGadgetId !== undefined)) {
      let source: { id?: unknown; businessActions?: unknown; scope?: unknown;
        permissions?: Array<{ scope?: unknown; actions?: unknown[]; resource?: unknown }> } | undefined;
      try {
        const manifest = JSON.parse(body.releaseProof.manifestJson) as {
          capabilityRequirements?: unknown[]; declaredPermissions?: unknown[];
          bundle?: { primitives?: Array<{ kind?: unknown; id?: unknown; businessActions?: unknown; scope?: unknown;
            permissions?: Array<{ scope?: unknown; actions?: unknown[]; resource?: unknown }> }> };
          gadgets?: Array<{ id?: unknown; scope?: unknown; businessActions?: unknown }>;
        };
        source = manifest.bundle?.primitives?.find(item => item.kind === "gadget" && item.id === body.sourceGadgetId)
          ?? manifest.gadgets?.find(item => item.id === body.sourceGadgetId);
        if (businessActions.length > 0) {
          const permissions = source && Array.isArray(source.permissions) ? source.permissions : [];
          const scopedPermission = businessActions.every(action => permissions.some(permission => permission.scope === body.scope
            && Array.isArray(permission.actions) && permission.actions.includes(action.effects === "read_only" ? "read" : "write")
            && permission.resource === action.permission));
          const legacyPermission = businessActions.every(action => manifest.declaredPermissions?.includes(action.permission));
          if (!manifest.capabilityRequirements?.includes("extension.gadget.business_action")
            || !(scopedPermission || legacyPermission)) return Response.json({ error: "gadget_business_action_permission_missing" }, { status: 403 });
        }
      } catch { return Response.json({ error: "gadget_business_action_release_invalid" }, { status: 403 }); }
      if (typeof body.sourceGadgetId !== "string" || !source || businessActions.length > 0 && source.scope !== body.scope
        || JSON.stringify(source.businessActions ?? []) !== JSON.stringify(businessActions))
        return Response.json({ error: "gadget_business_action_release_mismatch" }, { status: 403 });
    } else if (body.sourceGadgetId !== undefined) {
      return Response.json({ error: "gadget_business_action_release_required" }, { status: 403 });
    }
    if (existingReleaseProof && body.releaseProof && JSON.parse(existingReleaseProof).extensionId !== body.releaseProof.extensionId) {
      return Response.json({ error: "extension_canvas_identity_immutable" }, { status: 409 });
    }
    const apply = () => {
      for (const statement of validDdl(body.defaultSchemaSql ?? "")) this.ctx.storage.sql.exec(statement);
      for (const migration of migrations) {
        const applied = [...this.ctx.storage.sql.exec<{ version: number }>("SELECT version FROM gadget_schema_migrations WHERE version=?", migration.version)][0];
        if (applied) continue;
        for (const statement of validDdl(migration.up, true)) this.ctx.storage.sql.exec(statement);
        this.ctx.storage.sql.exec("INSERT INTO gadget_schema_migrations(version,description) VALUES(?,?)", migration.version, migration.description);
      }
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES ('app_id',?),('scope',?),('gadget_tier',?),('html',?),('html_sha256',?)", body.appId, body.scope, String(body.gadgetTier), html, htmlSha256);
    if (body.userId) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('user_id',?)", body.userId);
      if (body.tenantId && body.spaceId) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('tenant_id',?),('space_id',?)", body.tenantId, body.spaceId);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('business_actions_json',?)", JSON.stringify(businessActions));
      if (body.extensionInstallationId) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('extension_installation_id',?)", body.extensionInstallationId);
      if (body.sourceGadgetId) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('source_gadget_id',?)", body.sourceGadgetId);
    };
    if ((body.defaultSchemaSql || migrations.length) && typeof this.ctx.storage.transactionSync === "function") this.ctx.storage.transactionSync(apply);
    else if (body.defaultSchemaSql || migrations.length) throw new Error("atomic_gadget_migration_unavailable");
    else apply();
    if (body.releaseProof) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('release_proof',?)", JSON.stringify(body.releaseProof));
    return Response.json({ initialized: true, appId: body.appId, scope: body.scope, gadgetTier: body.gadgetTier }, { status: 201 });
  }

  private async eraseUserActor(request: Request): Promise<Response> {
    const parsed = await this.readArchiveRequest(request);
    if (parsed instanceof Response) return parsed;
    const { tenantId, spaceId, userId, appId, gadgetScope, projectId } = parsed;
    if (Object.keys(parsed).some(key => !["tenantId", "spaceId", "userId", "appId", "gadgetScope", "projectId"].includes(key))
      || typeof tenantId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(tenantId)
      || typeof spaceId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(spaceId)
      || typeof userId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(userId)
      || typeof appId !== "string" || !/^[a-z][a-z0-9_-]{1,64}$/.test(appId)
      || gadgetScope !== "USER_PRIVATE" && gadgetScope !== "SPACE_USER" && gadgetScope !== "PROJECT_USER"
      || gadgetScope === "PROJECT_USER" && (typeof projectId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(projectId))
      || gadgetScope !== "PROJECT_USER" && projectId !== undefined)
      return Response.json({ error_code: "micro_app_user_erasure_scope_invalid" }, { status: 400 });
    const identityHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify(["product-user-micro-app-erasure-v1", tenantId, spaceId, userId, projectId ?? null, appId, gadgetScope]))))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const existingErasureHash = this.metadata("product_user_erasure_identity_sha256");
    if (existingErasureHash) return existingErasureHash === identityHash
      ? Response.json({ erased: true, replayed: true })
      : Response.json({ error_code: "micro_app_user_erasure_identity_mismatch" }, { status: 409 });

    const existingAppId = this.metadata("app_id"), existingUserId = this.metadata("user_id"), existingScope = this.metadata("scope");
    if (existingAppId && existingAppId !== appId || existingUserId && existingUserId !== userId
      || existingScope && existingScope !== gadgetScope
      || this.metadata("tenant_id") && this.metadata("tenant_id") !== tenantId
      || this.metadata("space_id") && this.metadata("space_id") !== spaceId)
      return Response.json({ error_code: "micro_app_user_erasure_actor_mismatch" }, { status: 409 });
    if (existingAppId && (!existingUserId || !existingScope))
      return Response.json({ error_code: "micro_app_user_erasure_actor_identity_missing" }, { status: 409 });

    await this.ctx.storage.deleteAll();
    this.initialized = false;
    this.ensureBaseSchema();
    this.ctx.storage.sql.exec("INSERT INTO gadget_metadata(key,value) VALUES('product_user_erased','1'),('product_user_erasure_identity_sha256',?)", identityHash);
    await this.ctx.storage.deleteAlarm();
    return Response.json({ erased: true, replayed: false });
  }

  private async applyExtensionSchemaUpdate(request: Request): Promise<Response> {
    const body = await request.json<{ claims?: ExtensionSchemaUpdateClaims; signature?: string;
      migrations?: Array<{ version: number; description: string; up: string }> }>()
      .catch((): { claims?: ExtensionSchemaUpdateClaims; signature?: string; migrations?: Array<{ version: number; description: string; up: string }> } => ({}));
    const claims = body.claims;
    if (!claims || claims.version !== 1 || claims.purpose !== "space_shared_gadget_schema_update"
      || typeof claims.tenantId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(claims.tenantId)
      || typeof claims.spaceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.spaceId)
      || typeof claims.installationId !== "string" || !/^[A-Za-z0-9._:-]{1,768}$/.test(claims.installationId)
      || typeof claims.extensionId !== "string" || !/^ext_[a-z0-9_-]{2,62}$/.test(claims.extensionId)
      || typeof claims.appId !== "string" || !isGadgetId(claims.appId)
      || typeof claims.fromVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(claims.fromVersion)
      || typeof claims.toVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(claims.toVersion)
      || claims.fromVersion === claims.toVersion
      || !/^[a-f0-9]{64}$/.test(claims.sourceManifestSha256) || !/^[a-f0-9]{64}$/.test(claims.candidateManifestSha256)
      || !/^[a-f0-9]{64}$/.test(claims.sourceArtifactSha256)
      || !/^[a-f0-9]{64}$/.test(claims.artifactSha256) || !/^[a-f0-9]{64}$/.test(claims.publisherKeyId)
      || !/^[a-f0-9]{64}$/.test(claims.migrationsSha256) || !/^[a-f0-9]{64}$/.test(claims.operationKey)
      || typeof body.signature !== "string" || !/^[a-f0-9]{64}$/.test(body.signature)
      || !Array.isArray(body.migrations) || body.migrations.length < 1 || body.migrations.length > 128)
      return Response.json({ error_code: "gadget_schema_update_request_invalid" }, { status: 400 });

    const migrations = body.migrations!;
    let priorVersion = 0;
    try {
      for (const migration of migrations) {
        if (!migration || !Number.isSafeInteger(migration.version) || migration.version <= priorVersion
          || typeof migration.description !== "string" || !migration.description.trim() || migration.description.length > 256
          || typeof migration.up !== "string") throw new Error("invalid_gadget_migration");
        validDdl(migration.up, true);
        priorVersion = migration.version;
      }
    } catch { return Response.json({ error_code: "gadget_schema_update_unsafe_migration" }, { status: 400 }); }

    const payload = JSON.stringify(claims);
    const migrationPayload = JSON.stringify(migrations);
    const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const { operationKey, ...identity } = claims;
    if (!await verifyHmac(payload, body.signature, this.env.PLATFORM_SECRET)
      || await sha256(migrationPayload) !== claims.migrationsSha256
      || await sha256(JSON.stringify(identity)) !== operationKey)
      return Response.json({ error_code: "gadget_schema_update_authorization_invalid" }, { status: 403 });
    if (this.metadata("app_id") !== claims.appId || this.metadata("scope") !== "SPACE_SHARED" || this.gadgetTier() !== 3)
      return Response.json({ error_code: "gadget_schema_update_actor_mismatch" }, { status: 409 });

    const proofJson = this.metadata("release_proof"), html = this.metadata("html");
    if (!proofJson || !html) return Response.json({ error_code: "gadget_schema_update_signed_source_unavailable" }, { status: 409 });
    let sourceProof: CanvasReleaseProof;
    try { sourceProof = JSON.parse(proofJson) as CanvasReleaseProof; }
    catch { return Response.json({ error_code: "gadget_schema_update_signed_source_invalid" }, { status: 409 }); }
    if (sourceProof.extensionId !== claims.extensionId || !await this.verifyCanvasReleaseProof(sourceProof, html))
      return Response.json({ error_code: "gadget_schema_update_source_pin_conflict" }, { status: 409 });
    const existingInstallationId = this.metadata("extension_installation_id");
    if (existingInstallationId && existingInstallationId !== claims.installationId)
      return Response.json({ error_code: "gadget_schema_update_installation_mismatch" }, { status: 409 });

    const prior = [...this.ctx.storage.sql.exec<{ operationKey: string; tenantId: string; spaceId: string; installationId: string;
      extensionId: string; appId: string; fromVersion: string; toVersion: string; sourceManifestSha256: string;
      candidateManifestSha256: string; sourceArtifactSha256: string; artifactSha256: string; publisherKeyId: string; migrationsSha256: string }>(
      `SELECT operation_key AS operationKey,tenant_id AS tenantId,space_id AS spaceId,installation_id AS installationId,
       extension_id AS extensionId,app_id AS appId,from_version AS fromVersion,to_version AS toVersion,
       source_manifest_sha256 AS sourceManifestSha256,candidate_manifest_sha256 AS candidateManifestSha256,
       source_artifact_sha256 AS sourceArtifactSha256,artifact_sha256 AS artifactSha256,
       publisher_key_id AS publisherKeyId,migrations_sha256 AS migrationsSha256
       FROM gadget_extension_schema_update_receipts WHERE operation_key=?`, operationKey)][0];
    if (prior) {
      if (prior.tenantId !== claims.tenantId || prior.spaceId !== claims.spaceId || prior.installationId !== claims.installationId
        || prior.extensionId !== claims.extensionId || prior.appId !== claims.appId || prior.fromVersion !== claims.fromVersion
        || prior.toVersion !== claims.toVersion || prior.sourceManifestSha256 !== claims.sourceManifestSha256
        || prior.candidateManifestSha256 !== claims.candidateManifestSha256 || prior.sourceArtifactSha256 !== claims.sourceArtifactSha256
        || prior.artifactSha256 !== claims.artifactSha256
        || prior.publisherKeyId !== claims.publisherKeyId || prior.migrationsSha256 !== claims.migrationsSha256)
        return Response.json({ error_code: "gadget_schema_update_operation_conflict" }, { status: 409 });
      return Response.json({ applied: true, replayed: true, operation_key: operationKey }, { headers: { "cache-control": "private, no-store" } });
    }

    const storedSourceVersion = this.metadata("schema_release_version") ?? sourceProof.version;
    const storedSourceManifest = this.metadata("schema_manifest_sha256")
      ?? await sha256(sourceProof.manifestJson).catch(() => "");
    const storedSourceArtifact = this.metadata("schema_artifact_sha256") ?? sourceProof.artifactSha256;
    if (storedSourceVersion !== claims.fromVersion || storedSourceManifest !== claims.sourceManifestSha256
      || storedSourceArtifact !== claims.sourceArtifactSha256)
      return Response.json({ error_code: "gadget_schema_update_source_pin_conflict" }, { status: 409 });

    const migrationHashes = new Map(await Promise.all(migrations.map(async (migration: { version: number; description: string; up: string }) => [migration.version,
      await sha256(JSON.stringify(migration))] as const)));

    let replayed = false;
    try {
      this.ctx.storage.transactionSync(() => {
        const raced = [...this.ctx.storage.sql.exec<{ operation_key: string }>(
          "SELECT operation_key FROM gadget_extension_schema_update_receipts WHERE operation_key=?", operationKey)][0];
        if (raced) { replayed = true; return; }
        const installationOwner = this.metadata("extension_installation_id");
        if (installationOwner && installationOwner !== claims.installationId) throw new Error("gadget_schema_update_installation_mismatch");
        for (const migration of migrations) {
          const migrationSha256 = migrationHashes.get(migration.version)!;
          const existing = [...this.ctx.storage.sql.exec<{ migration_sha256: string }>(
            "SELECT migration_sha256 FROM gadget_schema_migrations WHERE version=?", migration.version)][0];
          if (existing) {
            if (!existing.migration_sha256 || existing.migration_sha256 !== migrationSha256)
              throw new Error("gadget_schema_migration_version_conflict");
            continue;
          }
          for (const statement of validDdl(migration.up, true)) this.ctx.storage.sql.exec(statement);
          this.ctx.storage.sql.exec("INSERT INTO gadget_schema_migrations(version,description,migration_sha256) VALUES(?,?,?)",
            migration.version, migration.description, migrationSha256);
        }
        this.ctx.storage.sql.exec(`INSERT INTO gadget_extension_schema_update_receipts
          (operation_key,tenant_id,space_id,installation_id,extension_id,app_id,from_version,to_version,source_manifest_sha256,
           candidate_manifest_sha256,source_artifact_sha256,artifact_sha256,publisher_key_id,migrations_sha256,applied_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, operationKey, claims.tenantId, claims.spaceId, claims.installationId,
          claims.extensionId, claims.appId, claims.fromVersion, claims.toVersion, claims.sourceManifestSha256,
          claims.candidateManifestSha256, claims.sourceArtifactSha256, claims.artifactSha256, claims.publisherKeyId,
          claims.migrationsSha256, new Date().toISOString());
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('schema_release_version',?),('schema_manifest_sha256',?)",
          claims.toVersion, claims.candidateManifestSha256);
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('schema_artifact_sha256',?)", claims.artifactSha256);
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('extension_installation_id',?)", claims.installationId);
      });
    } catch (error) {
      const conflictCode = error instanceof Error && ["gadget_schema_migration_version_conflict", "gadget_schema_update_installation_mismatch"]
        .includes(error.message) ? error.message : null;
      return Response.json({ error_code: conflictCode ?? "gadget_schema_update_apply_failed", retryable: conflictCode === null },
        { status: conflictCode ? 409 : 503 });
    }
    return Response.json({ applied: true, replayed, operation_key: operationKey }, { headers: { "cache-control": "private, no-store" } });
  }

  private async renderApp(): Promise<Response> {
    const row = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'html'")][0];
    if (!row) return Response.json({ error: "gadget_not_initialized" }, { status: 404 });
    const expected = this.metadata("html_sha256");
    const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual)
      return Response.json({ error: "gadget_artifact_integrity_failed" }, { status: 503 });
    const releaseProofJson = this.metadata("release_proof");
    if (releaseProofJson) {
      let releaseProof: CanvasReleaseProof;
      try { releaseProof = JSON.parse(releaseProofJson) as CanvasReleaseProof; } catch { return Response.json({ error: "gadget_release_proof_invalid" }, { status: 503 }); }
      if (!await this.verifyCanvasReleaseProof(releaseProof, row.value)) return Response.json({ error: "gadget_release_proof_invalid" }, { status: 503 });
    }
    const inlineHashes: string[] = [];
    for (const match of row.value.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      const script = match[1] ?? "";
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)));
      inlineHashes.push(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
      if (inlineHashes.length > 16) return Response.json({ error: "gadget_inline_script_limit" }, { status: 503 });
    }
    return new Response(row.value, { headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'self' ${inlineHashes.join(" ")}; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    } });
  }

  private async verifyCanvasReleaseProof(proof: CanvasReleaseProof, html: string): Promise<boolean> {
    if (!proof || !/^ext_[a-z0-9_-]{2,62}$/.test(proof.extensionId) || !proof.version || proof.version.length > 64
      || !/^\.[/][A-Za-z0-9._-]{1,128}\.html$/.test(proof.canvasPath) || !/^[a-f0-9]{64}$/.test(proof.artifactSha256)
      || !/^[a-f0-9]{64}$/.test(proof.canvasSha256) || !/^[a-f0-9]{64}$/.test(proof.hostSignature)
      || !/^[a-f0-9]{64}$/.test(proof.bindingSignature) || proof.manifestJson.length > 128_000) return false;
    const actualCanvasHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (actualCanvasHash !== proof.canvasSha256) return false;
    let manifest: { id?: unknown; bundle?: { id?: unknown; version?: unknown; primitives?: Array<{ kind?: unknown; component?: unknown }> } };
    try { manifest = JSON.parse(proof.manifestJson) as typeof manifest; } catch { return false; }
    if (manifest.id !== proof.extensionId || manifest.bundle?.id !== proof.extensionId || manifest.bundle.version !== proof.version
      || !manifest.bundle.primitives?.some(part => part.kind === "canvas" && part.component === proof.canvasPath)) return false;
    const releasePayload = JSON.stringify([proof.extensionId, proof.version, proof.manifestJson, proof.artifactSha256]);
    if (!await verifyHmac(releasePayload, proof.hostSignature, this.env.PLATFORM_SECRET)) return false;
    const bindingPayload = JSON.stringify([proof.extensionId, proof.version, proof.manifestJson, proof.artifactSha256, proof.hostSignature, proof.canvasPath, proof.canvasSha256]);
    return verifyHmac(bindingPayload, proof.bindingSignature, this.env.PLATFORM_SECRET);
  }

  private async publishPage(request: Request): Promise<Response> {
    const body = await request.json<{ slug?: string; html?: string; actions?: Record<string, PublicPageAction> }>();
    if (!body.slug || !pagePathPart(body.slug) || typeof body.html !== "string" || !body.actions || typeof body.actions !== "object" || Array.isArray(body.actions)) {
      return Response.json({ error: "invalid_public_page" }, { status: 400 });
    }
    if (new TextEncoder().encode(body.html).byteLength > 512_000 || /<\s*script\b|\bon[a-z]+\s*=|javascript\s*:/i.test(body.html)) {
      return Response.json({ error: "active_content_not_allowed" }, { status: 400 });
    }
    const storageError = this.storageLimitExceeded(new TextEncoder().encode(body.html + JSON.stringify(body.actions)).byteLength + 512);
    if (storageError) return Response.json({ error: "storage_limit_exceeded", ...storageError }, { status: 413 });
    const actions: Record<string, PublicPageAction> = {};
    for (const [name, action] of Object.entries(body.actions)) {
      if (!pagePathPart(name) || !action || typeof action !== "object" || !pagePathPart(action.key) || !Array.isArray(action.fields) || action.fields.length > 32 ||
        !action.fields.every(field => typeof field === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(field)) || new Set(action.fields).size !== action.fields.length) {
        return Response.json({ error: "invalid_public_page_action" }, { status: 400 });
      }
      actions[name] = { key: action.key, fields: [...action.fields] };
    }
    if (Object.keys(actions).length === 0 || Object.keys(actions).length > 16) return Response.json({ error: "public_page_action_required" }, { status: 400 });
    for (const name of Object.keys(actions)) if (!body.html.includes(`{{NAELAO_ACTION_TOKEN:${name}}}`)) return Response.json({ error: "action_token_placeholder_missing" }, { status: 400 });
    this.ctx.storage.sql.exec("INSERT INTO gadget_public_pages(slug,html,actions_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET html=excluded.html,actions_json=excluded.actions_json,updated_at=excluded.updated_at", body.slug, body.html, JSON.stringify(actions), new Date().toISOString());
    return Response.json({ published: true, slug: body.slug }, { status: 201 });
  }

  private async renderPublicPage(url: URL): Promise<Response> {
    const slug = url.searchParams.get("slug") ?? "";
    if (!pagePathPart(slug)) return Response.json({ error: "not_found" }, { status: 404 });
    const row = [...this.ctx.storage.sql.exec<{ html: string; actions_json: string }>("SELECT html,actions_json FROM gadget_public_pages WHERE slug = ?", slug)][0];
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    const actions = JSON.parse(row.actions_json) as Record<string, PublicPageAction>;
    let html = row.html;
    for (const [name, action] of Object.entries(actions)) {
      const unsigned: PublicPageClaims = { spaceId: url.searchParams.get("spaceId") ?? "", appId: this.appId(), slug, action: name, key: action.key, fields: action.fields, nonce: crypto.randomUUID(), exp: Date.now() + PUBLIC_ACTION_TTL_MS };
      const payload = encodeToken(JSON.stringify(unsigned));
      const token = `${payload}.${await signHmac(payload, this.env.PLATFORM_SECRET)}`;
      html = html.replaceAll(`{{NAELAO_ACTION_TOKEN:${name}}}`, token);
    }
    return new Response(html, { headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    } });
  }

  private async submitPublicAction(request: Request, url: URL): Promise<Response> {
    const body = await request.json<{ token?: string; payload?: Record<string, unknown> }>();
    if (typeof body.token !== "string" || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) return Response.json({ error: "invalid_action_request" }, { status: 400 });
    const [payload, signature, extra] = body.token.split(".");
    if (!payload || !signature || extra !== undefined || !await verifyHmac(payload, signature, this.env.PLATFORM_SECRET)) return Response.json({ error: "invalid_public_action_token" }, { status: 403 });
    let claims: PublicPageClaims;
    try { claims = JSON.parse(decodeToken(payload)) as PublicPageClaims; }
    catch { return Response.json({ error: "invalid_public_action_token" }, { status: 403 }); }
    const slug = url.searchParams.get("slug") ?? "";
    const spaceId = url.searchParams.get("spaceId") ?? "";
    const action = url.searchParams.get("action") ?? "";
    if (claims.slug !== slug || claims.spaceId !== spaceId || claims.appId !== this.appId() || claims.action !== action || claims.exp <= Date.now() || !pagePathPart(claims.nonce)) {
      return Response.json({ error: "expired_or_mismatched_public_action_token" }, { status: 403 });
    }
    const current = [...this.ctx.storage.sql.exec<{ actions_json: string }>("SELECT actions_json FROM gadget_public_pages WHERE slug = ?", slug)][0];
    const allowed = current ? (JSON.parse(current.actions_json) as Record<string, PublicPageAction>)[action] : undefined;
    if (!allowed || allowed.key !== claims.key || JSON.stringify(allowed.fields) !== JSON.stringify(claims.fields)) return Response.json({ error: "public_action_revoked" }, { status: 403 });
    const submitted = body.payload;
    const fields = Object.keys(submitted);
    if (fields.length === 0 || fields.length > claims.fields.length || fields.some(field => !claims.fields.includes(field)) || new TextEncoder().encode(JSON.stringify(submitted)).byteLength > 16_384) {
      return Response.json({ error: "public_action_payload_rejected" }, { status: 400 });
    }
    const storageError = this.storageLimitExceeded(new TextEncoder().encode(JSON.stringify(submitted)).byteLength + 512);
    if (storageError) return Response.json({ error: "storage_limit_exceeded", ...storageError }, { status: 413 });
    try {
      this.ctx.storage.sql.exec("INSERT INTO consumed_public_action_nonces(nonce,expires_at) VALUES (?,?)", claims.nonce, claims.exp);
    } catch { return Response.json({ error: "public_action_token_replayed" }, { status: 409 }); }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("INSERT INTO gadget_data(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", claims.key, JSON.stringify(submitted), now);
    this.ctx.storage.sql.exec("DELETE FROM consumed_public_action_nonces WHERE expires_at <= ?", Date.now());
    return Response.json({ accepted: true }, { status: 202 });
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
    const storageError = this.storageLimitExceeded(new TextEncoder().encode(body.key + encoded).byteLength + 512);
    if (storageError) return Response.json({ error: "storage_limit_exceeded", ...storageError }, { status: 413 });
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
