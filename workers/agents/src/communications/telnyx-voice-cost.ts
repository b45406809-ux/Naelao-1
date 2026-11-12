import type { AgentsEnv } from "../index.js";
import type { CommunicationIdentity } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";
import { providerCostToMicros, recordProviderApiCostObservation } from "./managed-service-cost-observations.js";

type CostEvent = {
  eventId: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function decimalMicros(value: unknown): number {
  if (typeof value !== "string") throw new Error("telnyx_call_cost_amount_invalid");
  try { return providerCostToMicros(value); }
  catch { throw new Error("telnyx_call_cost_amount_invalid"); }
}

/** Store only authenticated Telnyx billed call costs for call legs admitted by this binding.
 * The call-leg receipt is stable across webhook retries and refuses changed totals. */
export async function observeTelnyxVoiceCallCost(env: AgentsEnv, binding: AssistantPhoneBinding,
  identity: CommunicationIdentity, expectedConnectionId: string | null | undefined, event: CostEvent) {
  const payload = event.payload;
  const callControlId = payload.call_control_id;
  const callLegId = payload.call_leg_id;
  const callSessionId = payload.call_session_id;
  if (typeof callControlId !== "string" || !/^(?:v\d+:)?[A-Za-z0-9_+=\/-]{1,500}$/.test(callControlId)
    || typeof callLegId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(callLegId)
    || (callSessionId !== undefined && callSessionId !== null
      && (typeof callSessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(callSessionId)))) {
    throw new Error("telnyx_call_cost_identity_invalid");
  }
  if (expectedConnectionId && payload.connection_id !== expectedConnectionId) throw new Error("telnyx_call_cost_connection_mismatch");

  const [live, extension] = await Promise.all([
    env.PLATFORM_DB.prepare("SELECT call_control_id FROM assistant_telnyx_live_calls WHERE call_control_id=? AND binding_id=?")
      .bind(callControlId, binding.id).first<{ call_control_id: string }>(),
    env.PLATFORM_DB.prepare("SELECT call_control_id FROM assistant_telnyx_extension_calls WHERE call_control_id=? AND binding_id=?")
      .bind(callControlId, binding.id).first<{ call_control_id: string }>(),
  ]);
  if (!live && !extension) throw new Error("telnyx_call_cost_call_not_admitted");

  // Telnyx can report a failed cost calculation without an amount. Acknowledge the signed,
  // admitted event so retries do not loop; this is not a zero-cost observation.
  if (payload.status === "error") return { status: "unavailable" as const };
  if (payload.status !== "success" || typeof payload.total_cost !== "string"
    || !Array.isArray(payload.cost_parts) || payload.cost_parts.length < 1 || payload.cost_parts.length > 64) {
    throw new Error("telnyx_call_cost_receipt_invalid");
  }

  const parts = payload.cost_parts.map(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("telnyx_call_cost_receipt_invalid");
    const row = part as Record<string, unknown>;
    if (typeof row.currency !== "string" || !/^[A-Za-z]{3}$/.test(row.currency)) throw new Error("telnyx_call_cost_currency_invalid");
    return { cost: decimalMicros(row.cost), currency: row.currency.toUpperCase() };
  });
  const currencies = [...new Set(parts.map(part => part.currency))];
  if (currencies.length !== 1) throw new Error("telnyx_call_cost_currency_mismatch");
  const totalMicros = decimalMicros(payload.total_cost);
  const partsMicros = parts.reduce((total, part) => total + part.cost, 0);
  if (!Number.isSafeInteger(partsMicros) || partsMicros !== totalMicros) throw new Error("telnyx_call_cost_total_mismatch");

  const duration = payload.billed_duration_secs;
  if (duration !== undefined && duration !== null
    && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0 || duration > 604_800)) {
    throw new Error("telnyx_call_cost_duration_invalid");
  }
  const occurredAt = typeof payload.occurred_at === "string" ? payload.occurred_at : event.occurredAt;
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) throw new Error("telnyx_call_cost_time_invalid");
  const occurred = new Date(occurredAt).toISOString();
  const currency = currencies[0]!;
  const durationSeconds = duration == null ? null : Number(duration);
  const callLegHash = await sha256(callLegId);
  const callSessionHash = typeof callSessionId === "string" ? await sha256(callSessionId) : null;
  const eventHash = await sha256(event.eventId);
  const costEvidenceHash = await sha256(JSON.stringify([binding.id, callLegHash, callSessionHash,
    totalMicros, currency, durationSeconds, occurred, parts.map(part => [part.cost, part.currency])]));
  const observedAt = new Date().toISOString();

  const receiptWrite = await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO assistant_telnyx_voice_cost_receipts(
      binding_id,call_leg_id_sha256,call_session_id_sha256,first_event_id_sha256,provider_cost_micros,currency,
      billed_duration_seconds,occurred_at,cost_evidence_sha256,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(binding.id, callLegHash, callSessionHash, eventHash, totalMicros, currency,
      durationSeconds, occurred, costEvidenceHash, observedAt).run();
  const receipt = await env.PLATFORM_DB.prepare(`SELECT call_session_id_sha256,provider_cost_micros,currency,
      billed_duration_seconds,occurred_at,cost_evidence_sha256
    FROM assistant_telnyx_voice_cost_receipts WHERE binding_id=? AND call_leg_id_sha256=?`)
    .bind(binding.id, callLegHash)
    .first<{ call_session_id_sha256: string | null; provider_cost_micros: number; currency: string;
      billed_duration_seconds: number | null; occurred_at: string; cost_evidence_sha256: string }>();
  if (!receipt || receipt.call_session_id_sha256 !== callSessionHash || Number(receipt.provider_cost_micros) !== totalMicros
    || receipt.currency !== currency || (receipt.billed_duration_seconds == null ? null : Number(receipt.billed_duration_seconds)) !== durationSeconds
    || receipt.occurred_at !== occurred || receipt.cost_evidence_sha256 !== costEvidenceHash) {
    throw new Error("telnyx_call_cost_receipt_conflict");
  }

  const observation = await recordProviderApiCostObservation(env.PLATFORM_DB, {
    tenantId: identity.tenant_id,
    spaceId: identity.space_id,
    projectId: identity.project_id,
    provider: "telnyx",
    serviceId: "telnyx.voice.call",
    operationRef: callLegId,
    accountRef: binding.provider_account_sid,
    usageKind: "voice",
    quantityUnit: durationSeconds === null ? "call" : "second",
    quantityMicros: durationSeconds === null ? 1_000_000 : durationSeconds * 1_000_000,
    providerCost: payload.total_cost,
    currency,
    periodStart: occurred,
    sourceApi: "telnyx.call_cost.webhook",
    observedAt,
  });
  return { status: "observed" as const, provenance: "provider_api_observed" as const,
    replayed: receiptWrite.meta.changes !== 1 && observation.replayed };
}
