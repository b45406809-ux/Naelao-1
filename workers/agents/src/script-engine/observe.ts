/**
 * Environment observation as a script (spec §9). Observation is not a special tool type —
 * it is a script, loaded at startup and called via script.run('observe_x'). Different
 * environments have different observe scripts; the core loop never changes.
 *
 * This module ships the platform observe scripts that need no external environment:
 *   observe_filesystem (Tier 1, R2) and observe_api (Tier 2). observe_browser requires the
 *   browser-use prebuilt (deferred this build).
 */

import type { ScriptEngineEnv, ObserveSnapshot } from "./types.js";
import { computeFingerprint } from "./fingerprint.js";

/** observe_filesystem (spec §9.2) — hashes the workspace structure + recent changes. */
export async function observeFilesystem(
  env: ScriptEngineEnv,
  path = ""
): Promise<ObserveSnapshot> {
  const bucket = env.workspaceBucket ?? env.scriptsBucket;
  const prefix = `spaces/${env.spaceId}/workspace/${String(path).replace(/^\/+/, "")}`;
  const objects: Array<{ key: string; size: number; modified: number }> = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    for (const o of listing.objects) {
      objects.push({ key: o.key, size: o.size, modified: o.uploaded.getTime() });
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  const now = Date.now();
  const structure = objects.map((o) => `${o.key}:${o.size}`).sort();
  const fingerprint = await computeFingerprint({ structure });

  return {
    type: "filesystem",
    timestamp: now,
    path,
    file_count: objects.length,
    total_size: objects.reduce((s, o) => s + o.size, 0),
    recent_changes: objects.filter((o) => now - o.modified < 300_000).map((o) => o.key),
    fingerprint,
  };
}

/** observe_api (spec §9.3) — diffs response schema + status against a baseline. */
export async function observeApi(
  endpoint: string,
  authHeader?: string
): Promise<ObserveSnapshot> {
  const resp = await fetch(endpoint, authHeader ? { headers: { Authorization: authHeader } } : undefined);
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const fieldNames = body && typeof body === "object" ? Object.keys(body as object).sort() : [];
  const fingerprint = await computeFingerprint({ status: resp.status, fields: fieldNames });
  return {
    type: "api",
    timestamp: Date.now(),
    endpoint,
    status: resp.status,
    field_names: fieldNames,
    pagination_present: fieldNames.includes("next") || fieldNames.includes("cursor"),
    fingerprint,
  };
}

/** Resolve a startup observe script by name. Returns an empty snapshot for unknown names. */
export async function runObserve(
  env: ScriptEngineEnv,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ObserveSnapshot> {
  switch (name) {
    case "observe_filesystem":
      return observeFilesystem(env, typeof args["path"] === "string" ? (args["path"] as string) : "");
    case "observe_api":
      return observeApi(String(args["endpoint"] ?? ""), args["auth_header"] as string | undefined);
    default:
      return { type: "none", timestamp: Date.now(), fingerprint: await computeFingerprint({ name }) };
  }
}
