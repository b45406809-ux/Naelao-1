"use client";

import * as React from "react";
import { callSpaceSharedExtensionApi, type SessionCredentials } from "@/lib/api";

export interface MicroAppStorageUsage {
  appId: string;
  tier: 1 | 2 | 3;
  allocatedBytes: number;
  limitBytes: number;
  utilizationPercent: number;
  measuredAt: string;
}

const EXPECTED_LIMITS: Record<1 | 2 | 3, number> = {
  1: 25 * 1024 * 1024,
  2: 100 * 1024 * 1024,
  3: 250 * 1024 * 1024,
};

export function parseMicroAppStorageUsage(value: unknown, expectedAppId: string): MicroAppStorageUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("storage_response_invalid");
  const body = value as Record<string, unknown>;
  const tier = body.tier;
  if (body.appId !== expectedAppId || (tier !== 1 && tier !== 2 && tier !== 3)
    || body.limitBytes !== EXPECTED_LIMITS[tier]
    || !Number.isSafeInteger(body.allocatedBytes) || Number(body.allocatedBytes) < 0
    || typeof body.utilizationPercent !== "number" || !Number.isFinite(body.utilizationPercent) || body.utilizationPercent < 0
    || typeof body.measuredAt !== "string" || !Number.isFinite(Date.parse(body.measuredAt))
    || body.measurement !== "sqlite_page_count_times_page_size" || body.monthlyCostEstimateUsd !== null
    || typeof body.costEstimateReason !== "string" || body.costEstimateReason.length > 300) {
    throw new Error("storage_response_invalid");
  }
  return { appId: expectedAppId, tier, allocatedBytes: Number(body.allocatedBytes), limitBytes: EXPECTED_LIMITS[tier],
    utilizationPercent: Number(body.utilizationPercent), measuredAt: body.measuredAt };
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function MicroAppStorageStatus({ spaceId, appId, session }: { spaceId: string; appId: string; session: SessionCredentials }) {
  const [usage, setUsage] = React.useState<MicroAppStorageUsage | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    setUsage(null); setError(null);
    void callSpaceSharedExtensionApi(spaceId, appId, session, { method: "GET", path: "/api/storage" })
      .then(result => { if (current) setUsage(parseMicroAppStorageUsage(result, appId)); })
      .catch(() => { if (current) setError("Storage usage is unavailable. Retry by reopening this extension."); });
    return () => { current = false; };
  }, [appId, session, spaceId]);

  return <section aria-label="MicroApp storage" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 12, marginBottom: 16 }}>
    <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>App storage</h2>
    {error ? <p role="alert">{error}</p> : usage === null ? <p role="status">Loading storage usage…</p> : <>
      <p role="status">Tier {usage.tier} · {formatMiB(usage.allocatedBytes)} of {formatMiB(usage.limitBytes)} logical storage used</p>
      <progress aria-label="App storage capacity" max={100} value={Math.min(100, usage.utilizationPercent)} />
      {usage.tier === 1 && <p>Tier 1 data is erased after 14 days without activity. Keep essential business records in a durable tier.</p>}
      <p style={{ color: "var(--text3)", fontSize: 12 }}>
        This measures allocated SQLite pages at {new Date(usage.measuredAt).toLocaleString()}. It is not a provider cost estimate; Durable Object charges cannot be attributed from this measurement.
      </p>
    </>}
  </section>;
}
