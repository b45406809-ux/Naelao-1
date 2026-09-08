Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 6 — Chunk 13**: `specs/phase-6/chunk-13-microapp-storage-quota-and-cleanup.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-13"
phase: 6
include_files:
  - workers/spaces/src/do/MicroAppDO.ts
  - packages/types/src/gadgets.ts
repomix_include:
  - "workers/spaces/src/do/MicroAppDO.ts"
  - "packages/types/src/gadgets.ts"
expected_outputs:
  - workers/spaces/src/do/MicroAppDO.ts
  - packages/types/src/gadgets.ts
---

# Phase 6 — Chunk 13: MicroAppDO Storage Quota Enforcement & Hibernation Cleanup

## 1. Executive Summary & Architectural Vision

On-demand stateful micro-apps ("Cloudflare OS Gadgets") run inside dedicated **`MicroAppDO` (Durable Object Facet)** instances, each backed by an isolated SQLite database.

Without hard storage quotas and automated idle cleanup routines, user-generated gadgets, temporary scrapers, and personal scratchpads can accumulate indefinitely, resulting in unbounded Cloudflare Durable Object storage costs and database bloat.

To ensure **92%+ gross profit margins** across all subscription tiers, this chunk implements a dual-layer storage governance engine:
1. **Hard Storage Quotas (50MB Cap per DO Facet):** Every mutating SQL transaction (`INSERT`, `UPDATE`, `CREATE TABLE`) checks the DO's current SQLite page footprint. Mutations that would push storage beyond 50MB (52,428,800 bytes) are rejected immediately at the edge proxy with HTTP `413 Payload Too Large`.
2. **14-Day Automated Hibernation & Vacuum Alarms:** Every request to a `MicroAppDO` sets or postpones a 14-day Cloudflare Alarm. If a gadget remains inactive for 14 consecutive days, the alarm triggers an automatic SQLite `VACUUM` to reclaim freed disk pages, and archives inactive Tier 1 (personal) gadgets into `hibernating` status.

```
[ Incoming Mutation Request to MicroAppDO (INSERT/UPDATE) ]
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. PRE-FLIGHT QUOTA CHECK (`checkStorageQuota`)                             │
│    Executes: `PRAGMA page_count * PRAGMA page_size`                         │
├─────────────────────────────────────────────────────────────────────────────┤
│    • Current Usage < 40MB (80%) ──► PASS: Proceed with mutation.            │
│    • Usage 40MB – 50MB        ──► WARNING: Include `X-Storage-Warning` header.│
│    • Usage >= 50MB (52.4MB)   ──► REJECT: Return 413 Payload Too Large.     │
└──────────────────────────┬──────────────────────────────────────────────────┘
                           │ (Mutation Approved)
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. RESET 14-DAY HIBERNATION ALARM                                           │
│    `this.ctx.storage.setAlarm(Date.now() + 14 * 86400 * 1000)`             │
└──────────────────────────┬──────────────────────────────────────────────────┘
                           │ (14 Days of Inactivity Pass)
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. ALARM HANDLER (`alarm()`)                                                │
│    • Executes `PRAGMA incremental_vacuum;`                                  │
│    • Updates status in `SpaceDO` to 'hibernating'.                          │
│    • Evicts DO instance from edge memory ($0 compute cost during idle).     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. `packages/types/src/gadgets.ts`

Extend `packages/types/src/gadgets.ts` to export storage quota constants, metrics interfaces, and error response contracts:

```typescript
/**
 * Storage Quota Constants (In Bytes)
 */
export const GADGET_STORAGE_LIMITS = {
  /** Hard storage ceiling per MicroAppDO Facet (50 Megabytes) */
  MAX_DO_FACET_BYTES: 52_428_800, // 50 * 1024 * 1024

  /** Soft storage warning threshold (40 Megabytes / 80%) */
  WARNING_DO_FACET_BYTES: 41_943_040, // 40 * 1024 * 1024

  /** Default alarm idle hibernation window (14 Days in Milliseconds) */
  HIBERNATION_IDLE_MS: 14 * 24 * 60 * 60 * 1000 // 1,209,600,000 ms
} as const;

/**
 * Storage Usage Metrics for a Gadget Instance
 */
export interface GadgetStorageStats {
  instanceId: string;
  usedBytes: number;
  maxBytes: number;
  usedPercentage: number;
  pageCount: number;
  pageSize: number;
  isNearLimit: boolean;
  isQuotaExceeded: boolean;
  lastAccessedAt: string;
  nextScheduledVacuumAt?: string;
}

/**
 * Error response payload when quota is exceeded
 */
export interface GadgetQuotaExceededError {
  error_code: "storage_quota_exceeded";
  message: string;
  currentBytes: number;
  maxBytes: number;
  instanceId: string;
}
```

---

### B. `workers/spaces/src/do/MicroAppDO.ts`

Update `MicroAppDO.ts` to enforce the 50MB pre-flight mutation gate, manage 14-day hibernation alarms, and expose a `/api/storage-stats` telemetry endpoint for canvas viewports:

```typescript
import { DurableObject } from "cloudflare:workers";
import { GADGET_STORAGE_LIMITS, GadgetStorageStats } from "@naelao/types";

export class MicroAppDO extends DurableObject {
  private lastAccessedAt: number = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
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
      if (this.env.SPACES_WORKER) {
        await this.env.SPACES_WORKER.fetch(`http://internal/spaces/gadgets/${this.ctx.id.toString()}/hibernate`, {
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

    return new Response("Not Found", { status: 404 });
  }
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `packages/types/src/gadgets.ts`:
   - Export constants `GADGET_STORAGE_LIMITS` (`MAX_DO_FACET_BYTES: 52428800`, `WARNING_DO_FACET_BYTES: 41943040`, `HIBERNATION_IDLE_MS`).
   - Export interfaces `GadgetStorageStats` and `GadgetQuotaExceededError`.
2. Update `workers/spaces/src/do/MicroAppDO.ts`:
   - Implement `getStorageStats()` using `PRAGMA page_count;` and `PRAGMA page_size;`.
   - Add pre-flight mutation gate in `fetch()` returning HTTP `413` when `usedBytes >= 52,428,800`.
   - Add `X-Gadget-Storage-Warning` response header when storage crosses 80% (40MB).
   - Implement 14-day alarm refresh (`refreshHibernationAlarm()`) on every incoming request.
   - Implement `alarm()` handler executing `PRAGMA incremental_vacuum;` and notifying `SPACES_WORKER`.
3. Run `node --check` syntax validation on the modified files.
```
