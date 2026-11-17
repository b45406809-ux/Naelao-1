"use client";

import * as React from "react";
import { callProjectExtensionStorageUsage, callSpaceSharedExtensionApi, type ContainerInstallation, type SessionCredentials } from "@/lib/api";

export interface MicroAppStorageUsage {
  appId: string;
  tier: 1 | 2 | 3;
  allocatedBytes: number;
  limitBytes: number;
  utilizationPercent: number;
  measuredAt: string;
  structuredDataUsage: { installationId: string; tableCount: number; rowCount: number; valueBytes: number } | null;
}

export function projectGadgetStorageApps(installation: ContainerInstallation, projectId: string): Array<{ appId: string; name: string; installationId: string }> {
  const { instance, manifest } = installation;
  const installationId = instance.instance_id;
  const bundle = manifest.bundle;
  if (typeof installationId !== "string" || !installationId) return [];
  const verifiedInstallationId = installationId;
  if (instance.project_id !== projectId || instance.status !== "active"
    || manifest.id !== instance.extension_id || bundle?.id !== instance.extension_id
    || !instance.release_version || bundle.version !== instance.release_version) return [];
  const instanceKey = instance.instance_key ?? "default";
  if (instanceKey !== "default" && !/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return [];
  const prefix = instanceKey === "default" ? "" : instanceKey + "_";
  return (bundle.primitives ?? []).flatMap(primitive => {
    if (primitive.kind !== "gadget" || !["PROJECT_BOUND", "PROJECT_SHARED"].includes(primitive.scope ?? "")
      || typeof primitive.id !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(primitive.id)) return [];
    const appId = prefix + primitive.id;
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return [];
    return [{ appId, name: typeof primitive.name === "string" && primitive.name.trim() ? primitive.name.slice(0, 100) : primitive.id,
      installationId: verifiedInstallationId }];
  });
}

const EXPECTED_LIMITS: Record<1 | 2 | 3, number> = {
  1: 25 * 1024 * 1024,
  2: 100 * 1024 * 1024,
  3: 250 * 1024 * 1024,
};

export function parseMicroAppStorageUsage(value: unknown, expectedAppId: string, expectedInstallationId?: string): MicroAppStorageUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("storage_response_invalid");
  const body = value as Record<string, unknown>;
  const tier = body.tier;
  const structuredData = body.structuredDataUsage;
  const structuredDataUsage = structuredData === null ? null : structuredData && typeof structuredData === "object" && !Array.isArray(structuredData)
    ? structuredData as Record<string, unknown> : null;
  const structuredValid = body.structuredDataUsage === null || !!structuredDataUsage
    && typeof structuredDataUsage.installationId === "string"
    && (!expectedInstallationId || structuredDataUsage.installationId === expectedInstallationId)
    && structuredDataUsage.measurement === "sqlite_user_table_value_bytes"
    && ["tableCount", "rowCount", "valueBytes"].every(key => Number.isSafeInteger(structuredDataUsage[key]) && Number(structuredDataUsage[key]) >= 0);
  if (body.appId !== expectedAppId || (tier !== 1 && tier !== 2 && tier !== 3)
    || body.limitBytes !== EXPECTED_LIMITS[tier]
    || !Number.isSafeInteger(body.allocatedBytes) || Number(body.allocatedBytes) < 0
    || typeof body.utilizationPercent !== "number" || !Number.isFinite(body.utilizationPercent) || body.utilizationPercent < 0
    || typeof body.measuredAt !== "string" || !Number.isFinite(Date.parse(body.measuredAt))
    || body.measurement !== "sqlite_page_count_times_page_size" || body.monthlyCostEstimateUsd !== null
    || typeof body.costEstimateReason !== "string" || body.costEstimateReason.length > 300 || !structuredValid
    || expectedInstallationId !== undefined && (!structuredDataUsage || structuredDataUsage.installationId !== expectedInstallationId)) {
    throw new Error("storage_response_invalid");
  }
  return { appId: expectedAppId, tier, allocatedBytes: Number(body.allocatedBytes), limitBytes: EXPECTED_LIMITS[tier],
    utilizationPercent: Number(body.utilizationPercent), measuredAt: body.measuredAt,
    structuredDataUsage: structuredDataUsage ? { installationId: String(structuredDataUsage.installationId),
      tableCount: Number(structuredDataUsage.tableCount), rowCount: Number(structuredDataUsage.rowCount), valueBytes: Number(structuredDataUsage.valueBytes) } : null };
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function MicroAppStorageStatus({ spaceId, appId, session, projectId, installationId, name }: {
  spaceId: string; appId: string; session: SessionCredentials; projectId?: string; installationId?: string; name?: string;
}) {
  const [usage, setUsage] = React.useState<MicroAppStorageUsage | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    setUsage(null); setError(null);
    const request = projectId && installationId
      ? callProjectExtensionStorageUsage(spaceId, projectId, appId, installationId, session)
      : callSpaceSharedExtensionApi(spaceId, appId, session, { method: "GET", path: "/api/storage" });
    void request
      .then(result => { if (current) setUsage(parseMicroAppStorageUsage(result, appId, installationId)); })
      .catch(() => { if (current) setError("Storage usage is unavailable. Retry by reopening this extension."); });
    return () => { current = false; };
  }, [appId, installationId, projectId, session, spaceId]);

  return <section aria-label="MicroApp storage" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 12, marginBottom: 16 }}>
    <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>App storage{name ? " · " + name : ""}</h2>
    {error ? <p role="alert">{error}</p> : usage === null ? <p role="status">Loading storage usage…</p> : <>
      <p role="status">Tier {usage.tier} · {formatMiB(usage.allocatedBytes)} of {formatMiB(usage.limitBytes)} logical storage used</p>
      {usage.structuredDataUsage && <p role="status">Structured data · {usage.structuredDataUsage.tableCount} tables · {usage.structuredDataUsage.rowCount} rows · {formatMiB(usage.structuredDataUsage.valueBytes)} stored value bytes</p>}
      <progress aria-label="App storage capacity" max={100} value={Math.min(100, usage.utilizationPercent)} />
      {usage.tier === 1 && <p>Tier 1 data is erased after 14 days without activity. Keep essential business records in a durable tier.</p>}
      <p style={{ color: "var(--text3)", fontSize: 12 }}>
        This measures allocated SQLite pages at {new Date(usage.measuredAt).toLocaleString()}. It is not a provider cost estimate; Durable Object charges cannot be attributed from this measurement.
      </p>
    </>}
  </section>;
}
