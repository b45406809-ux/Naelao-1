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
