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

export interface WorkerCheckpointWorkspacePin {
  branch: string;
  revision: number;
  manifestHash: string;
}

export interface WorkerCheckpointLineageEntry {
  attempt?: number;
  savedAt: number;
  workspacePin?: WorkerCheckpointWorkspacePin;
  workspacePinStatus?: "pinned" | "unavailable" | "not_applicable";
  truncated?: boolean;
}

/** Persist a bounded, versioned checkpoint envelope. Checkpoint payload is untrusted progress data. */
export function encodeWorkerCheckpoint(payload: unknown, options: {
  attempt?: number;
  savedAt?: number;
  workspacePin?: WorkerCheckpointWorkspacePin;
  workspacePinStatus?: "pinned" | "unavailable" | "not_applicable";
  lineage?: WorkerCheckpointLineageEntry[];
} = {}): string {
  const lineage = (options.lineage ?? []).slice(-8).filter(entry => Number.isSafeInteger(entry.savedAt) && entry.savedAt >= 0)
    .map(entry => ({ ...(Number.isSafeInteger(entry.attempt) && entry.attempt! > 0 ? { attempt: entry.attempt } : {}), saved_at: entry.savedAt,
      ...(entry.workspacePin ? { workspace_pin: entry.workspacePin } : {}),
      ...(entry.workspacePinStatus ? { workspace_pin_status: entry.workspacePinStatus } : {}),
      ...(entry.truncated ? { truncated: true } : {}) }));
  const metadata = { schema_version: 2 as const, format: WORKER_CHECKPOINT_FORMAT,
    saved_at: Number.isSafeInteger(options.savedAt) && Number(options.savedAt) >= 0 ? Number(options.savedAt) : Date.now(),
    ...(Number.isSafeInteger(options.attempt) && Number(options.attempt) > 0 ? { attempt: Number(options.attempt) } : {}),
    workspace_pin_status: options.workspacePinStatus ?? (options.workspacePin ? "pinned" : "not_applicable"),
    ...(options.workspacePin ? { workspace_pin: options.workspacePin } : {}), lineage };
  let serialized: string;
  try { serialized = JSON.stringify({ ...metadata, payload }); }
  catch { return JSON.stringify({ ...metadata, truncated: true, original_chars: -1, preview: "[checkpoint could not be serialized]" }); }
  if (serialized.length <= MAX_CHECKPOINT_CHARS) return serialized;
  const previewBudget = MAX_CHECKPOINT_CHARS - JSON.stringify({ ...metadata, truncated: true, original_chars: serialized.length, preview: "" }).length - 4;
  return JSON.stringify({ ...metadata, truncated: true, original_chars: serialized.length, preview: serialized.slice(0, Math.max(0, previewBudget)) });
}

/** Read v1 and historical raw JSON checkpoints; callers must continue treating payload as untrusted. */
export function decodeWorkerCheckpoint(serialized: string | null | undefined): {
  schemaVersion: 0 | 1 | 2;
  payload: unknown;
  savedAt?: number;
  attempt?: number;
  truncated?: boolean;
  workspacePin?: WorkerCheckpointWorkspacePin;
  workspacePinStatus?: "pinned" | "unavailable" | "not_applicable";
  lineage?: WorkerCheckpointLineageEntry[];
} | null {
  if (!serialized || serialized.length > MAX_CHECKPOINT_CHARS + 512) return null;
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { schemaVersion: 0, payload: value };
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== WORKER_CHECKPOINT_FORMAT || ![1, 2].includes(Number(envelope.schema_version))) return { schemaVersion: 0, payload: value };
  const schemaVersion = Number(envelope.schema_version) as 1 | 2;
  if (!Number.isSafeInteger(envelope.saved_at) || Number(envelope.saved_at) < 0
    || envelope.attempt !== undefined && (!Number.isSafeInteger(envelope.attempt) || Number(envelope.attempt) < 1)
    || schemaVersion === 2 && !["pinned", "unavailable", "not_applicable"].includes(String(envelope.workspace_pin_status))
    || schemaVersion === 2 && !Array.isArray(envelope.lineage)
    || schemaVersion === 2 && (envelope.lineage as unknown[]).length > 8
    || envelope.truncated !== undefined && envelope.truncated !== true
    || envelope.truncated === true && (typeof envelope.original_chars !== "number" || typeof envelope.preview !== "string")
    || envelope.truncated !== true && !Object.hasOwn(envelope, "payload")) return null;
  const rawPin = envelope.workspace_pin && typeof envelope.workspace_pin === "object" ? envelope.workspace_pin as Record<string, unknown> : undefined;
  const workspacePin = rawPin && typeof rawPin.branch === "string" && rawPin.branch.length <= 160
    && Number.isSafeInteger(rawPin.revision) && Number(rawPin.revision) >= 0
    && typeof rawPin.manifestHash === "string" && /^[a-f0-9]{64}$/.test(rawPin.manifestHash)
    ? { branch: rawPin.branch, revision: Number(rawPin.revision), manifestHash: rawPin.manifestHash } : undefined;
  if (schemaVersion === 2 && envelope.workspace_pin !== undefined && !workspacePin) return null;
  const lineage = schemaVersion === 2 ? (envelope.lineage as unknown[]).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    const pin = value.workspace_pin && typeof value.workspace_pin === "object" ? value.workspace_pin as Record<string, unknown> : undefined;
    const parsedPin = pin && typeof pin.branch === "string" && pin.branch.length <= 160 && Number.isSafeInteger(pin.revision)
      && Number(pin.revision) >= 0 && typeof pin.manifestHash === "string" && /^[a-f0-9]{64}$/.test(pin.manifestHash)
      ? { branch: pin.branch, revision: Number(pin.revision), manifestHash: pin.manifestHash } : undefined;
    if (!Number.isSafeInteger(value.saved_at) || Number(value.saved_at) < 0
      || value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1)
      || value.workspace_pin !== undefined && !parsedPin
      || value.workspace_pin_status !== undefined && !["pinned", "unavailable", "not_applicable"].includes(String(value.workspace_pin_status))
      || value.truncated !== undefined && value.truncated !== true) return null;
    return { ...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}), savedAt: Number(value.saved_at),
      ...(parsedPin ? { workspacePin: parsedPin } : {}),
      ...(typeof value.workspace_pin_status === "string" ? { workspacePinStatus: value.workspace_pin_status as NonNullable<WorkerCheckpointLineageEntry["workspacePinStatus"]> } : {}),
      ...(value.truncated === true ? { truncated: true } : {}) } satisfies WorkerCheckpointLineageEntry;
  }) : [];
  if (lineage?.some(entry => entry === null)) return null;
  return { schemaVersion, payload: envelope.truncated === true
    ? { truncated: true, original_chars: envelope.original_chars, preview: envelope.preview }
    : envelope.payload,
  savedAt: Number(envelope.saved_at), ...(typeof envelope.attempt === "number" ? { attempt: envelope.attempt } : {}),
  ...(workspacePin ? { workspacePin } : {}),
  ...(schemaVersion === 2 ? { workspacePinStatus: envelope.workspace_pin_status as "pinned" | "unavailable" | "not_applicable",
    lineage: lineage as WorkerCheckpointLineageEntry[] } : {}),
  ...(envelope.truncated === true ? { truncated: true } : {}) };
}
