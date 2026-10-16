// G-BE04: Synthetic Monitoring Worker — CF Cron triggered health checks
interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  PLATFORM_API_URL: string;
  ANALYTICS?: AnalyticsEngineDataset;
  NOTIFICATIONS_QUEUE?: Queue;
}

interface SyntheticResult {
  check_name: string;
  url: string;
  status: number;
  latency_ms: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

async function runCheck(url: string, name: string): Promise<SyntheticResult> {
  const timestamp = new Date().toISOString();
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "x-synthetic-check": "true" },
    });
    const latency_ms = Date.now() - start;
    return { check_name: name, url, status: resp.status, latency_ms, success: resp.ok, timestamp };
  } catch (err) {
    const latency_ms = Date.now() - start;
    return {
      check_name: name,
      url,
      status: 0,
      latency_ms,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      timestamp,
    };
  }
}

export function buildSyntheticChecks(apiBase: string): Array<{ name: string; url: string }> {
  const base = apiBase.replace(/\/+$/, "");
  return [
    { name: "router_health", url: `${base}/health` },
    { name: "platform_dependencies", url: `${base}/health/dependencies` },
  ];
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
    return new Response(JSON.stringify({ ok: true, service: "synthetics" }), {
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");

    const apiBase = env.PLATFORM_API_URL;
    const checks = buildSyntheticChecks(apiBase);

    const results = await Promise.all(checks.map(c => runCheck(c.url, c.name)));

    // Store results in D1 and write to Analytics Engine
    ctx.waitUntil(Promise.all(results.map(async (result) => {
      try {
        await env.PLATFORM_DB.prepare(
          `INSERT INTO synthetic_results (id, check_name, url, status, latency_ms, success, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          result.check_name,
          result.url,
          result.status,
          result.latency_ms,
          result.success ? 1 : 0,
          result.error ?? null,
          result.timestamp,
        ).run();
      } catch { /* best-effort */ }

      if (env.ANALYTICS) {
        try {
          env.ANALYTICS.writeDataPoint({
            blobs: [result.check_name, result.url, result.success ? "success" : "failure"],
            doubles: [result.latency_ms, result.status],
            indexes: [result.check_name],
          });
        } catch { /* best-effort */ }
      }

      // Alert if failure detected
      if (!result.success && env.NOTIFICATIONS_QUEUE) {
        try {
          await env.NOTIFICATIONS_QUEUE.send({
            type: "in_app",
            tenantId: "platform",
            subject: `Synthetic check failed: ${result.check_name}`,
            html: `Check ${result.check_name} failed: ${result.error ?? `HTTP ${result.status}`}`,
          });
        } catch { /* best-effort */ }
      }
    })));
  },
} satisfies ExportedHandler<Env>;
