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
  if (binding.provider !== "telnyx" || binding.status !== "active" || !binding.phone_number
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
