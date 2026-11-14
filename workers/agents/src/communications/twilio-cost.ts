import type { AgentsEnv } from "../index.js";
import type { CommunicationIdentity } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";
import { phoneProvider } from "./phone-provider.js";
import type { TwilioVoiceCredentials } from "../voice/twilio-telephony.js";
import { recordProviderApiCostObservation } from "./managed-service-cost-observations.js";

const SMS_SID = /^SM[a-fA-F0-9]{32}$/;
const CALL_SID = /^CA[a-fA-F0-9]{32}$/;
const FINAL_STATES: Record<string, ReadonlySet<string>> = {
  sms: new Set(["sent", "delivered", "undelivered", "failed"]),
  call: new Set(["completed", "busy", "failed", "no-answer", "canceled"]),
};

function normalizeBilledAmount(value: unknown): string | null {
  if (typeof value !== "string" || !/^-?\d{1,12}(?:\.\d{1,12})?$/.test(value)) return null;
  return value.startsWith("-") ? value.slice(1) : value;
}

/** Observe the provider-reported charge for one owner-authorized Twilio action.
 * The API response is minimized to a hash-backed cost row; invoice reconciliation
 * and calls outside Naelao are intentionally outside this path. */
export async function observeTwilioSmsCost(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  binding: AssistantPhoneBinding,
  credentials: TwilioVoiceCredentials,
  actionId: string,
) {
  if ((binding.provider ?? "twilio") !== "twilio" || binding.payer !== "byo" || binding.status !== "active"
    || credentials.accountSid !== binding.provider_account_sid || !/^[A-Za-z0-9._:-]{1,160}$/.test(actionId)) {
    throw new Error("twilio_cost_account_unavailable");
  }
  const row = await env.PLATFORM_DB.prepare(`SELECT id,kind,recipient,status,provider_sid
    FROM assistant_phone_actions WHERE id=? AND binding_id=? LIMIT 1`)
    .bind(actionId, binding.id)
    .first<{ id: string; kind: string; recipient: string; status: string; provider_sid: string | null }>();
  if (!row || !Object.hasOwn(FINAL_STATES, row.kind) || row.status !== "sent" || !row.provider_sid
    || (row.kind === "sms" ? !SMS_SID.test(row.provider_sid) : !CALL_SID.test(row.provider_sid))) {
    throw new Error("twilio_cost_action_unavailable");
  }

  const resource = row.kind === "sms" ? "Messages" : "Calls";
  const receipt = await phoneProvider(credentials, `${resource}/${row.provider_sid}.json`);
  if (receipt.account_sid !== credentials.accountSid || receipt.sid !== row.provider_sid
    || receipt.from !== binding.phone_number || receipt.to !== row.recipient
    || !String(receipt.direction).startsWith("outbound-")) {
    throw new Error("twilio_cost_receipt_mismatch");
  }
  if (!FINAL_STATES[row.kind]!.has(String(receipt.status))) return { status: "pending" as const };
  const amount = normalizeBilledAmount(receipt.price);
  const currency = typeof receipt.price_unit === "string" ? receipt.price_unit.toUpperCase() : "";
  const occurredAt = row.kind === "sms"
    ? receipt.date_sent ?? receipt.date_updated ?? receipt.date_created
    : receipt.start_time ?? receipt.date_updated ?? receipt.date_created;
  if (amount === null || !/^[A-Z]{3}$/.test(currency)
    || typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
    return { status: "pending" as const };
  }
  const duration = row.kind === "call" ? Number(receipt.duration) : null;
  if (row.kind === "call" && (!Number.isSafeInteger(duration) || duration! < 0 || duration! > 86_400)) {
    return { status: "pending" as const };
  }

  const observed = await recordProviderApiCostObservation(env.PLATFORM_DB, {
    tenantId: identity.tenant_id,
    spaceId: identity.space_id,
    projectId: identity.project_id,
    provider: "twilio",
    serviceId: "phone-number",
    operationRef: row.provider_sid,
    accountRef: credentials.accountSid,
    usageKind: row.kind === "sms" ? "sms" : "voice",
    quantityUnit: row.kind === "sms" ? "message" : "second",
    quantityMicros: row.kind === "sms" ? 1_000_000 : duration! * 1_000_000,
    providerCost: amount,
    currency,
    periodStart: occurredAt,
    sourceApi: row.kind === "sms" ? "twilio.messages.get" : "twilio.calls.get",
  });
  return { status: "observed" as const, amount, currency, provenance: observed.provenance };
}

/** Observe one inbound extension call only when the SID and release pin match admitted local history. */
export async function observeTwilioExtensionCallCost(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  credentials: TwilioVoiceCredentials,
  callSid: string,
  bindingId: string,
  installationId: string,
  handlerSha256: string,
) {
  if (!CALL_SID.test(callSid) || !/^[A-Za-z0-9._:-]{1,160}$/.test(bindingId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(installationId)
    || !/^[a-f0-9]{64}$/.test(handlerSha256)) throw new Error("twilio_cost_action_unavailable");
  const row = await env.PLATFORM_DB.prepare(`SELECT e.id,e.sender,e.status,e.extension_installation_id,e.handler_sha256,
      b.id AS binding_id,b.provider,b.payer,b.provider_account_sid,b.phone_number,b.status AS binding_status
    FROM assistant_phone_events e JOIN assistant_phone_bindings b ON b.id=e.binding_id
    WHERE e.id=? AND b.id=? AND b.identity_id=? AND b.purpose='extension' AND e.kind='call' LIMIT 1`)
    .bind(callSid, bindingId, identity.id)
    .first<{ id: string; sender: string; status: string; extension_installation_id: string | null; handler_sha256: string | null;
      binding_id: string; provider: string; payer: string; provider_account_sid: string; phone_number: string | null; binding_status: string }>();
  if (!row || row.id !== callSid || row.binding_id !== bindingId
    || row.extension_installation_id !== installationId || row.handler_sha256 !== handlerSha256
    || row.provider !== "twilio" || row.payer !== "byo" || row.binding_status !== "active"
    || row.provider_account_sid !== credentials.accountSid || !isValidE164(row.sender) || !isValidE164(row.phone_number)) {
    throw new Error("twilio_cost_action_unavailable");
  }

  const receipt = await phoneProvider(credentials, `Calls/${callSid}.json`);
  if (receipt.account_sid !== credentials.accountSid || receipt.sid !== callSid || receipt.direction !== "inbound"
    || receipt.from !== row.sender || receipt.to !== row.phone_number) {
    throw new Error("twilio_cost_receipt_mismatch");
  }
  if (!FINAL_STATES.call!.has(String(receipt.status))) return { status: "pending" as const };
  const amount = normalizeBilledAmount(receipt.price);
  const currency = typeof receipt.price_unit === "string" ? receipt.price_unit.toUpperCase() : "";
  const occurredAt = receipt.start_time ?? receipt.date_updated ?? receipt.date_created;
  const duration = Number(receipt.duration);
  if (amount === null || !/^[A-Z]{3}$/.test(currency)
    || typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))
    || !Number.isSafeInteger(duration) || duration < 0 || duration > 86_400) {
    return { status: "pending" as const };
  }

  const observed = await recordProviderApiCostObservation(env.PLATFORM_DB, {
    tenantId: identity.tenant_id,
    spaceId: identity.space_id,
    projectId: identity.project_id,
    provider: "twilio",
    serviceId: "phone-number",
    operationRef: callSid,
    accountRef: credentials.accountSid,
    usageKind: "voice",
    quantityUnit: "second",
    quantityMicros: duration * 1_000_000,
    providerCost: amount,
    currency,
    periodStart: occurredAt,
    sourceApi: "twilio.calls.get",
  });
  return { status: "observed" as const, amount, currency, provenance: observed.provenance };
}

function isValidE164(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}
