import type { Agent37WorkspaceUsage } from "./providers/agent37.js";

type UsageDatabase = Pick<D1Database, "prepare">;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Store a minimized account-level API observation; never retain instance ids, model names or raw provider bodies. */
export async function recordAgent37ProviderUsageSnapshot(db: UsageDatabase, input: {
  tenantId: string;
  ownerId: string;
  connectionRef: string;
  usage: Agent37WorkspaceUsage;
  observedAt?: string;
}) {
  if (!ID.test(input.tenantId) || !ID.test(input.ownerId) || input.connectionRef.length < 3 || input.connectionRef.length > 512
    || !validDay(input.usage.from) || !validDay(input.usage.to) || input.usage.from > input.usage.to
    || dayDistance(input.usage.from, input.usage.to) > 89 || !validMicros(input.usage.totalMicros)
    || !Array.isArray(input.usage.byIntegration) || input.usage.byIntegration.length > 5) throw new Error("agent37_usage_snapshot_invalid");
  const allowed = new Set(["compute", "llm", "brave", "composio", "perflo"]);
  const byIntegration = input.usage.byIntegration.map((entry) => {
    if (!allowed.has(entry.kind) || !validMicros(entry.costMicros)
      || (entry.awakeMinutes !== undefined && !validMicros(entry.awakeMinutes))) throw new Error("agent37_usage_snapshot_invalid");
    return { kind: entry.kind, costMicros: entry.costMicros, ...(entry.awakeMinutes !== undefined ? { awakeMinutes: entry.awakeMinutes } : {}) };
  });
  if (new Set(byIntegration.map((entry) => entry.kind)).size !== byIntegration.length) throw new Error("agent37_usage_snapshot_invalid");
  const usageJson = JSON.stringify({ currency: "USD", totalMicros: input.usage.totalMicros, byIntegration });
  const [connectionHash, evidenceHash] = await Promise.all([
    sha256(input.connectionRef), sha256(JSON.stringify([input.usage.from, input.usage.to, "USD", input.usage.totalMicros, byIntegration])),
  ]);
  const id = `agu_${await sha256(`${input.tenantId}\0${connectionHash}\0${input.usage.from}\0${input.usage.to}\0${evidenceHash}`)}`;
  const observedAt = input.observedAt ? new Date(input.observedAt).toISOString() : new Date().toISOString();
  const result = await db.prepare(`INSERT OR IGNORE INTO sandbox_agent37_usage_snapshots(
    id,tenant_id,owner_id,connection_ref_sha256,period_start,period_end,total_cost_micros,usage_json,evidence_sha256,source_api,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,'agent37.usage',?)`).bind(id,input.tenantId,input.ownerId,connectionHash,input.usage.from,input.usage.to,
    input.usage.totalMicros,usageJson,evidenceHash,observedAt).run();
  return { inserted: result.meta.changes === 1, replayed: result.meta.changes !== 1, provenance: "provider_api_observed" as const,
    provider: "agent37" as const, sourceApi: "agent37.usage", currency: "USD", from: input.usage.from, to: input.usage.to,
    totalMicros: input.usage.totalMicros, byIntegration, observedAt };
}

function validMicros(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 9_000_000_000_000; }
function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dayDistance(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
