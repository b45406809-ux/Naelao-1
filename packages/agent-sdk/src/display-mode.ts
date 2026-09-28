import type { DisplayMode, ExecutionTelemetry } from "./types.js";

const INTERNAL_FIELDS = new Set(["commit_oid", "git_oid", "raw_tier_id", "v8_cold_start_log", "token_breakdown"]);

/** Produces a new object; nested telemetry is recursively redacted without mutating stored data. */
export function projectExecutionTelemetry<T extends ExecutionTelemetry>(telemetry: T, mode: DisplayMode): Partial<T> {
  if (mode === "developer") return structuredClone(telemetry);
  return Object.fromEntries(Object.entries(telemetry).filter(([key]) => !INTERNAL_FIELDS.has(key))) as Partial<T>;
}
