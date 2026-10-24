/** Voice preferences are declarations. The host still enforces entitlement, scope and budget. */
export type ModelClass = "economy" | "balanced" | "advanced";
export type WorkerExecutionKind = "generative" | "decision" | "workflow";
export interface WorkerExecutionPolicy {
  executionKind: WorkerExecutionKind;
  modelClass: ModelClass;
}
export interface AssistantVoicePreferences {
  schemaVersion: 1;
  enabled: boolean;
  voiceProfileId: string | null;
  language: string;
  deliveryInstructions: string;
  speed: number;
  modelClass: ModelClass;
  customVoicesEnabled: boolean;
  allowProjectOverrides: boolean;
  allowPrebuiltFallback: boolean;
  maxCallMinutes: number;
  maxCallCostUsd: number;
}
export interface AssistantVoiceSettings {
  preferences: AssistantVoicePreferences;
  overrides: Partial<AssistantVoicePreferences>;
  revision: number;
  inherited: boolean;
}
export const DEFAULT_ASSISTANT_VOICE: Readonly<AssistantVoicePreferences> = Object.freeze({
  schemaVersion: 1, enabled: false, voiceProfileId: null, language: "auto",
  deliveryInstructions: "", speed: 1, modelClass: "economy", customVoicesEnabled: false,
  allowProjectOverrides: true, allowPrebuiltFallback: false, maxCallMinutes: 30, maxCallCostUsd: 2,
});
const FIELDS = new Set(Object.keys(DEFAULT_ASSISTANT_VOICE));
export function validateAssistantVoicePatch(value: unknown): Partial<AssistantVoicePreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_voice_preferences");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !FIELDS.has(k))) throw new Error("unknown_voice_preference");
  for (const [k, v] of Object.entries(p)) {
    let valid = false;
    switch (k) {
      case "schemaVersion": valid = v === 1; break;
      case "enabled": case "customVoicesEnabled": case "allowProjectOverrides": case "allowPrebuiltFallback": valid = typeof v === "boolean"; break;
      case "voiceProfileId": valid = v === null || typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v); break;
      case "language": valid = typeof v === "string" && /^(auto|[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2})$/.test(v); break;
      case "deliveryInstructions": valid = typeof v === "string" && v.length <= 1000 && !v.includes("\0"); break;
      case "speed": valid = typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 2; break;
      case "modelClass": valid = ["economy", "balanced", "advanced"].includes(v as string); break;
      case "maxCallMinutes": valid = Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 240; break;
      case "maxCallCostUsd": valid = typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100; break;
    }
    if (!valid) throw new Error(`invalid_voice_preference_${k}`);
  }
  return { ...p } as Partial<AssistantVoicePreferences>;
}
export function resolveAssistantVoice(space: Partial<AssistantVoicePreferences> = {}, project?: Partial<AssistantVoicePreferences>): AssistantVoicePreferences {
  const base = { ...DEFAULT_ASSISTANT_VOICE, ...validateAssistantVoicePatch(space) };
  if (!project || !base.allowProjectOverrides) return base;
  const patch = validateAssistantVoicePatch(project);
  return {
    ...base, ...patch,
    // Project configuration cannot enable a Space-disabled capability or raise its limits.
    enabled: base.enabled && (patch.enabled ?? base.enabled),
    customVoicesEnabled: base.customVoicesEnabled && (patch.customVoicesEnabled ?? base.customVoicesEnabled),
    allowProjectOverrides: base.allowProjectOverrides,
    maxCallMinutes: Math.min(base.maxCallMinutes, patch.maxCallMinutes ?? base.maxCallMinutes),
    maxCallCostUsd: Math.min(base.maxCallCostUsd, patch.maxCallCostUsd ?? base.maxCallCostUsd),
  };
}
export interface VoiceProfile {
  id: string;
  kind: "prebuilt" | "designed" | "replicated";
  name: string;
  status: "active" | "revoked" | "deleting";
  sharedWithSpace: boolean;
  model: string;
  voice?: string;
}
export type VoiceCapability = "assistant.voice.read" | "assistant.voice.configure" | "assistant.voice.preview" | "assistant.voice.create" | "assistant.voice.delete";
/** Bind once using host-attested identity. No method accepts a tenant or scope override. */
export function createAssistantVoiceClient(options: {
  spaceId: string; projectId?: string;
  capabilities: readonly VoiceCapability[];
  request(path: string, init?: { method: string; body: string }): Promise<Response>;
}) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.spaceId) || options.projectId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId)) throw new Error("invalid_voice_scope");
  const base = `/spaces/${encodeURIComponent(options.spaceId)}/assistant-voice`;
  const query = options.projectId ? `?project_id=${encodeURIComponent(options.projectId)}` : "";
  const call = async <T>(capability: VoiceCapability, suffix: string, body?: unknown): Promise<T> => {
    if (!options.capabilities.includes(capability)) throw new Error("voice_capability_denied");
    const response = await options.request(base + suffix + query, body === undefined ? undefined : { method: "PATCH", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`voice_host_${response.status}`);
    return response.json() as Promise<T>;
  };
  return {
    getPreferences: () => call<AssistantVoiceSettings>("assistant.voice.read", ""),
    previewPreferences: async (patch: unknown) => {
      const settings = await call<AssistantVoiceSettings>("assistant.voice.read", "");
      return resolveAssistantVoice(settings.preferences, validateAssistantVoicePatch(patch));
    },
    updatePreferences: (preferences: unknown, revision: number) => call<AssistantVoiceSettings>("assistant.voice.configure", "", { preferences: validateAssistantVoicePatch(preferences), revision }),
  };
}
