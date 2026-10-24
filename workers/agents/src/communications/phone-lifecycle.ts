import type { AgentsEnv } from "../index.js";
import type { CommunicationIdentity } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";
import { phoneProvider, resolvePhoneCredentials } from "./phone-provider.js";

/** Account deletion does not sell/release a customer's carrier number. Restore its callbacks,
 * and only then erase the records. Unknown purchases must be reconciled before erasure. */
export async function detachAssistantPhonesForErasure(
  env: AgentsEnv,
  identityId: string
) {
  const identity = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_communication_identities WHERE id=?"
  )
    .bind(identityId)
    .first<CommunicationIdentity>();
  if (!identity) return;
  const { results } = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_phone_bindings WHERE identity_id=?"
  )
    .bind(identityId)
    .all<AssistantPhoneBinding>();
  for (const binding of results) {
    if (!["released", "detached"].includes(binding.status)) {
      if (
        !binding.provider_number_sid ||
        ["configuring", "indeterminate"].includes(binding.status)
      )
        throw new Error("phone_reconciliation_required_before_erasure");
      const credentials = await resolvePhoneCredentials(
        env,
        identity,
        binding.payer
      );
      if (
        !credentials ||
        credentials.accountSid !== binding.provider_account_sid
      )
        throw new Error("phone_detachment_required_before_erasure");
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_bindings SET status='disabling' WHERE id=?"
      )
        .bind(binding.id)
        .run();
      const p = JSON.parse(binding.previous_callbacks_json) as Record<
        string,
        string
      >;
      await phoneProvider(
        credentials,
        `IncomingPhoneNumbers/${binding.provider_number_sid}.json`,
        "POST",
        new URLSearchParams({
          VoiceUrl: p.voice_url ?? "",
          VoiceMethod: p.voice_method || "POST",
          SmsUrl: p.sms_url ?? "",
          SmsMethod: p.sms_method || "POST",
          StatusCallback: p.status_callback ?? "",
          StatusCallbackMethod: p.status_callback_method || "POST",
        })
      );
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_bindings SET status='detached' WHERE id=?"
      )
        .bind(binding.id)
        .run();
    }
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "DELETE FROM assistant_phone_events WHERE binding_id=?"
      ).bind(binding.id),
      env.PLATFORM_DB.prepare(
        "DELETE FROM assistant_phone_actions WHERE binding_id=?"
      ).bind(binding.id),
      env.PLATFORM_DB.prepare(
        "DELETE FROM assistant_phone_ingress_usage WHERE binding_id=?"
      ).bind(binding.id),
      env.PLATFORM_DB.prepare(
        "DELETE FROM assistant_phone_bindings WHERE id=?"
      ).bind(binding.id),
    ]);
  }
}

/** Bound private phone-history retention without discarding unresolved carrier operations. */
export async function sweepAssistantPhoneHistory(env: AgentsEnv) {
  if (!env.SCRIPTS_R2) return;
  for (const table of ['assistant_phone_events', 'assistant_phone_actions'] as const) {
    const {results}=await env.PLATFORM_DB.prepare(`SELECT r.id,r.body_key,i.id AS identity_id,i.space_id FROM ${table} r JOIN assistant_phone_bindings b ON b.id=r.binding_id JOIN assistant_communication_identities i ON i.id=b.identity_id WHERE r.created_at<datetime('now','-30 days') ${table==='assistant_phone_actions'?"AND r.status IN ('draft','approved','sent','failed') AND NOT EXISTS(SELECT 1 FROM assistant_phone_events e WHERE e.action_id=r.id)":""} ORDER BY r.created_at,r.id LIMIT 200`).all<{id:string;body_key:string|null;identity_id:string;space_id:string}>();
    for(const row of results){
      if(row.body_key){
        const expected=`spaces/${row.space_id}/communications/${row.identity_id}/${row.id}.json`;
        if(row.body_key!==expected)throw new Error('phone_retention_scope_mismatch');
        // Paired SMS can also be represented in the command inbox; its retention owns that body.
        const shared=await env.PLATFORM_DB.prepare('SELECT id FROM assistant_communication_messages WHERE body_key=? LIMIT 1').bind(row.body_key).first();
        if(!shared)await env.SCRIPTS_R2.delete(row.body_key);
      }
      await env.PLATFORM_DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(row.id).run();
    }
  }
  await env.PLATFORM_DB.prepare("DELETE FROM assistant_live_call_attempts WHERE created_at < ?").bind(Math.floor(Date.now()/1000)-86400*2).run();
  await env.PLATFORM_DB.prepare("UPDATE assistant_live_calls SET status='revoked' WHERE status='armed' AND expires_at<=?").bind(Math.floor(Date.now()/1000)).run();
  await env.PLATFORM_DB.prepare("DELETE FROM assistant_live_calls WHERE status IN ('ended','revoked') AND created_at<?").bind(Math.floor(Date.now()/1000)-86400*30).run();
  await env.PLATFORM_DB.prepare("DELETE FROM assistant_phone_ingress_usage WHERE day<date('now','-35 days')").run();
  await env.PLATFORM_DB.prepare("DELETE FROM assistant_phone_quotes WHERE created_at<datetime('now','-30 days') AND status IN ('quoted','completed','failed')").run();
}
