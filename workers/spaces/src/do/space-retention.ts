export interface RetainedMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  tool_call_id: string | null;
  tool_name: string | null;
  token_count: number | null;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export async function fingerprintRetainedMessages(rows: readonly RetainedMessageRow[]): Promise<string> {
  const bytes = new TextEncoder().encode(stable([...rows].sort((a, b) => a.id.localeCompare(b.id))));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function retainedMessageBytes(rows: readonly RetainedMessageRow[]): number {
  return rows.reduce((total, row) => total + new TextEncoder().encode(stable(row)).byteLength, 0);
}

export interface StorageMeasurement { allocatedBytes: number; measuredAt: string; }
export function forecastSpaceStorage(
  measurements: readonly StorageMeasurement[],
  targetBytes: number | null,
  warningThresholdPct: number,
): { currentBytes: number; projected30DayBytes: number | null; targetBytes: number | null; warning: boolean | null; estimate: "measured_linear_trend" | "insufficient_history" } {
  const sorted = [...measurements].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  const currentBytes = sorted.at(-1)?.allocatedBytes ?? 0;
  const first = sorted[0], last = sorted.at(-1);
  if (!first || !last || first === last || targetBytes === null) {
    return { currentBytes, projected30DayBytes: null, targetBytes, warning: null, estimate: "insufficient_history" };
  }
  const elapsedMs = Date.parse(last.measuredAt) - Date.parse(first.measuredAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 86_400_000) {
    return { currentBytes, projected30DayBytes: null, targetBytes, warning: null, estimate: "insufficient_history" };
  }
  const days = elapsedMs / 86_400_000;
  const dailyGrowth = (last.allocatedBytes - first.allocatedBytes) / days;
  const projected30DayBytes = Math.max(0, Math.ceil(currentBytes + dailyGrowth * 30));
  const threshold = targetBytes * warningThresholdPct / 100;
  return { currentBytes, projected30DayBytes, targetBytes, warning: projected30DayBytes >= threshold, estimate: "measured_linear_trend" };
}
