const WORKER_CHECKPOINT_FORMAT = "naelao.worker-checkpoint";
const MAX_CHECKPOINT_CHARS = 64_000;

export interface WorkerCheckpointV1 {
  schema_version: 1;
  format: typeof WORKER_CHECKPOINT_FORMAT;
  saved_at: number;
  attempt?: number;
  payload?: unknown;
  truncated?: true;
  original_chars?: number;
  preview?: string;
}

/** Persist a bounded, versioned checkpoint envelope. Checkpoint payload is untrusted progress data. */
export function encodeWorkerCheckpoint(payload: unknown, options: { attempt?: number; savedAt?: number } = {}): string {
  const metadata = { schema_version: 1 as const, format: WORKER_CHECKPOINT_FORMAT,
    saved_at: Number.isSafeInteger(options.savedAt) && Number(options.savedAt) >= 0 ? Number(options.savedAt) : Date.now(),
    ...(Number.isSafeInteger(options.attempt) && Number(options.attempt) > 0 ? { attempt: Number(options.attempt) } : {}) };
  let serialized: string;
  try { serialized = JSON.stringify({ ...metadata, payload }); }
  catch { return JSON.stringify({ ...metadata, truncated: true, original_chars: -1, preview: "[checkpoint could not be serialized]" }); }
  if (serialized.length <= MAX_CHECKPOINT_CHARS) return serialized;
  const previewBudget = MAX_CHECKPOINT_CHARS - JSON.stringify({ ...metadata, truncated: true, original_chars: serialized.length, preview: "" }).length - 4;
  return JSON.stringify({ ...metadata, truncated: true, original_chars: serialized.length, preview: serialized.slice(0, Math.max(0, previewBudget)) });
}

/** Read v1 and historical raw JSON checkpoints; callers must continue treating payload as untrusted. */
export function decodeWorkerCheckpoint(serialized: string | null | undefined): { schemaVersion: 0 | 1; payload: unknown; savedAt?: number; attempt?: number; truncated?: boolean } | null {
  if (!serialized || serialized.length > MAX_CHECKPOINT_CHARS + 512) return null;
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { schemaVersion: 0, payload: value };
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== WORKER_CHECKPOINT_FORMAT || envelope.schema_version !== 1) return { schemaVersion: 0, payload: value };
  if (!Number.isSafeInteger(envelope.saved_at) || Number(envelope.saved_at) < 0
    || envelope.attempt !== undefined && (!Number.isSafeInteger(envelope.attempt) || Number(envelope.attempt) < 1)
    || envelope.truncated !== undefined && envelope.truncated !== true
    || envelope.truncated === true && (typeof envelope.original_chars !== "number" || typeof envelope.preview !== "string")
    || envelope.truncated !== true && !Object.hasOwn(envelope, "payload")) return null;
  return { schemaVersion: 1, payload: envelope.truncated === true
    ? { truncated: true, original_chars: envelope.original_chars, preview: envelope.preview }
    : envelope.payload,
  savedAt: Number(envelope.saved_at), ...(typeof envelope.attempt === "number" ? { attempt: envelope.attempt } : {}),
  ...(envelope.truncated === true ? { truncated: true } : {}) };
}
