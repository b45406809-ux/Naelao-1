import { DurableObject } from "cloudflare:workers";
import type { GadgetActorScope, GadgetScope, GadgetTier } from "@naelao/agent-sdk";
import { signHmac, verifyHmac } from "@naelao/crypto";

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
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.appId)) throw new Error("invalid_gadget_app_id");
  if (!input.spaceId) throw new Error("gadget_space_id_required");
  if (input.scope === "SPACE_WIDE" || input.scope === "SPACE_SHARED") return `gadget:${input.appId}:space:${input.spaceId}`;
  if (input.scope === "SPACE_USER" || input.scope === "USER_PRIVATE") {
    if (!input.userId) throw new Error("gadget_user_id_required");
    return `gadget:${input.appId}:space:${input.spaceId}:user:${input.userId}`;
  }
  if (input.scope === "PROJECT_BOUND") {
    if (!input.projectId) throw new Error("gadget_project_id_required");
    return `gadget:${input.appId}:project:${input.projectId}`;
  }
  if (input.scope === "PROJECT_SHARED") {
    if (!input.projectId) throw new Error("gadget_project_id_required");
    return `gadget:${input.appId}:space:${input.spaceId}:project:${input.projectId}`;
  }
  if (input.scope === "PROJECT_USER") {
    if (!input.projectId) throw new Error("gadget_project_id_required");
    if (!input.userId) throw new Error("gadget_user_id_required");
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
      CREATE TABLE IF NOT EXISTS consumed_public_action_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureBaseSchema();
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/initialize") return await this.initialize(request);
      if (request.method === "GET" && url.pathname === "/app") return await this.renderApp();
      if (request.method === "POST" && url.pathname === "/page/publish") return await this.publishPage(request);
      if (request.method === "GET" && url.pathname === "/page/render") return await this.renderPublicPage(url);
      if (request.method === "POST" && url.pathname === "/page/action") return await this.submitPublicAction(request, url);
      if (request.method === "GET" && url.pathname === "/api/storage") return this.readStorageUsage();
      if (request.method === "GET" && url.pathname === "/api/data") return this.readData(url);
      if (request.method === "POST" && url.pathname === "/api/data") return await this.writeData(request);
      if (request.method === "DELETE" && url.pathname === "/api/data") return this.deleteData(url);
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
    return [...this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('gadget_metadata') ORDER BY name")].map(row => row.name);
  }

  private columns(table: string): Array<{ name: string; type: string; pk: number; notnull: number }> {
    if (!this.userTables().includes(table)) throw new Error("unknown_table");
    return [...this.ctx.storage.sql.exec<{ name: string; type: string; pk: number; notnull: number }>(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)];
  }

  private readStorageUsage(): Response {
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
    const tools = [
      { name: `app_${appId}_list`, description: "List gadget records", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, filter: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["table"] } },
      { name: `app_${appId}_insert`, description: "Insert a schema-validated gadget record", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, record: { type: "object" } }, required: ["table", "record"] } },
      { name: `app_${appId}_get`, description: "Get one gadget record by primary key", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {} }, required: ["table", "id"] } },
      { name: `app_${appId}_update`, description: "Update schema-validated fields on one Gadget record", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {}, record: { type: "object" } }, required: ["table", "id", "record"] } },
      { name: `app_${appId}_delete`, description: "Delete one Gadget record by primary key", inputSchema: { type: "object", properties: { table: { type: "string", enum: tables }, id: {} }, required: ["table", "id"] } },
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
      const storageError = this.storageLimitExceeded(new TextEncoder().encode(JSON.stringify(record)).byteLength + 512);
      if (storageError) return Response.json({ jsonrpc: "2.0", id, error: { code: -32013, message: "storage_limit_exceeded", data: storageError } }, { status: 413 });
      this.ctx.storage.sql.exec(`INSERT INTO ${quoted} (${entries.map(([key]) => `"${key.replaceAll('"','""')}"`).join(",")}) VALUES (${entries.map(() => "?").join(",")})`, ...entries.map(([,v]) => v as SqlStorageValue));
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
      const storageError = this.storageLimitExceeded(new TextEncoder().encode(JSON.stringify(record)).byteLength);
      if (storageError) return Response.json({ jsonrpc: "2.0", id, error: { code: -32013, message: "storage_limit_exceeded", data: storageError } }, { status: 413 });
      this.ctx.storage.sql.exec(`UPDATE ${quoted} SET ${entries.map(([key]) => `"${key.replaceAll('"','""')}" = ?`).join(",")} WHERE "${pk.replaceAll('"','""')}" = ?`, ...entries.map(([,value]) => value as SqlStorageValue), args.id as SqlStorageValue);
      data = { updated: true };
    } else if (name === `app_${appId}_delete`) {
      const pk = columns.find(c => c.pk)?.name ?? columns[0]?.name; if (!pk) throw new Error("table_has_no_columns");
      if (args.id === undefined || args.id === null) throw new Error("record_id_required");
      this.ctx.storage.sql.exec(`DELETE FROM ${quoted} WHERE "${pk.replaceAll('"','""')}" = ?`, args.id as SqlStorageValue);
      data = { deleted: true };
    } else throw new Error("unknown_tool");
    return result({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
  }

  private async initialize(request: Request): Promise<Response> {
    const body = await request.json<{ appId?: string; scope?: GadgetScope; gadgetTier?: GadgetTier; defaultSchemaSql?: string; migrations?: Array<{ version: number; description: string; up: string }>; html?: string; releaseProof?: CanvasReleaseProof }>();
    if (!body.appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(body.appId) || !body.scope || !body.gadgetTier) return Response.json({ error: "valid appId, scope and gadgetTier are required" }, { status: 400 });
    if ((body.gadgetTier === 1 && !["USER_PRIVATE", "PROJECT_USER", "SPACE_USER"].includes(body.scope)) ||
      (body.gadgetTier === 2 && !["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(body.scope)) ||
      (body.gadgetTier === 3 && !["PROJECT_BOUND", "PROJECT_SHARED", "SPACE_WIDE", "SPACE_SHARED"].includes(body.scope))) {
      return Response.json({ error: "gadget_tier_scope_mismatch" }, { status: 400 });
    }
    const existing = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM gadget_metadata WHERE key = 'app_id'")][0];
    if (existing && existing.value !== body.appId) return Response.json({ error: "actor_already_owned" }, { status: 409 });
    const existingTier = this.gadgetTier();
    if (existingTier !== undefined && existingTier !== body.gadgetTier) return Response.json({ error: "gadget_tier_immutable" }, { status: 409 });
    const existingScope = this.metadata("scope");
    if (existingScope !== undefined && existingScope !== body.scope) return Response.json({ error: "gadget_scope_immutable" }, { status: 409 });
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
    };
    if ((body.defaultSchemaSql || migrations.length) && typeof this.ctx.storage.transactionSync === "function") this.ctx.storage.transactionSync(apply);
    else if (body.defaultSchemaSql || migrations.length) throw new Error("atomic_gadget_migration_unavailable");
    else apply();
    if (body.releaseProof) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO gadget_metadata(key,value) VALUES('release_proof',?)", JSON.stringify(body.releaseProof));
    return Response.json({ initialized: true, appId: body.appId, scope: body.scope, gadgetTier: body.gadgetTier }, { status: 201 });
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
    return new Response(row.value, { headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
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
