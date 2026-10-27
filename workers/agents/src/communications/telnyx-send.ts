import type { AgentsEnv } from "../index.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import { TelnyxTelephony } from "../voice/telnyx-telephony.js";
import { PhoneProviderError } from "./phone-provider.js";
import { channelPreferences, readBody, scopeAccess, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { validatePhonePolicy, type AssistantPhoneBinding } from "./phones.js";

/** Caller must enforce Space/Project membership, owner authority, explicit approval,
 * phone preferences and egress before this function. Never retry an uncertain send. */
export async function sendApprovedTelnyxSms(env: AgentsEnv, identity: CommunicationIdentity, binding: AssistantPhoneBinding, actionId: string, scope: CommunicationScope) {
  if (binding.provider !== "telnyx" || binding.payer !== "byo" || binding.status !== "active" || !binding.phone_number
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(actionId)) throw new Error("telnyx_sms_unavailable");
  const account = await resolveTelnyxAccount(env, identity);
  if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number)
    throw new Error("telnyx_binding_mismatch");
  const row = await env.PLATFORM_DB.prepare("SELECT id,kind,recipient,body_key,status,provider_sid FROM assistant_phone_actions WHERE id=? AND binding_id=?")
    .bind(actionId, binding.id).first<{ id: string; kind: string; recipient: string; body_key: string; status: string; provider_sid: string | null }>();
  if (!row || row.kind !== "sms") throw new Error("phone_action_not_found");
  if (row.status === "sent") return { id: row.id, status: "sent", provider_sid: row.provider_sid, deduplicated: true };
  if (row.status !== "approved") throw new Error("phone_action_approval_required");
  const policy = validatePhonePolicy(JSON.parse(binding.policy_json));
  const claim = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_actions SET status='sending',updated_at=datetime('now') WHERE id=? AND binding_id=? AND status='approved' AND (SELECT COUNT(*) FROM assistant_phone_actions WHERE binding_id=? AND status IN ('sending','indeterminate','sent') AND updated_at>=date('now'))<?")
    .bind(row.id, binding.id, binding.id, policy.maxDailyActions).run();
  if (!claim.meta.changes) throw new Error("phone_action_already_claimed_or_daily_limit");
  try {
    const content = await readBody(env, identity, row.id, row.body_key);
    if (!(await scopeAccess(env, scope, true)) || !(await channelPreferences(env, scope)).enabled.phone
      || await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId)) throw new PhoneProviderError(false, "phone_access_revoked");
    const sent = await new TelnyxTelephony(account).sendSms(binding.phone_number, row.recipient, String(content.text ?? ""));
    if (typeof sent.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sent.id)) throw new PhoneProviderError(true, "telnyx_receipt_invalid");
    await env.PLATFORM_DB.prepare("UPDATE assistant_phone_actions SET status='sent',provider_sid=?,updated_at=datetime('now') WHERE id=? AND binding_id=? AND status='sending'")
      .bind(sent.id, row.id, binding.id).run();
    return { id: row.id, status: "sent", provider_sid: sent.id };
  } catch (error) {
    await env.PLATFORM_DB.prepare("UPDATE assistant_phone_actions SET status=?,error_code=?,updated_at=datetime('now') WHERE id=? AND binding_id=? AND status='sending'")
      .bind(error instanceof PhoneProviderError && !error.uncertain ? "failed" : "indeterminate", error instanceof PhoneProviderError ? error.code : "phone_send_interrupted", row.id, binding.id).run();
    throw error;
  }
}

/** Resolve a lost response only against an actual provider receipt. An absent receipt does
 * not prove the message was never sent and must not reopen the action for retry. */
export async function reconcileTelnyxSms(env: AgentsEnv, identity: CommunicationIdentity, binding: AssistantPhoneBinding, actionId: string, providerId: string) {
  if (binding.provider !== "telnyx" || binding.payer !== "byo" || !binding.phone_number || !/^[A-Za-z0-9._:-]{1,160}$/.test(actionId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) throw new Error("telnyx_reconciliation_invalid");
  const account = await resolveTelnyxAccount(env, identity);
  if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number) throw new Error("telnyx_binding_mismatch");
  const row = await env.PLATFORM_DB.prepare("SELECT kind,recipient,body_key,status FROM assistant_phone_actions WHERE id=? AND binding_id=?")
    .bind(actionId, binding.id).first<{ kind: string; recipient: string; body_key: string; status: string }>();
  if (!row || row.kind !== "sms" || !["sending", "indeterminate"].includes(row.status)) throw new Error("phone_action_not_indeterminate");
  const content = await readBody(env, identity, actionId, row.body_key);
  const receipt = await new TelnyxTelephony(account).inspectMessage(providerId);
  const from = receipt.from as { phone_number?: unknown } | undefined;
  const to = Array.isArray(receipt.to) ? receipt.to as Array<{ phone_number?: unknown }> : [];
  if (receipt.id !== providerId || receipt.direction !== "outbound" || from?.phone_number !== binding.phone_number
    || to.length !== 1 || to[0]?.phone_number !== row.recipient || typeof content.text !== "string" || receipt.text !== content.text)
    throw new Error("telnyx_reconciliation_record_mismatch");
  const changed = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_actions SET status='sent',provider_sid=?,error_code=NULL,updated_at=datetime('now') WHERE id=? AND binding_id=? AND status IN ('sending','indeterminate')")
    .bind(providerId, actionId, binding.id).run();
  if (!changed.meta.changes) throw new Error("phone_action_changed");
  return { reconciled: true, status: "sent", provider_sid: providerId };
}

/** Record only finalized carrier-reported costs as decimal strings. Replays are idempotent;
 * a later provider correction becomes a separate observation. This does not charge users. */
export async function observeTelnyxSmsCost(env: AgentsEnv, identity: CommunicationIdentity, binding: AssistantPhoneBinding, actionId: string) {
  if (binding.provider !== "telnyx" || binding.payer !== "byo" || !binding.phone_number || !/^[A-Za-z0-9._:-]{1,160}$/.test(actionId)) throw new Error("telnyx_reconciliation_invalid");
  const account = await resolveTelnyxAccount(env, identity);
  if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number) throw new Error("telnyx_binding_mismatch");
  const row = await env.PLATFORM_DB.prepare("SELECT kind,recipient,body_key,status,provider_sid FROM assistant_phone_actions WHERE id=? AND binding_id=?")
    .bind(actionId, binding.id).first<{ kind: string; recipient: string; body_key: string; status: string; provider_sid: string | null }>();
  if (!row || row.kind !== "sms" || row.status !== "sent" || !row.provider_sid) throw new Error("telnyx_message_receipt_required");
  const content = await readBody(env, identity, actionId, row.body_key);
  const receipt = await new TelnyxTelephony(account).inspectMessage(row.provider_sid);
  const from = receipt.from as { phone_number?: unknown } | undefined;
  const to = Array.isArray(receipt.to) ? receipt.to as Array<{ phone_number?: unknown }> : [];
  if (receipt.id !== row.provider_sid || receipt.direction !== "outbound" || from?.phone_number !== binding.phone_number
    || to.length !== 1 || to[0]?.phone_number !== row.recipient || typeof content.text !== "string" || receipt.text !== content.text)
    throw new Error("telnyx_reconciliation_record_mismatch");
  const cost = receipt.cost as { amount?: unknown; currency?: unknown } | null | undefined;
  if (receipt.completed_at === null || receipt.completed_at === undefined || cost === null || cost === undefined) return { status: "pending" as const };
  if (typeof receipt.completed_at !== "string" || receipt.completed_at.length > 64 || !Number.isFinite(Date.parse(receipt.completed_at))
    || typeof cost.amount !== "string" || !/^\d{1,12}(?:\.\d{1,12})?$/.test(cost.amount)
    || typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) throw new Error("telnyx_cost_receipt_invalid");
  const canonical = JSON.stringify([binding.id, actionId, row.provider_sid, cost.amount, cost.currency, receipt.completed_at]);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_telnyx_usage_receipts(receipt_hash,binding_id,action_id,provider_message_id,amount,currency,provider_completed_at) VALUES(?,?,?,?,?,?,?)")
    .bind(hash, binding.id, actionId, row.provider_sid, cost.amount, cost.currency, receipt.completed_at).run();
  return { status: "observed" as const, amount: cost.amount, currency: cost.currency, provider_completed_at: receipt.completed_at, billed_by: "telnyx" as const };
}
