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
