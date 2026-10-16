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

export async function runCheck(url: string, name: string): Promise<SyntheticResult> {
  return runCheckWithFetch(url, name, fetch);
}

/** Execute the check batch and persist each result. Kept injectable so local tests can
 * exercise timeout/failure handling, persistence, and alerts without live services. */
export async function runSyntheticCycle(
  env: Pick<Env, "PLATFORM_DB" | "PLATFORM_API_URL" | "ANALYTICS" | "NOTIFICATIONS_QUEUE">,
  fetcher: typeof fetch = fetch,
): Promise<SyntheticResult[]> {
  const checks = buildSyntheticChecks(env.PLATFORM_API_URL);
  const results = await Promise.all(checks.map(({ name, url }) => runCheckWithFetch(url, name, fetcher)));
  await Promise.all(results.map(async (result) => {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO synthetic_results (id, check_name, url, status, latency_ms, success, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), result.check_name, result.url, result.status, result.latency_ms,
      result.success ? 1 : 0, result.error ?? null, result.timestamp,
    ).run().catch(() => undefined);

    if (env.ANALYTICS) {
      try {
        env.ANALYTICS.writeDataPoint({
          blobs: [result.check_name, result.url, result.success ? "success" : "failure"],
          doubles: [result.latency_ms, result.status], indexes: [result.check_name],
        });
      } catch { /* Analytics Engine is best effort; D1 is the durable record. */ }
    }
    if (!result.success && env.NOTIFICATIONS_QUEUE) {
      await env.NOTIFICATIONS_QUEUE.send({
        type: "in_app", tenantId: "platform",
        subject: `Synthetic check failed: ${result.check_name}`,
        html: `Check ${result.check_name} failed: ${result.error ?? `HTTP ${result.status}`}`,
      }).catch(() => undefined);
    }
  }));
  return results;
}

async function runCheckWithFetch(url: string, name: string, fetcher: typeof fetch): Promise<SyntheticResult> {
  const timestamp = new Date().toISOString();
  const start = Date.now();
  try {
    const resp = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { "x-synthetic-check": "true" } });
    return { check_name: name, url, status: resp.status, latency_ms: Date.now() - start, success: resp.ok, timestamp };
  } catch (err) {
    return { check_name: name, url, status: 0, latency_ms: Date.now() - start, success: false,
      error: err instanceof Error ? err.message : String(err), timestamp };
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
    ctx.waitUntil(runSyntheticCycle(env));
  },
} satisfies ExportedHandler<Env>;
