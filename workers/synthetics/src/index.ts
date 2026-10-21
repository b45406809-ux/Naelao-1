// G-BE04: Synthetic Monitoring Worker — CF Cron triggered health checks
interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  PLATFORM_API_URL: string;
  ANALYTICS?: AnalyticsEngineDataset;
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
  env: Pick<Env, "PLATFORM_DB" | "PLATFORM_API_URL" | "ANALYTICS">,
  fetcher: typeof fetch = fetch,
): Promise<SyntheticResult[]> {
  const checks = buildSyntheticChecks(env.PLATFORM_API_URL);
  const results = await Promise.all(checks.map(({ name, url }) => runCheckWithFetch(url, name, fetcher)));
  await env.PLATFORM_DB.prepare(
    "DELETE FROM synthetic_results WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')"
  ).run().catch(() => undefined);
  await Promise.all(results.map(async (result) => {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO synthetic_results (id, check_name, url, status, latency_ms, success, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), result.check_name, result.url, result.status, result.latency_ms,
      result.success ? 1 : 0, result.error ?? null, result.timestamp,
    ).run().catch(() => undefined);

    // Persist alert state in D1 so a minute-by-minute outage produces one notification,
    // while a recovery followed by a new outage produces another.
    await env.PLATFORM_DB.prepare(
      `INSERT INTO synthetic_check_state (check_name, failure_active, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(check_name) DO UPDATE SET failure_active = excluded.failure_active, updated_at = excluded.updated_at
       WHERE synthetic_check_state.failure_active != excluded.failure_active
       RETURNING failure_active`
    ).bind(result.check_name, result.success ? 0 : 1, result.timestamp)
      .first<{ failure_active: number }>().catch(() => null);

    if (env.ANALYTICS) {
      try {
        env.ANALYTICS.writeDataPoint({
          blobs: [result.check_name, result.url, result.success ? "success" : "failure"],
          doubles: [result.latency_ms, result.status], indexes: [result.check_name],
        });
      } catch { /* Analytics Engine is best effort; D1 is the durable record. */ }
    }
    if (!result.success) {
      const state = await env.PLATFORM_DB.prepare(
        "SELECT updated_at FROM synthetic_check_state WHERE check_name = ? AND failure_active = 1"
      ).bind(result.check_name).first<{ updated_at: string }>().catch(() => null);
      if (state) {
        // The failure transition timestamp is stable throughout one outage. Repeated
        // attempts use the same primary key, so a transient D1 write failure retries
        // safely and concurrent cron invocations cannot duplicate the operator alert.
        const failureId = `synthetic:${result.check_name}:${state.updated_at}`;
        const payload = JSON.stringify({ check_name: result.check_name, url: result.url, status: result.status, latency_ms: result.latency_ms, error: result.error });
        await env.PLATFORM_DB.prepare(
          `INSERT OR IGNORE INTO platform_failures (id, message_type, payload_json, failure_reason, failed_at, retry_count, reviewed)
           VALUES (?, 'synthetic_check_failure', ?, ?, ?, 0, 0)`
        ).bind(failureId, payload, `Synthetic check failed: ${result.check_name} (${result.error ?? `HTTP ${result.status}`})`.slice(0, 600), state.updated_at)
          .run().catch(() => undefined);
      }
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
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500), timestamp };
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
