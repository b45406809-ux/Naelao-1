import { mintInternalToken } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AgentsEnv } from "../index.js";
import {
  isE164,
  parseTwilioVoiceCredentials,
} from "../voice/customer-telephony.js";
import { searchTwilioLocalNumbers } from "../voice/twilio-number-search.js";
import { fetchTwilioNumberPrice } from "../voice/twilio-number-pricing.js";
import {
  channelPreferences,
  scopeAccess,
  readBody,
  storeBody,
  type CommunicationScope,
  type CommunicationIdentity,
} from "./core.js";
import {
  phoneProvider,
  PhoneProviderError,
  resolvePhoneCredentials,
  phoneCallbacks,
  phoneCredentialName,
  phonePublicOrigin,
  xml,
} from "./phone-provider.js";

export interface AssistantPhonePolicy {
  allowWebsiteVerification?: boolean;
  maxDailyActions: number;
  maxDailyInboundMessages: number;
  maxDailyInboundCalls: number;
  maxCallSeconds: number;
  greeting: string;
  voicemail: boolean;
  transferTo: string | null;
}
export const defaultPhonePolicy: AssistantPhonePolicy = {
  allowWebsiteVerification: false,
  maxDailyActions: 20,
  maxDailyInboundMessages: 100,
  maxDailyInboundCalls: 20,
  maxCallSeconds: 300,
  greeting: "",
  voicemail: false,
  transferTo: null,
};
export function validatePhonePolicy(value: unknown): AssistantPhonePolicy {
  const p = value as AssistantPhonePolicy;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    !Number.isSafeInteger(p.maxDailyActions) ||
    p.maxDailyActions < 1 ||
    p.maxDailyActions > 500 ||
    !Number.isSafeInteger(p.maxDailyInboundMessages) ||
    p.maxDailyInboundMessages < 1 ||
    p.maxDailyInboundMessages > 1000 ||
    !Number.isSafeInteger(p.maxDailyInboundCalls) ||
    p.maxDailyInboundCalls < 1 ||
    p.maxDailyInboundCalls > 500 ||
    !Number.isSafeInteger(p.maxCallSeconds) ||
    p.maxCallSeconds < 30 ||
    p.maxCallSeconds > 900 ||
    typeof p.greeting !== "string" ||
    p.greeting.length > 1000 ||
    typeof p.voicemail !== "boolean" ||
    (p.transferTo !== null &&
      (typeof p.transferTo !== "string" || !isE164(p.transferTo)))
  )
    throw new Error("invalid_phone_policy");
  if (
    p.allowWebsiteVerification !== undefined &&
    typeof p.allowWebsiteVerification !== "boolean"
  )
    throw new Error("invalid_phone_policy");
  return {
    allowWebsiteVerification: p.allowWebsiteVerification === true,
    maxDailyActions: p.maxDailyActions,
    maxDailyInboundMessages: p.maxDailyInboundMessages,
    maxDailyInboundCalls: p.maxDailyInboundCalls,
    maxCallSeconds: p.maxCallSeconds,
    greeting: p.greeting,
    voicemail: p.voicemail,
    transferTo: p.transferTo,
  };
}
export interface AssistantPhoneBinding {
  id: string;
  identity_id: string;
  payer: "byo" | "managed";
  provider_account_sid: string;
  provider_number_sid: string | null;
  phone_number: string | null;
  country_code: string | null;
  capabilities_json: string;
  previous_callbacks_json: string;
  status: string;
  policy_json: string;
  monthly_cost_minor: number | null;
}
export async function assistantPhone(env: AgentsEnv, identityId: string) {
  return env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_phone_bindings WHERE identity_id=? ORDER BY rowid DESC LIMIT 1"
  )
    .bind(identityId)
    .first<AssistantPhoneBinding>();
}
async function livePhoneAllowed(env: AgentsEnv, scope: CommunicationScope) {
  if (
    !(await scopeAccess(env, scope, true)) ||
    !(await channelPreferences(env, scope)).enabled.phone ||
    (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId))
  )
    throw new Error("assistant_phone_disabled_or_forbidden");
}
function metadata(binding: AssistantPhoneBinding | null) {
  if (!binding) return null;
  return {
    id: binding.id,
    phone_number: binding.phone_number,
    status: binding.status,
    payer: binding.payer,
    capabilities: JSON.parse(binding.capabilities_json),
    policy: JSON.parse(binding.policy_json),
    monthly_cost_minor: binding.monthly_cost_minor,
    currency: "USD",
  };
}
function checkedNumber(
  record: Record<string, unknown>,
  account: string,
  expectedSid?: string,
  expectedNumber?: string
) {
  if (
    record.account_sid !== account ||
    !/^PN[a-fA-F0-9]{32}$/.test(String(record.sid)) ||
    !isE164(String(record.phone_number)) ||
    (expectedSid && record.sid !== expectedSid) ||
    (expectedNumber && record.phone_number !== expectedNumber)
  )
    throw new PhoneProviderError(true, "phone_provider_record_mismatch");
  const c = record.capabilities as Record<string, unknown> | undefined;
  if (!c || c.voice !== true)
    throw new Error("phone_requires_voice_capability");
  return { voice: true, sms: c.sms === true, mms: c.mms === true };
}
export async function handlePhoneAction(
  env: AgentsEnv,
  scope: CommunicationScope,
  identity: CommunicationIdentity,
  action: string,
  body: Record<string, unknown>,
  manager: boolean,
  agent: boolean
) {
  if (action === "phone-status") {
    const preferences = await channelPreferences(env, scope);
    return {
      phone: metadata(await assistantPhone(env, identity.id)),
      enabled: preferences.enabled.phone,
      managed_available: false,
      managed_reason:
        "Managed numbers require dedicated carrier billing and settlement configuration. Your existing WhatsApp credentials are not used.",
      authority:
        "Phone numbers and caller IDs do not authenticate task commands.",
      billing:
        "BYO Twilio bills your carrier account directly; rental, calls, messages, taxes and regulatory charges are separate.",
    };
  }
  if (
    ![
      "phone-draft",
      "phone-send",
      "phone-actions",
      "phone-events",
      "phone-event",
    ].includes(action) &&
    (!manager || agent)
  )
    throw new Error("human_control_required");
  // Detach/release must remain possible after disabling a channel or suspending paid work.
  if (
    ![
      "phone-detach",
      "phone-release",
      "phone-actions",
      "phone-events",
      "phone-event",
      "phone-reconcile",
      "phone-reconcile-number",
    ].includes(action)
  )
    await livePhoneAllowed(env, scope);
  let binding = await assistantPhone(env, identity.id);
  if (action === "phone-credentials") {
    if (!env.CREDENTIALS_WORKER)
      throw new Error("credential_vault_unavailable");
    if (binding && !["released", "detached"].includes(binding.status))
      throw new Error("detach_phone_before_changing_credentials");
    const credentials = parseTwilioVoiceCredentials(
      JSON.stringify({
        accountSid: body.account_sid,
        authToken: body.auth_token,
      })
    );
    if (!credentials) throw new Error("invalid_twilio_credentials");
    // Verify credentials against a bounded harmless account resource before storing.
    await phoneProvider(credentials, "IncomingPhoneNumbers.json");
    const r = await env.CREDENTIALS_WORKER.fetch(
      new Request(
        `http://credentials/spaces/${encodeURIComponent(scope.spaceId)}/credentials`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": scope.tenantId,
            "x-naelao-user-id": scope.userId,
            "x-naelao-role": "admin",
            "x-naelao-internal-token": await mintInternalToken(
              env.PLATFORM_SECRET,
              scope.tenantId
            ),
          },
          body: JSON.stringify({
            name: phoneCredentialName(identity),
            value: JSON.stringify(credentials),
            scope: "space",
            description: "Scoped assistant telephone provider credentials",
          }),
        }
      )
    );
    if (!r.ok) throw new Error("credential_store_failed");
    return { configured: true };
  }
  if (action === "phone-actions" || action === "phone-events") {
    const raw = body.before;
    let cursor: { at: string; id: string } | undefined;
    if (raw !== undefined) {
      try {
        if (typeof raw !== "string" || raw.length > 600) throw new Error();
        cursor = JSON.parse(atob(raw)) as { at: string; id: string };
        if (
          typeof cursor.at !== "string" ||
          typeof cursor.id !== "string" ||
          cursor.at.length > 40 ||
          cursor.id.length > 160
        )
          throw new Error();
      } catch {
        throw new Error("invalid_phone_cursor");
      }
    }
    const table =
      action === "phone-actions"
        ? "assistant_phone_actions"
        : "assistant_phone_events";
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT * FROM ${table} WHERE binding_id=? ${cursor ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT 51`
    )
      .bind(
        binding?.id ?? "",
        ...(cursor ? [cursor.at, cursor.at, cursor.id] : [])
      )
      .all<Record<string, unknown>>();
    return {
      data: results.slice(0, 50).map(({ body_key, ...r }) => r),
      next_cursor:
        results.length > 50
          ? btoa(
              JSON.stringify({
                at: results[49]!.created_at,
                id: results[49]!.id,
              })
            )
          : null,
    };
  }
  if (action === "phone-event") {
    const event = await env.PLATFORM_DB.prepare(
      "SELECT body_key FROM assistant_phone_events WHERE id=? AND binding_id=?"
    )
      .bind(String(body.id), binding?.id ?? "")
      .first<{ body_key: string | null }>();
    if (!event) throw new Error("phone_event_not_found");
    const content = event.body_key
      ? await readBody(env, identity, String(body.id), event.body_key)
      : null;
    if (!content) return { body: null };
    const { private_text, private_actor_id, ...visible } = content;
    return {
      body:
        !agent && private_actor_id === scope.userId
          ? { ...visible, text: private_text }
          : visible,
    };
  }

  const payer =
    binding?.payer ?? (body.payer === "managed" ? "managed" : "byo");
  const credentials = await resolvePhoneCredentials(env, identity, payer);
  if (!credentials)
    throw new Error(
      payer === "managed"
        ? "managed_phone_billing_not_configured"
        : "assistant_phone_credentials_missing"
    );
  if (
    binding &&
    !["released", "detached"].includes(binding.status) &&
    binding.provider_account_sid !== credentials.accountSid
  )
    throw new Error("phone_provider_account_changed");
  if (action === "phone-search") {
    const country = String(body.country ?? "").toUpperCase(),
      areaCode = String(body.area_code ?? "");
    const r = await searchTwilioLocalNumbers({
      credentials,
      country,
      ...(areaCode ? { areaCode } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return { numbers: r.numbers, purchased: false };
  }
  if (action === "phone-quote") {
    if (binding && !["released", "detached"].includes(binding.status))
      throw new Error("assistant_phone_already_bound");
    const number = String(body.phone_number ?? ""),
      country = String(body.country ?? "").toUpperCase();
    if (!isE164(number) || !/^[A-Z]{2}$/.test(country))
      throw new Error("invalid_phone_number");
    const r = await searchTwilioLocalNumbers({
      credentials,
      country,
      phoneNumber: number,
    });
    if (!r.ok || !r.numbers.some((n) => n.phone_number === number))
      throw new Error("phone_number_unavailable");
    const price = await fetchTwilioNumberPrice({
      credentials,
      phoneNumber: number,
      country,
    });
    const id = crypto.randomUUID(),
      expires = new Date(Date.now() + 180000).toISOString();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_phone_quotes(id,identity_id,payer,provider_account_sid,phone_number,country_code,monthly_cost_minor,inbound_rate_minor,quoted_by,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        id,
        identity.id,
        payer,
        credentials.accountSid,
        number,
        country,
        price.monthlyCostMinor,
        price.inboundPricePerMinuteMinor,
        scope.userId,
        expires
      )
      .run();
    return {
      quote_id: id,
      phone_number: number,
      monthly_cost_minor: price.monthlyCostMinor,
      currency: "USD",
      taxes_included: false,
      inbound_price_per_minute_minor: price.inboundPricePerMinuteMinor,
      expires_at: expires,
      billed_by: "Twilio",
      other_usage_charges_apply: true,
    };
  }
  if (action === "phone-import" || action === "phone-purchase") {
    if (binding && !["released", "detached"].includes(binding.status))
      throw new Error("assistant_phone_already_bound");
    if (body.confirm !== true)
      throw new Error("explicit_phone_confirmation_required");
    let record: Record<string, unknown> | undefined;
    type Quote = {
      id: string;
      phone_number: string;
      country_code: string;
      monthly_cost_minor: number;
      inbound_rate_minor: number;
    };
    let quote: Quote | null = null;
    if (action === "phone-import") {
      if (!/^PN[a-fA-F0-9]{32}$/.test(String(body.number_sid)))
        throw new Error("invalid_phone_number_sid");
      record = await phoneProvider(
        credentials,
        `IncomingPhoneNumbers/${body.number_sid}.json`
      );
      checkedNumber(record, credentials.accountSid, String(body.number_sid));
      // A number already assigned to another identity may never have callbacks overwritten.
      if (
        await env.PLATFORM_DB.prepare(
          "SELECT id FROM assistant_phone_bindings WHERE provider_number_sid=? AND status NOT IN ('released','detached')"
        )
          .bind(body.number_sid)
          .first()
      )
        throw new Error("phone_already_assigned");
    } else {
      quote = await env.PLATFORM_DB.prepare(
        "SELECT * FROM assistant_phone_quotes WHERE id=? AND identity_id=? AND quoted_by=? AND provider_account_sid=? AND status='quoted' AND expires_at>?"
      )
        .bind(
          String(body.quote_id),
          identity.id,
          scope.userId,
          credentials.accountSid,
          new Date().toISOString()
        )
        .first<Quote>();
      if (
        !quote ||
        body.confirm_monthly_cost_minor !== quote.monthly_cost_minor
      )
        throw new Error("phone_quote_expired_or_price_not_confirmed");
      const price = await fetchTwilioNumberPrice({
        credentials,
        phoneNumber: quote.phone_number,
        country: quote.country_code,
      });
      if (
        price.monthlyCostMinor !== quote.monthly_cost_minor ||
        price.inboundPricePerMinuteMinor !== quote.inbound_rate_minor
      )
        throw new Error("phone_price_changed");
      const claimed = await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_quotes SET status='processing' WHERE id=? AND status='quoted' AND expires_at>?"
      )
        .bind(quote.id, new Date().toISOString())
        .run();
      if (!claimed.meta.changes) throw new Error("phone_quote_already_used");
    }
    const id = crypto.randomUUID(),
      callbacks = phoneCallbacks(env, id);
    const previous = record
      ? Object.fromEntries(
          [
            "voice_url",
            "voice_method",
            "sms_url",
            "sms_method",
            "status_callback",
            "status_callback_method",
          ].map((k) => [k, record![k] ?? ""])
        )
      : {};
    // Claim the assistant slot before any paid/remote mutation. Keep uncertain claims for reconciliation.

    await env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_phone_bindings(id,identity_id,payer,provider_account_sid,provider_number_sid,phone_number,country_code,capabilities_json,previous_callbacks_json,policy_json,monthly_cost_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        id,
        identity.id,
        payer,
        credentials.accountSid,
        record?.sid ?? null,
        record?.phone_number ?? quote!.phone_number,
        quote?.country_code ?? null,
        JSON.stringify(record?.capabilities ?? {}),
        JSON.stringify(previous),
        JSON.stringify(defaultPhonePolicy),
        quote?.monthly_cost_minor ?? null
      )
      .run();
    try {
      await livePhoneAllowed(env, scope);
      const form = new URLSearchParams(callbacks);
      if (quote) form.set("PhoneNumber", quote.phone_number);
      record = await phoneProvider(
        credentials,
        quote
          ? "IncomingPhoneNumbers.json"
          : `IncomingPhoneNumbers/${record!.sid}.json`,
        "POST",
        form
      );
      const capabilities = checkedNumber(
        record,
        credentials.accountSid,
        quote ? undefined : String(body.number_sid),
        quote?.phone_number
      );
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_bindings SET provider_number_sid=?,phone_number=?,capabilities_json=?,status='active',updated_at=datetime('now') WHERE id=? AND status='configuring'"
      )
        .bind(record.sid, record.phone_number, JSON.stringify(capabilities), id)
        .run();
      if (quote)
        await env.PLATFORM_DB.prepare(
          "UPDATE assistant_phone_quotes SET status='completed' WHERE id=?"
        )
          .bind(quote.id)
          .run();
      return { phone: metadata(await assistantPhone(env, identity.id)) };
    } catch (error) {
      const rejected = error instanceof PhoneProviderError && !error.uncertain;
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_bindings SET status=? WHERE id=?"
      )
        .bind(
          rejected && quote
            ? "detached"
            : rejected
              ? "failed"
              : "indeterminate",
          id
        )
        .run();
      if (rejected && quote) {
        await env.PLATFORM_DB.prepare(
          "UPDATE assistant_phone_bindings SET phone_number=NULL WHERE id=?"
        )
          .bind(id)
          .run();
        await env.PLATFORM_DB.prepare(
          "UPDATE assistant_phone_quotes SET status='failed' WHERE id=?"
        )
          .bind(quote.id)
          .run();
      }
      throw error;
    }
  }
  if (action === "phone-reconcile-number") {
    if (
      !binding ||
      !["indeterminate", "failed", "configuring"].includes(binding.status) ||
      !manager ||
      agent ||
      body.provider_checked !== true
    )
      throw new Error("phone_number_reconciliation_required");
    if (!/^PN[a-fA-F0-9]{32}$/.test(String(body.number_sid)))
      throw new Error("invalid_phone_number_sid");
    const record = await phoneProvider(
      credentials,
      `IncomingPhoneNumbers/${body.number_sid}.json`
    );
    const caps = checkedNumber(
      record,
      credentials.accountSid,
      String(body.number_sid),
      binding.phone_number ?? undefined
    );
    const expected = phoneCallbacks(env, binding.id);
    if (
      record.voice_url !== expected.VoiceUrl ||
      record.sms_url !== expected.SmsUrl
    )
      throw new Error("phone_callbacks_not_attached");
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_bindings SET status='active',provider_number_sid=?,phone_number=?,capabilities_json=? WHERE id=? AND status IN ('indeterminate','failed','configuring')"
    )
      .bind(record.sid, record.phone_number, JSON.stringify(caps), binding.id)
      .run();
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_quotes SET status='completed' WHERE identity_id=? AND phone_number=? AND status='processing'"
    )
      .bind(identity.id, record.phone_number)
      .run();
    return { phone: metadata(await assistantPhone(env, identity.id)) };
  }
  if (!binding || !binding.provider_number_sid)
    throw new Error("assistant_phone_not_connected");
  if (action === "phone-handler") {
    if (!manager || agent || !scope.projectId || body.confirm !== true)
      throw new Error("phone_handler_owner_confirmation_required");
    const installation = String(body.installation_id ?? ""),
      digest = String(body.handler_sha256 ?? "");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(installation) ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error("invalid_phone_handler_reference");
    const previous = await env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_phone_extension_handlers WHERE binding_id=?"
    )
      .bind(binding.id)
      .first<{
        installation_id: string;
        handler_sha256: string;
        status: string;
      }>();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES(?,?,?,'pending') ON CONFLICT(binding_id) DO UPDATE SET installation_id=excluded.installation_id,handler_sha256=excluded.handler_sha256,status='pending'"
    )
      .bind(binding.id, installation, digest)
      .run();
    try {
      const r = await env.AGENTS_WORKER.fetch(
        new Request("http://agents/internal/phone-extension-dispatch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": scope.tenantId,
            "x-naelao-internal-token": await mintInternalToken(
              env.PLATFORM_SECRET,
              scope.tenantId
            ),
          },
          body: JSON.stringify({
            bindingId: binding.id,
            spaceId: scope.spaceId,
            validateOnly: true,
          }),
        })
      );
      if (!r.ok || (await r.json<{ valid?: boolean }>()).valid !== true)
        throw new Error("phone_extension_validation_failed");
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_extension_handlers SET status='active' WHERE binding_id=? AND installation_id=? AND handler_sha256=?"
      )
        .bind(binding.id, installation, digest)
        .run();
      return { bound: true };
    } catch (e) {
      if (previous)
        await env.PLATFORM_DB.prepare(
          "UPDATE assistant_phone_extension_handlers SET installation_id=?,handler_sha256=?,status=? WHERE binding_id=? AND installation_id=? AND handler_sha256=?"
        )
          .bind(
            previous.installation_id,
            previous.handler_sha256,
            previous.status,
            binding.id,
            installation,
            digest
          )
          .run();
      else
        await env.PLATFORM_DB.prepare(
          "DELETE FROM assistant_phone_extension_handlers WHERE binding_id=? AND installation_id=? AND handler_sha256=?"
        )
          .bind(binding.id, installation, digest)
          .run();
      throw e;
    }
  }
  if (action === "phone-policy") {
    const policy = validatePhonePolicy(body.policy);
    if (policy.transferTo === binding.phone_number)
      throw new Error("phone_transfer_loop");
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_bindings SET policy_json=?,updated_at=datetime('now') WHERE id=?"
    )
      .bind(JSON.stringify(policy), binding.id)
      .run();
    return { policy };
  }
  if (action === "phone-detach" || action === "phone-release") {
    if (!manager || agent || body.confirm !== true)
      throw new Error("explicit_phone_confirmation_required");
    // Disable locally first. A failed remote release remains visible and retryable.
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_bindings SET status='disabling' WHERE id=?"
    )
      .bind(binding.id)
      .run();
    if (action === "phone-release") {
      await phoneProvider(
        credentials,
        `IncomingPhoneNumbers/${binding.provider_number_sid}.json`,
        "DELETE"
      );
    } else {
      const previous = JSON.parse(binding.previous_callbacks_json) as Record<
        string,
        string
      >;
      const form = new URLSearchParams({
        VoiceUrl: previous.voice_url ?? "",
        VoiceMethod: previous.voice_method || "POST",
        SmsUrl: previous.sms_url ?? "",
        SmsMethod: previous.sms_method || "POST",
        StatusCallback: previous.status_callback ?? "",
        StatusCallbackMethod: previous.status_callback_method || "POST",
      });
      await phoneProvider(
        credentials,
        `IncomingPhoneNumbers/${binding.provider_number_sid}.json`,
        "POST",
        form
      );
    }
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_bindings SET status=?,updated_at=datetime('now') WHERE id=?"
    )
      .bind(action === "phone-release" ? "released" : "detached", binding.id)
      .run();
    return {
      status: action === "phone-release" ? "released" : "detached",
      rental_continues: action === "phone-detach",
    };
  }
  if (action === "phone-draft") {
    if (binding.status !== "active")
      throw new Error("assistant_phone_not_active");
    const kind = String(body.kind ?? ""),
      recipient = String(body.to ?? ""),
      text = String(body.text ?? ""),
      dtmf = String(body.dtmf ?? "");
    if (
      !["sms", "call"].includes(kind) ||
      !isE164(recipient) ||
      text.length < 1 ||
      text.length > (kind === "sms" ? 1600 : 3000) ||
      !/^[0-9*#wW]{0,64}$/.test(dtmf)
    )
      throw new Error("invalid_phone_draft");
    // MMS attachments are chosen from scoped encrypted uploads, never arbitrary external URLs.
    if (body.media !== undefined)
      throw new Error("phone_media_upload_required");
    const caps = JSON.parse(binding.capabilities_json) as Record<
      string,
      boolean
    >;
    if (!caps[kind === "sms" ? "sms" : "voice"])
      throw new Error("phone_capability_unavailable");
    const id =
      "pa_" + String(Date.now()).padStart(13, "0") + "_" + crypto.randomUUID();
    const key = await storeBody(env, identity, id, { text, dtmf });
    await env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key) VALUES(?,?,?,?,?,?)"
    )
      .bind(id, binding.id, scope.userId, kind, recipient, key)
      .run();
    return { id, status: "draft", requires_approval: true };
  }
  const row = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_phone_actions WHERE id=? AND binding_id=?"
  )
    .bind(String(body.id), binding.id)
    .first<{
      id: string;
      actor_id: string;
      kind: string;
      recipient: string;
      body_key: string;
      status: string;
      provider_sid: string | null;
      updated_at: string;
    }>();
  if (!row) throw new Error("phone_action_not_found");
  if (action === "phone-approve") {
    if (!manager || agent) throw new Error("human_control_required");
    const change = await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_actions SET status='approved',approved_by=? WHERE id=? AND status='draft'"
    )
      .bind(scope.userId, row.id)
      .run();
    if (!change.meta.changes) throw new Error("phone_action_not_draft");
    return { id: row.id, status: "approved" };
  }
  if (action === "phone-reconcile") {
    if (
      !manager ||
      agent ||
      body.provider_checked !== true ||
      !["sent", "not_sent"].includes(String(body.outcome))
    )
      throw new Error("provider_reconciliation_confirmation_required");
    if (!["sending", "indeterminate"].includes(row.status))
      throw new Error("phone_action_not_indeterminate");
    if (body.outcome === "not_sent") {
      const at = Date.parse(
        row.updated_at.includes("T")
          ? row.updated_at
          : row.updated_at.replace(" ", "T") + "Z"
      );
      if (!Number.isFinite(at) || Date.now() - at < 120000)
        throw new Error("phone_reconciliation_wait_for_provider");
    }
    const sid = String(body.provider_sid ?? "");
    if (body.outcome === "sent") {
      if (
        !(
          row.kind === "sms" ? /^SM[a-fA-F0-9]{32}$/ : /^CA[a-fA-F0-9]{32}$/
        ).test(sid)
      )
        throw new Error("invalid_phone_provider_sid");
      const record = await phoneProvider(
        credentials,
        `${row.kind === "sms" ? "Messages" : "Calls"}/${sid}.json`
      );
      if (
        record.account_sid !== credentials.accountSid ||
        record.to !== row.recipient ||
        record.from !== binding.phone_number
      )
        throw new Error("phone_reconciliation_record_mismatch");
    }
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_actions SET status=?,approved_by=NULL,provider_sid=?,updated_at=datetime('now') WHERE id=? AND status IN ('sending','indeterminate')"
    )
      .bind(
        body.outcome === "sent" ? "sent" : "draft",
        body.outcome === "sent" ? sid : null,
        row.id
      )
      .run();
    return { reconciled: true };
  }
  if (action !== "phone-send") throw new Error("unknown_phone_action");
  if (row.status === "sent")
    return {
      id: row.id,
      provider_sid: row.provider_sid,
      status: "sent",
      deduplicated: true,
    };
  if (row.status !== "approved" || binding.status !== "active")
    throw new Error("phone_action_approval_required");
  const policy = validatePhonePolicy(JSON.parse(binding.policy_json));
  const claimed = await env.PLATFORM_DB.prepare(
    "UPDATE assistant_phone_actions SET status='sending',updated_at=datetime('now') WHERE id=? AND status='approved' AND (SELECT COUNT(*) FROM assistant_phone_actions WHERE binding_id=? AND status IN ('sending','indeterminate','sent') AND updated_at>=date('now'))<?"
  )
    .bind(row.id, binding.id, policy.maxDailyActions)
    .run();
  if (!claimed.meta.changes)
    throw new Error("phone_action_already_claimed_or_daily_limit");
  try {
    await livePhoneAllowed(env, scope);
    const content = await readBody(env, identity, row.id, row.body_key);
    const root = `${phonePublicOrigin(env)}/assistant-phone/twilio/${binding.id}`;
    const form = new URLSearchParams({
      From: binding.phone_number!,
      To: row.recipient,
      StatusCallback: `${root}/status`,
    });
    if (row.kind === "sms") form.set("Body", String(content.text));
    else {
      form.set(
        "Twiml",
        `<Response><Say>This is an AI assistant calling on behalf of its owner.</Say>${content.dtmf ? `<Play digits="${xml(String(content.dtmf))}"/>` : ""}<Say>${xml(String(content.text))}</Say></Response>`
      );
      form.set("TimeLimit", String(policy.maxCallSeconds));
      form.set("Timeout", "30");
    }
    const result = await phoneProvider(
      credentials,
      row.kind === "sms" ? "Messages.json" : "Calls.json",
      "POST",
      form
    );
    if (
      result.account_sid !== credentials.accountSid ||
      !(
        row.kind === "sms" ? /^SM[a-fA-F0-9]{32}$/ : /^CA[a-fA-F0-9]{32}$/
      ).test(String(result.sid))
    )
      throw new PhoneProviderError(true);
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_actions SET status='sent',provider_sid=?,updated_at=datetime('now') WHERE id=? AND status='sending'"
    )
      .bind(result.sid, row.id)
      .run();
    return { id: row.id, status: "sent", provider_sid: result.sid };
  } catch (error) {
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_phone_actions SET status=?,error_code=?,updated_at=datetime('now') WHERE id=? AND status='sending'"
    )
      .bind(
        error instanceof PhoneProviderError && !error.uncertain
          ? "failed"
          : "indeterminate",
        error instanceof PhoneProviderError
          ? error.code
          : "phone_send_interrupted",
        row.id
      )
      .run();
    throw error;
  }
}
