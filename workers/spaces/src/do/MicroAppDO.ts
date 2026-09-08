import { DurableObject } from "cloudflare:workers";
import { GADGET_STORAGE_LIMITS, GadgetStorageStats } from "@naelao/types";

export interface MicroAppEnv {
  GATEKEEPER_SECRET?: string;
  PLATFORM_SECRET?: string;
  SPACES_WORKER?: Fetcher;
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

export class MicroAppDO extends DurableObject {
  private initialized = false;
  private lastAccessedAt: number = Date.now();

  constructor(ctx: DurableObjectState, env: MicroAppEnv) {
    super(ctx, env);
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
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

      CREATE TABLE IF NOT EXISTS app_records (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInit();
    const url = new URL(request.url);
    this.lastAccessedAt = Date.now();

    // Reset the 14-day hibernation alarm on every request
    await this.refreshHibernationAlarm();

    // 1. Expose telemetry endpoint for Canvas UI and Agent inspection
    if (url.pathname === "/api/storage-stats" && request.method === "GET") {
      const stats = await this.getStorageStats();
      return Response.json(stats);
    }

    // 2. Enforce pre-flight quota gate on write mutations
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const quotaCheck = await this.verifyStorageQuota();
      if (!quotaCheck.allowed) {
        return Response.json(
          {
            error_code: "storage_quota_exceeded",
            message: `Gadget storage limit exceeded (${(quotaCheck.stats.usedBytes / 1024 / 1024).toFixed(1)}MB / 50MB). Please clean up old records or vacuum database.`,
            currentBytes: quotaCheck.stats.usedBytes,
            maxBytes: quotaCheck.stats.maxBytes,
            instanceId: this.ctx.id.toString()
          },
          {
            status: 413,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      // If near limit (80%), attach warning header to response
      if (quotaCheck.stats.isNearLimit) {
        const response = await this.handleApiRoute(request, url);
        const headers = new Headers(response.headers);
        headers.set("X-Gadget-Storage-Warning", `Storage is at ${quotaCheck.stats.usedPercentage.toFixed(1)}% of 50MB quota.`);
        return new Response(response.body, { status: response.status, headers });
      }
    }

    // Standard API & Viewport Routing
    return await this.handleApiRoute(request, url);
  }

  /**
   * Resets the 14-day Cloudflare Alarm for idle cleanup.
   */
  private async refreshHibernationAlarm(): Promise<void> {
    try {
      const nextAlarmTime = Date.now() + GADGET_STORAGE_LIMITS.HIBERNATION_IDLE_MS;
      await this.ctx.storage.setAlarm(nextAlarmTime);
    } catch (err: any) {
      console.warn(`⚠️ Failed to set MicroAppDO hibernation alarm: ${err.message}`);
    }
  }

  /**
   * Calculates real-time SQLite storage footprint using SQLite PRAGMAs.
   */
  private async getStorageStats(): Promise<GadgetStorageStats> {
    const pageCountResult = this.ctx.storage.sql.exec("PRAGMA page_count;").toArray();
    const pageSizeResult = this.ctx.storage.sql.exec("PRAGMA page_size;").toArray();

    const pageCount = Number(pageCountResult[0]?.[Object.keys(pageCountResult[0])[0]] ?? 0);
    const pageSize = Number(pageSizeResult[0]?.[Object.keys(pageSizeResult[0])[0]] ?? 4096);
    const usedBytes = pageCount * pageSize;
    const maxBytes = GADGET_STORAGE_LIMITS.MAX_DO_FACET_BYTES;
    const usedPercentage = (usedBytes / maxBytes) * 100;

    const currentAlarm = await this.ctx.storage.getAlarm();

    return {
      instanceId: this.ctx.id.toString(),
      usedBytes,
      maxBytes,
      usedPercentage,
      pageCount,
      pageSize,
      isNearLimit: usedBytes >= GADGET_STORAGE_LIMITS.WARNING_DO_FACET_BYTES,
      isQuotaExceeded: usedBytes >= maxBytes,
      lastAccessedAt: new Date(this.lastAccessedAt).toISOString(),
      nextScheduledVacuumAt: currentAlarm ? new Date(currentAlarm).toISOString() : undefined
    };
  }

  /**
   * Pre-flight verification checking if a mutation is allowed under the 50MB quota.
   */
  private async verifyStorageQuota(): Promise<{ allowed: boolean; stats: GadgetStorageStats }> {
    const stats = await this.getStorageStats();
    return {
      allowed: !stats.isQuotaExceeded,
      stats
    };
  }

  /**
   * Cloudflare Alarm Handler triggered after 14 days of inactivity.
   * Reclaims deleted SQLite pages and signals SpaceDO that this gadget is hibernating.
   */
  async alarm(): Promise<void> {
    console.log(`⏰ [MicroAppDO] Alarm triggered for inactive gadget instance ${this.ctx.id.toString()}`);

    try {
      // 1. Reclaim deleted space via incremental vacuum
      this.ctx.storage.sql.exec("PRAGMA incremental_vacuum;");
      console.log(`🧹 [MicroAppDO] Incremental vacuum completed for instance ${this.ctx.id.toString()}`);

      // 2. Fetch updated stats post-vacuum
      const stats = await this.getStorageStats();

      // 3. Notify SpaceDO registry if storage is low or if instance is eligible for hibernation
      const envAny = this.env as any;
      if (envAny.SPACES_WORKER) {
        await envAny.SPACES_WORKER.fetch(`http://internal/spaces/gadgets/${this.ctx.id.toString()}/hibernate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instanceId: this.ctx.id.toString(),
            lastAccessedAt: new Date(this.lastAccessedAt).toISOString(),
            finalStorageBytes: stats.usedBytes
          })
        });
      }
    } catch (err: any) {
      console.error(`❌ [MicroAppDO] Alarm execution failed for ${this.ctx.id.toString()}: ${err.message}`);
    }
  }

  /**
   * Primary HTTP Router for Micro-App APIs and SSR HTML Viewports
   */
  private async handleApiRoute(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/" || url.pathname === "/app") {
      const appHtml = await this.ctx.storage.get<string>("app_bundle_html");
      return new Response(appHtml || "<html><body><h1>Micro-App Initializing...</h1></body></html>", {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname.startsWith("/api/data")) {
      if (request.method === "GET") {
        const rows = this.ctx.storage.sql.exec("SELECT * FROM app_records ORDER BY created_at DESC LIMIT 100;").toArray();
        return Response.json({ ok: true, data: rows });
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;
        const recordId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        this.ctx.storage.sql.exec(
          "INSERT INTO app_records (id, data_json, created_at) VALUES (?, ?, datetime('now'));",
          recordId,
          JSON.stringify(body)
        );

        return Response.json({ ok: true, id: recordId, message: "Record saved to DO Facet SQLite." });
      }
    }

    return new Response(JSON.stringify({ status: "ok", name: "MicroAppDO" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
