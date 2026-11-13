/** Data-only telephony contract. The host renders carrier commands and applies provider-specific
 * limits; extensions never receive credentials, arbitrary TwiML, or outbound dial authority. */
export type VoiceChannelAction =
  | { type: "say"; text: string }
  | { type: "gather"; text: string; input?: "dtmf" | "speech" | "dtmf speech"; digits?: number }
  | { type: "hangup" };

export interface VoiceChannelResponseV1 {
  schema_version: 1;
  actions: VoiceChannelAction[];
}

/** Versionless responses remain readable for already published handlers. New packages should
 * include schema_version: 1 so incompatible future actions fail closed at the host boundary. */
export type VoiceChannelResponse = VoiceChannelResponseV1 | { actions: VoiceChannelAction[] };

export type VoiceChannelEventType = "call.received" | "call.digits" | "call.speech" | "message.received";
export interface VoiceChannelEventPayload {
  voice_event: VoiceChannelEventType;
  caller: string;
  digits?: string;
  speech?: string;
  text?: string;
  confidence?: number;
}

export interface VoiceChannelEventV1 {
  schema_version: 1;
  type: VoiceChannelEventType;
  payload: VoiceChannelEventPayload;
}

const ownKeysAre = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** Validate and copy an untrusted handler response before a carrier adapter interprets it. */
export function validateVoiceChannelResponse(value: unknown): VoiceChannelResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (!ownKeysAre(response, ["schema_version", "actions"])
    || response.schema_version !== undefined && response.schema_version !== 1
    || !Array.isArray(response.actions) || response.actions.length < 1 || response.actions.length > 8) return null;

  const actions: VoiceChannelAction[] = [];
  for (const raw of Array.from(response.actions)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const action = raw as Record<string, unknown>;
    if (action.type === "say") {
      if (!ownKeysAre(action, ["type", "text"]) || typeof action.text !== "string"
        || action.text.length > 2_000 || action.text.includes("\0")) return null;
      actions.push({ type: "say", text: action.text });
      continue;
    }
    if (action.type === "gather") {
      if (!ownKeysAre(action, ["type", "text", "digits", "input"]) || typeof action.text !== "string"
        || action.text.length > 1_000 || action.text.includes("\0")
        || action.input !== undefined && !["dtmf", "speech", "dtmf speech"].includes(String(action.input))
        || action.digits !== undefined && (!Number.isInteger(action.digits) || Number(action.digits) < 1 || Number(action.digits) > 8)) return null;
      actions.push({ type: "gather", text: action.text,
        ...(action.input === undefined ? {} : { input: action.input as "dtmf" | "speech" | "dtmf speech" }),
        ...(action.digits === undefined ? {} : { digits: Number(action.digits) }) });
      continue;
    }
    if (action.type === "hangup" && ownKeysAre(action, ["type"])) {
      actions.push({ type: "hangup" });
      continue;
    }
    return null;
  }
  return response.schema_version === 1 ? { schema_version: 1, actions } : { actions };
}
