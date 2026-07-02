/**
 * Naelao Analytics Worker — Phase 8: Analytics + Observability
 *
 * Gap IDs fulfilled:
 *   G-H01  CF Analytics Engine write path (writeEvent)
 *   G-H02  Analytics query (space / tenant / platform metrics via REST API)
 *   G-H03  KV metrics cache (5-min TTL per space/tenant)
 *   G-H04  Queue consumer — drain analytics event queue into Analytics Engine
 *
 * Routing note: The router worker should forward /analytics/* and /metrics/*
 * requests to this worker via an ANALYTICS_WORKER service binding.
 * e.g.  fetch(env.ANALYTICS_WORKER, request)  for paths matching the above.
 *
 * Two modes:
 *   1. Ingest  — POST /events  (internal, service-binding-only — no JWT)
 *   2. Query   — GET  /metrics/space/:spaceId
 *               GET  /metrics/tenant
 *               GET  /metrics/platform  (admin, requires x-naelao-role: owner)
 */

import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";
import { type AnalyticsEvent, writeEvent } from "./events.js";
import {
  getPlatformMetrics,
  getSpaceMetrics,
  getTenantMetrics,
} from "./query.js";

// ── Environment ───────────────────────────────────────────────────────────────

export interface AnalyticsEnv {
  ENVIRONMENT: string;
  CF_ACCOUNT_ID: string;
  CF_ANALYTICS_API_TOKEN: string;
  ANALYTICS: AnalyticsEngineDataset;
  METRICS_CACHE: KVNamespace;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse and validate a period query param. Allowed: 7, 30, 90. Default: 30. */
function parsePeriod(raw: string | null): number {
  const n = parseInt(raw ?? "30", 10);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
}

/** Minimal structural validation for an inbound AnalyticsEvent. */
function isValidEvent(obj: unknown): obj is AnalyticsEvent {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e["eventType"] === "string" &&
    e["eventType"].length > 0 &&
    typeof e["tenantId"] === "string" &&
    e["tenantId"].length > 0
  );
}

/** Write a batch of events to Analytics Engine, silently dropping invalid ones. */
function writeBatch(
  dataset: AnalyticsEngineDataset,
  events: unknown[]
): number {
  let written = 0;
  for (const raw of events) {
    if (!isValidEvent(raw)) continue;
    try {
      writeEvent(dataset, raw);
      written++;
    } catch {
      // Silently drop — never fail the caller due to analytics
    }
  }
  return written;
}

// G-A11: Validate required secrets at startup
function validateEnv(env: AnalyticsEnv): void {
  const required = ["CF_ACCOUNT_ID", "CF_ANALYTICS_API_TOKEN"] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required secret: ${key}`);
  }
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: AnalyticsEnv }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// ── POST /events ──────────────────────────────────────────────────────────────
// Internal ingest endpoint — no JWT auth required.
// Called by other workers via CF service binding.
// Accepts a single AnalyticsEvent or { events: AnalyticsEvent[] } (batch ≤100).
app.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // If the caller sends malformed JSON, return OK to avoid blocking them
    return c.json({ ok: true, count: 0 });
  }

  let count = 0;

  if (
    body !== null &&
    typeof body === "object" &&
    "events" in (body as object)
  ) {
    // Batch mode
    const batch = (body as { events: unknown }).events;
    const events = Array.isArray(batch) ? batch.slice(0, 100) : [];
    count = writeBatch(c.env.ANALYTICS, events);
  } else {
    // Single event mode
    count = writeBatch(c.env.ANALYTICS, [body]);
  }

  return c.json({ ok: true, count });
});

// ── GET /metrics/space/:spaceId ───────────────────────────────────────────────
// Authenticated — requires x-naelao-tenant-id header (set by router JWT check).
// Cached in METRICS_CACHE for 5 minutes.
app.get("/metrics/space/:spaceId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) {
    return c.json(
      { error_code: "unauthorized", message: "Missing x-naelao-tenant-id header" },
      401
    );
  }

  const spaceId = c.req.param("spaceId");
  const period = parsePeriod(new URL(c.req.url).searchParams.get("period"));

  const cacheKey = `metrics:space:${spaceId}:${period}`;
  const cached = await c.env.METRICS_CACHE.get(cacheKey, "text");
  if (cached) {
    return new Response(cached, {
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  const accountId = c.env.CF_ACCOUNT_ID;
  const apiToken = c.env.CF_ANALYTICS_API_TOKEN;

  if (!accountId || !apiToken) {
    return c.json(
      {
        error_code: "configuration_error",
        message: "CF_ACCOUNT_ID and CF_ANALYTICS_API_TOKEN must be configured",
      },
      503
    );
  }

  const metrics = await getSpaceMetrics(
    accountId,
    apiToken,
    spaceId,
    tenantId,
    period
  );

  const body = JSON.stringify(metrics);
  // Cache for 5 minutes (300s)
  await c.env.METRICS_CACHE.put(cacheKey, body, { expirationTtl: 300 });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
});

// ── GET /metrics/tenant ───────────────────────────────────────────────────────
// Authenticated — requires x-naelao-tenant-id header.
// Cached in METRICS_CACHE for 5 minutes.
app.get("/metrics/tenant", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) {
    return c.json(
      { error_code: "unauthorized", message: "Missing x-naelao-tenant-id header" },
      401
    );
  }

  const period = parsePeriod(new URL(c.req.url).searchParams.get("period"));
  const cacheKey = `metrics:tenant:${tenantId}:${period}`;

  const cached = await c.env.METRICS_CACHE.get(cacheKey, "text");
  if (cached) {
    return new Response(cached, {
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  const accountId = c.env.CF_ACCOUNT_ID;
  const apiToken = c.env.CF_ANALYTICS_API_TOKEN;

  if (!accountId || !apiToken) {
    return c.json(
      {
        error_code: "configuration_error",
        message: "CF_ACCOUNT_ID and CF_ANALYTICS_API_TOKEN must be configured",
      },
      503
    );
  }

  const metrics = await getTenantMetrics(accountId, apiToken, tenantId, period);

  const body = JSON.stringify(metrics);
  await c.env.METRICS_CACHE.put(cacheKey, body, { expirationTtl: 300 });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
});

// ── GET /metrics/platform ─────────────────────────────────────────────────────
// Admin-only: requires both x-naelao-role: owner header AND a shared
// internal secret (x-naelao-platform-secret) to prevent external callers.
// No KV cache — admins always get fresh data.
app.get("/metrics/platform", async (c) => {
  // Role check: must be platform owner
  const role = c.req.header("x-naelao-role") ?? "";
  if (role !== "owner") {
    return c.json(
      { error_code: "forbidden", message: "Platform metrics require owner role" },
      403
    );
  }

  // Internal secret check: prevents external access even if someone sends the
  // owner role header through a misconfigured proxy.
  // The router must set x-naelao-platform-secret from CF Workers Secrets before
  // forwarding to this worker via service binding.
  const platformSecret = c.req.header("x-naelao-platform-secret") ?? "";
  // If no secret is configured in the environment (e.g. dev), skip the check.
  // In production, PLATFORM_ANALYTICS_SECRET must be set.
  const envSecret =
    (c.env as unknown as Record<string, string>)["PLATFORM_ANALYTICS_SECRET"] ??
    "";
  if (envSecret && platformSecret !== envSecret) {
    return c.json(
      { error_code: "forbidden", message: "Invalid internal secret" },
      403
    );
  }

  const period = parsePeriod(new URL(c.req.url).searchParams.get("period"));

  const accountId = c.env.CF_ACCOUNT_ID;
  const apiToken = c.env.CF_ANALYTICS_API_TOKEN;

  if (!accountId || !apiToken) {
    return c.json(
      {
        error_code: "configuration_error",
        message: "CF_ACCOUNT_ID and CF_ANALYTICS_API_TOKEN must be configured",
      },
      503
    );
  }

  const metrics = await getPlatformMetrics(accountId, apiToken, period);

  return c.json(metrics);
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) =>
  errorResponse(err, c.get("requestId") ?? "unknown")
);

// ── 404 catch-all ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json({ error_code: "not_found", message: "Route not found" }, 404)
);

// ── Queue consumer ────────────────────────────────────────────────────────────
// G-H04: Drains the naelao-analytics-events queue into CF Analytics Engine.
// Each message in the batch is an AnalyticsEvent written by other workers.
// Messages are ack'd individually after a successful write so that transient
// errors cause a retry (message stays in queue) rather than silent data loss.

export async function queue(
  batch: MessageBatch<AnalyticsEvent>,
  env: AnalyticsEnv
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (isValidEvent(message.body)) {
        writeEvent(env.ANALYTICS, message.body);
      }
      // Ack even for invalid messages — we don't want to retry unparseable events
      message.ack();
    } catch (err) {
      console.error("[analytics/queue] failed to write event:", err);
      // Retry: do NOT ack — CF Queues will retry up to max_retries
      message.retry();
    }
  }
}

// ── Default export ────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  queue: queue as ExportedHandlerQueueHandler<AnalyticsEnv>,
} satisfies ExportedHandler<AnalyticsEnv>;
