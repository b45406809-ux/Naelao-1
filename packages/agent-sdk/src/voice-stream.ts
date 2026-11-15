/** Provider-neutral, data-only contract for a bounded extension voice session.
 * The host owns media, credentials, identity, consent, billing and every side effect. */
export type VoiceExtensionStreamEventV1 =
  | { schema_version: 1; id: string; type: "call.started"; payload: { call_ref: string } }
  | { schema_version: 1; id: string; type: "transcript.partial" | "transcript.final"; payload: { call_ref: string; sequence: number; text: string } }
  | { schema_version: 1; id: string; type: "keypad.input"; payload: { call_ref: string; digits: string } }
  | { schema_version: 1; id: string; type: "call.interrupted"; payload: { call_ref: string; sequence: number } }
  | { schema_version: 1; id: string; type: "tool.result"; payload: { call_ref: string; request_id: string; tool: string; status: "succeeded" | "failed"; summary: string } }
  | { schema_version: 1; id: string; type: "call.ended"; payload: { call_ref: string; reason: "completed" | "caller_hangup" | "timeout" | "handoff" | "provider_error" | "runtime_error" } };

export type VoiceExtensionStreamActionV1 =
  | { type: "speak"; text: string }
  | { type: "listen"; input: "speech" | "dtmf"; timeout_ms?: number }
  | { type: "transfer"; target: "configured_handoff" }
  | { type: "end" };

export interface VoiceExtensionStreamResponseV1 {
  schema_version: 1;
  actions: VoiceExtensionStreamActionV1[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every(key => allowed.includes(key));
const validCallRef = (value: unknown): value is string =>
  typeof value === "string" && /^call_[a-f0-9]{32}$/.test(value);
const validEventId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const validSequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;

/** Validate and copy a host-produced extension event. No carrier identifiers or raw audio fit this contract. */
export function validateVoiceExtensionStreamEvent(value: unknown): VoiceExtensionStreamEventV1 | null {
  if (!isRecord(value) || !hasOnly(value, ["schema_version", "id", "type", "payload"])
    || value.schema_version !== 1 || !validEventId(value.id) || !isRecord(value.payload)) return null;
  const payload = value.payload;
  if (value.type === "call.started" && hasOnly(payload, ["call_ref"]) && validCallRef(payload.call_ref))
    return { schema_version: 1, id: value.id, type: value.type, payload: { call_ref: payload.call_ref } };
  if ((value.type === "transcript.partial" || value.type === "transcript.final")
    && hasOnly(payload, ["call_ref", "sequence", "text"]) && validCallRef(payload.call_ref)
    && validSequence(payload.sequence) && typeof payload.text === "string" && payload.text.trim().length > 0
    && new TextEncoder().encode(payload.text).byteLength <= 2_000 && !payload.text.includes("\0"))
    return { schema_version: 1, id: value.id, type: value.type, payload: {
      call_ref: payload.call_ref, sequence: payload.sequence, text: payload.text,
    } };
  if (value.type === "keypad.input" && hasOnly(payload, ["call_ref", "digits"]) && validCallRef(payload.call_ref)
    && typeof payload.digits === "string" && /^[0-9]{1,8}$/.test(payload.digits))
    return { schema_version: 1, id: value.id, type: value.type, payload: { call_ref: payload.call_ref, digits: payload.digits } };
  if (value.type === "call.interrupted" && hasOnly(payload, ["call_ref", "sequence"]) && validCallRef(payload.call_ref)
    && validSequence(payload.sequence))
    return { schema_version: 1, id: value.id, type: value.type, payload: { call_ref: payload.call_ref, sequence: payload.sequence } };
  if (value.type === "tool.result" && hasOnly(payload, ["call_ref", "request_id", "tool", "status", "summary"])
    && validCallRef(payload.call_ref) && typeof payload.request_id === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(payload.request_id)
    && typeof payload.tool === "string" && /^[a-z][a-z0-9._:-]{1,63}$/.test(payload.tool)
    && (payload.status === "succeeded" || payload.status === "failed")
    && typeof payload.summary === "string" && new TextEncoder().encode(payload.summary).byteLength <= 2_000
    && !payload.summary.includes("\0"))
    return { schema_version: 1, id: value.id, type: value.type, payload: {
      call_ref: payload.call_ref, request_id: payload.request_id, tool: payload.tool,
      status: payload.status, summary: payload.summary,
    } };
  if (value.type === "call.ended" && hasOnly(payload, ["call_ref", "reason"]) && validCallRef(payload.call_ref)
    && ["completed", "caller_hangup", "timeout", "handoff", "provider_error", "runtime_error"].includes(String(payload.reason)))
    return { schema_version: 1, id: value.id, type: value.type, payload: {
      call_ref: payload.call_ref, reason: payload.reason as Extract<VoiceExtensionStreamEventV1, { type: "call.ended" }>['payload']['reason'],
    } };
  return null;
}

/** Validate extension intent before the host maps it to provider-owned call actions. */
export function validateVoiceExtensionStreamResponse(value: unknown): VoiceExtensionStreamResponseV1 | null {
  if (!isRecord(value) || !hasOnly(value, ["schema_version", "actions"]) || value.schema_version !== 1
    || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 8) return null;
  const actions: VoiceExtensionStreamActionV1[] = [];
  for (const raw of value.actions) {
    if (!isRecord(raw)) return null;
    if (raw.type === "speak" && hasOnly(raw, ["type", "text"]) && typeof raw.text === "string"
      && raw.text.trim().length > 0 && new TextEncoder().encode(raw.text).byteLength <= 2_000 && !raw.text.includes("\0")) {
      actions.push({ type: "speak", text: raw.text });
      continue;
    }
    if (raw.type === "listen" && hasOnly(raw, ["type", "input", "timeout_ms"])
      && (raw.input === "speech" || raw.input === "dtmf")
      && (raw.timeout_ms === undefined || Number.isSafeInteger(raw.timeout_ms) && Number(raw.timeout_ms) >= 1_000 && Number(raw.timeout_ms) <= 30_000)) {
      actions.push({ type: "listen", input: raw.input, ...(raw.timeout_ms === undefined ? {} : { timeout_ms: Number(raw.timeout_ms) }) });
      continue;
    }
    if (raw.type === "transfer" && hasOnly(raw, ["type", "target"]) && raw.target === "configured_handoff") {
      actions.push({ type: "transfer", target: "configured_handoff" });
      continue;
    }
    if (raw.type === "end" && hasOnly(raw, ["type"])) {
      actions.push({ type: "end" });
      continue;
    }
    return null;
  }
  return { schema_version: 1, actions };
}
