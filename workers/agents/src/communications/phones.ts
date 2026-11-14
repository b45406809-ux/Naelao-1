import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AgentsEnv } from "../index.js";
import { verifyExtensionArtifactSet } from "../workflows/workflow-host.js";
import {
  isE164,
  parseTwilioVoiceCredentials,
} from "../voice/twilio-telephony.js";
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
import { telnyxCallControlIdHash } from "./telnyx-voice-cost.js";

type ExtensionCallCostSummary = {
  status: "reported" | "unavailable" | "not_linked";
  provider_cost_micros: number | null;
  currency: string | null;
  leg_count: number | null;
};

const MAX_REPORTED_COST_LEGS_PER_CALL = 32;

async function extensionCallCostSummaries(
  env: AgentsEnv,
  calls: Array<{ binding_id: string; call_control_id: string }>,
) {
  const unique = [...new Map(calls.map(call => [`${call.binding_id}\0${call.call_control_id}`, call])).values()];
  if (!unique.length) return new Map<string, ExtensionCallCostSummary>();
  const hashed = await Promise.all(unique.map(async call => ({
    binding_id: call.binding_id,
    call_control_id: call.call_control_id,
    call_control_id_sha256: await telnyxCallControlIdHash(call.binding_id, call.call_control_id),
  })));
  const values = hashed.map(() => "(?,?)").join(",");
  const rows = (await env.PLATFORM_DB.prepare(`WITH requested(binding_id,call_control_id_sha256) AS (VALUES ${values}),
      ranked AS (
        SELECT c.binding_id,c.call_control_id_sha256,c.provider_cost_micros,c.currency,
          ROW_NUMBER() OVER (PARTITION BY c.binding_id,c.call_control_id_sha256 ORDER BY c.call_leg_id_sha256) AS leg_rank
        FROM assistant_telnyx_voice_cost_receipts c
        JOIN requested r ON r.binding_id=c.binding_id AND r.call_control_id_sha256=c.call_control_id_sha256
      )
      SELECT binding_id,call_control_id_sha256,MAX(leg_rank) AS sampled_leg_count,
        COUNT(DISTINCT CASE WHEN leg_rank<=${MAX_REPORTED_COST_LEGS_PER_CALL} THEN currency END) AS currency_count,
        MIN(CASE WHEN leg_rank<=${MAX_REPORTED_COST_LEGS_PER_CALL} THEN currency END) AS currency,
        SUM(CASE WHEN leg_rank<=${MAX_REPORTED_COST_LEGS_PER_CALL} THEN provider_cost_micros ELSE 0 END) AS provider_cost_micros
      FROM ranked WHERE leg_rank<=${MAX_REPORTED_COST_LEGS_PER_CALL + 1}
      GROUP BY binding_id,call_control_id_sha256`)
    .bind(...hashed.flatMap(row => [row.binding_id, row.call_control_id_sha256]))
    .all<{ binding_id: string; call_control_id_sha256: string; sampled_leg_count: number; currency_count: number;
      currency: string | null; provider_cost_micros: number | null }>()).results;
  const output = new Map<string, ExtensionCallCostSummary>();
  for (const row of rows) {
    const legCount = Number(row.sampled_leg_count);
    const amount = row.provider_cost_micros == null ? NaN : Number(row.provider_cost_micros);
    const available = legCount <= MAX_REPORTED_COST_LEGS_PER_CALL && Number(row.currency_count) === 1
      && typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) && Number.isSafeInteger(amount) && amount >= 0;
    output.set(`${row.binding_id}\0${row.call_control_id_sha256}`, {
      status: available ? "reported" : "unavailable",
      provider_cost_micros: available ? amount : null,
      currency: available ? row.currency : null,
      leg_count: available ? legCount : null,
    });
  }
  return new Map(hashed.flatMap(row => {
    const summary = output.get(`${row.binding_id}\0${row.call_control_id_sha256}`);
    return summary ? [[`${row.binding_id}\0${row.call_control_id}`, summary] as const] : [];
  }));
}

export interface AssistantPhonePolicy {
  allowWebsiteVerification?: boolean;
  allowSpeechInput?: boolean;
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
  allowSpeechInput: false,
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
  if (p.allowSpeechInput !== undefined && typeof p.allowSpeechInput !== "boolean")
    throw new Error("invalid_phone_policy");
  return {
    allowWebsiteVerification: p.allowWebsiteVerification === true,
    allowSpeechInput: p.allowSpeechInput === true,
    maxDailyActions: p.maxDailyActions,
    maxDailyInboundMessages: p.maxDailyInboundMessages,
    maxDailyInboundCalls: p.maxDailyInboundCalls,
    maxCallSeconds: p.maxCallSeconds,
    greeting: p.greeting,
    voicemail: p.voicemail,
    transferTo: p.transferTo,
  };
}

type PhoneHandlerCandidate = {
  installation_id: string;
  extension_id: string;
  name: string;
  version: string;
  handler_sha256: string;
};

/** Return only active, signed phone handlers whose installed package bytes still match the
 * release receipt. The owner assignment path performs its existing full admission check again. */
async function listPhoneHandlerCandidates(env: AgentsEnv, scope: CommunicationScope): Promise<PhoneHandlerCandidate[]> {
  const bucket = env.SCRIPTS_R2;
  if (!env.SPACES_WORKER || !bucket || !/^[A-Za-z0-9._:-]{1,160}$/.test(scope.spaceId)
    || (scope.projectId !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(scope.projectId))) return [];
  try {
    const headers = { "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) };
    const query = new URLSearchParams(scope.projectId ? { project_id: scope.projectId } : {});
    const queryString = query.toString();
    const route = `http://spaces-worker/spaces/${encodeURIComponent(scope.spaceId)}/internal/channel-installations${queryString ? `?${queryString}` : ""}`;
    const listed = await env.SPACES_WORKER.fetch(new Request(route, { headers }));
    if (!listed.ok) return [];
    const result = await readBoundedResponseJson<{ installations?: Array<{
      instance_id?: string; extension_id?: string; name?: string; status?: string; scope?: string;
      channels?: Array<{ provider?: string }>;
    }> }>(listed, 1024 * 1024);
    const candidates = (result.installations ?? []).filter(item => item.status === "active"
      && typeof item.instance_id === "string" && typeof item.extension_id === "string"
      && item.channels?.some(channel => channel.provider === "phone")).slice(0, 20);
    const output: PhoneHandlerCandidate[] = [];
    for (const candidate of candidates) {
      const detailResponse = await env.SPACES_WORKER.fetch(new Request(
        `http://spaces-worker/spaces/${encodeURIComponent(scope.spaceId)}/workflow-installations/${encodeURIComponent(candidate.instance_id!)}`,
        { headers },
      ));
      if (!detailResponse.ok) continue;
      const detail = await readBoundedResponseJson<{
        instance?: { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null; scope?: string; status?: string };
        manifest?: { id?: string; bundle?: { id?: string; version?: string }; channels?: Array<{
          kind?: string; provider?: string; context?: string; handlerScript?: string;
          inboundEvents?: string[]; outboundEvents?: string[]; permissions?: unknown[]; capabilityRequirements?: unknown[];
          knowledgeCollections?: string[];
        }> };
        release?: { version?: string; artifactSha256?: string; signatureValid?: boolean } | null;
      }>(detailResponse, 1024 * 1024);
      const instance = detail.instance, manifest = detail.manifest, release = detail.release;
      const expectedProject = scope.projectId ?? null;
      if (!instance || !manifest || instance.instance_id !== candidate.instance_id || instance.tenant_id !== scope.tenantId
        || instance.space_id !== scope.spaceId || (instance.project_id ?? null) !== expectedProject || instance.status !== "active"
        || (expectedProject ? !["PROJECT_BOUND", "PROJECT_SHARED"].includes(instance.scope ?? "") : instance.scope !== "SPACE_SHARED")) continue;
      const bundle = manifest.bundle;
      const extensionId = manifest.id;
      const version = bundle?.version;
      const artifactSha256 = release?.artifactSha256;
      const phoneChannels = manifest.channels?.filter(channel => channel.kind === "channel" && channel.provider === "phone" && channel.context === "channel_only") ?? [];
      if (phoneChannels.length !== 1 || !extensionId || extensionId !== candidate.extension_id || bundle?.id !== extensionId || !version
        || release?.version !== version || release.signatureValid !== true || !artifactSha256
        || !/^[a-f0-9]{64}$/.test(artifactSha256)) continue;
      const declaration = phoneChannels[0]!;
      const path = declaration.handlerScript?.match(/^\.\/([A-Za-z0-9._-]{1,128}\.(?:ts|js))$/);
      if (!path || !declaration.inboundEvents?.includes("message.received") || !declaration.outboundEvents?.includes("message.reply")
        || (declaration.permissions?.length ?? 0) !== 0 || (declaration.capabilityRequirements?.length ?? 0) !== 0
        || (declaration.knowledgeCollections?.length ?? 0) !== 0) continue;
      if (!await verifyExtensionArtifactSet(bucket, { spaceId: scope.spaceId, extensionId, version, expectedSha256: artifactSha256 })) continue;
      const artifactKey = `spaces/${scope.spaceId}/extensions/${extensionId}/${version}/${path[1]}`;
      const artifact = await bucket.get(artifactKey);
      if (!artifact || artifact.size > 262_144) continue;
      const bytes = await artifact.arrayBuffer();
      if (bytes.byteLength !== artifact.size || bytes.byteLength > 262_144) continue;
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { continue; }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
      const handlerSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      output.push({ installation_id: candidate.instance_id!, extension_id: extensionId, name: candidate.name || extensionId, version, handler_sha256: handlerSha256 });
    }
    return output;
  } catch {
    // The status view stays available when the extension registry or artifact store is not.
    return [];
  }
}
export interface AssistantPhoneBinding {
  provider?: "twilio" | "telnyx";
  id: string;
  identity_id: string;
  purpose?: "assistant" | "extension";
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
  managed_price_version: string | null;
  managed_rental_credits_per_month: number | null;
  managed_sms_credits_per_segment: number | null;
  managed_call_credits_per_minute: number | null;
}
export async function assistantPhone(env: AgentsEnv, identityId: string) {
  return env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_phone_bindings WHERE identity_id=? AND purpose='assistant' ORDER BY rowid DESC LIMIT 1"
  )
    .bind(identityId)
    .first<AssistantPhoneBinding>();
}
type TelnyxNumberOrderOperation = {
  id: string; identity_id: string; quote_id: string; binding_id: string; provider_account_ref: string;
  customer_reference: string; phone_number: string; country_code: string; upfront_cost_minor: number;
  monthly_cost_minor: number; currency: string; status: string; provider_order_id: string | null;
  provider_number_id: string | null; reconcile_attempts?:number; next_reconcile_at?:string|null; lease_until?:string|null;
};
function isTelnyxOrderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Fa-f0-9-]{36}$/.test(value);
}
async function reconcileTelnyxNumberOrder(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  client: InstanceType<typeof import("../voice/telnyx-telephony.js").TelnyxTelephony>,
  operation: TelnyxNumberOrderOperation,
  order: Record<string, unknown>,
) {
  if (!isTelnyxOrderId(order.id) || order.customer_reference !== operation.customer_reference
    || !["pending", "success", "failure"].includes(String(order.status))) throw new PhoneProviderError(true, "telnyx_number_order_receipt_invalid");
  const providerOrderId = order.id;
  if (order.status === "pending") {
    const nextCheck=new Date(Date.now()+5*60_000).toISOString();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_number_order_operations SET status='pending',provider_order_id=?,last_error=NULL,lease_until=NULL,next_reconcile_at=?,last_reconciled_at=?,updated_at=? WHERE id=? AND identity_id=? AND status IN ('submitting','uncertain','pending')")
        .bind(providerOrderId,nextCheck,new Date().toISOString(),new Date().toISOString(),operation.id,identity.id),
      env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='configuring',updated_at=datetime('now') WHERE id=? AND identity_id=? AND status IN ('configuring','indeterminate')")
        .bind(operation.binding_id, identity.id),
    ]);
    return { operation_id: operation.id, status: "pending", provider_order_id: providerOrderId, phone_number: operation.phone_number };
  }
  if (order.status === "failure") {
    const at=new Date().toISOString();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_number_order_operations SET status='failed',provider_order_id=?,last_error='provider_order_failed',lease_until=NULL,next_reconcile_at=NULL,last_reconciled_at=?,updated_at=? WHERE id=? AND identity_id=? AND status IN ('submitting','uncertain','pending')").bind(providerOrderId,at,at,operation.id,identity.id),
      env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='detached',updated_at=datetime('now') WHERE id=? AND identity_id=? AND status IN ('configuring','indeterminate')").bind(operation.binding_id, identity.id),
      env.PLATFORM_DB.prepare("UPDATE assistant_phone_quotes SET status='failed' WHERE id=? AND status='processing'").bind(operation.quote_id),
    ]);
    return { operation_id: operation.id, status: "failed", provider_order_id: providerOrderId, phone_number: operation.phone_number };
  }
  const numbers = Array.isArray(order.phone_numbers) ? order.phone_numbers : [];
  const ordered = numbers.length === 1 && numbers[0] && typeof numbers[0] === "object" && !Array.isArray(numbers[0])
    ? numbers[0] as Record<string, unknown> : null;
  if (!ordered || ordered.phone_number !== operation.phone_number || typeof ordered.id !== "string" || !/^\d{1,32}$/.test(ordered.id))
    throw new PhoneProviderError(true, "telnyx_number_order_number_missing");
  const number = await client.inspectPhoneNumber(ordered.id);
  if (number.phoneNumber !== operation.phone_number) throw new PhoneProviderError(true, "telnyx_number_order_number_mismatch");
  const at=new Date().toISOString();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_number_order_operations SET status='succeeded',provider_order_id=?,provider_number_id=?,last_error=NULL,lease_until=NULL,next_reconcile_at=NULL,last_reconciled_at=?,updated_at=? WHERE id=? AND identity_id=? AND status IN ('submitting','uncertain','pending')")
      .bind(providerOrderId,number.id,at,at,operation.id,identity.id),
    env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET provider_number_sid=?,phone_number=?,country_code=?,status='configuring',updated_at=datetime('now') WHERE id=? AND identity_id=? AND provider='telnyx' AND payer='byo' AND status IN ('configuring','indeterminate')")
      .bind(number.id, number.phoneNumber, operation.country_code, operation.binding_id, identity.id),
    env.PLATFORM_DB.prepare("UPDATE assistant_phone_quotes SET status='completed' WHERE id=? AND status='processing'").bind(operation.quote_id),
  ]);
  return { operation_id: operation.id, status: "succeeded", provider_order_id: providerOrderId, phone_number: number.phoneNumber };
}

type TelnyxNumberOrderReconciliationRow=TelnyxNumberOrderOperation&Omit<CommunicationIdentity,"id">&{
  identity_record_id:string;identity_status:string;
  binding_payer:string;binding_provider_number_sid:string|null;binding_phone_number:string|null;binding_status:string;
};

async function deferTelnyxNumberOrderReconciliation(env:AgentsEnv,operation:TelnyxNumberOrderReconciliationRow,errorCode:string,now:Date){
  const attempts=(operation.reconcile_attempts??0)+1;
  const delay=Math.min(24*60*60_000,5*60_000*2**Math.min(attempts-1,8));
  const next=new Date(now.getTime()+delay).toISOString();
  await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_order_operations SET
      status=CASE WHEN status='submitting' THEN 'uncertain' ELSE status END,lease_until=NULL,last_error=?,
      reconcile_attempts=?,next_reconcile_at=?,last_reconciled_at=?,updated_at=?
    WHERE id=? AND identity_id=? AND status IN ('submitting','uncertain','pending')`)
    .bind(errorCode,attempts,next,now.toISOString(),now.toISOString(),operation.id,operation.identity_id).run();
}

/** Polls only provider read APIs after an ambiguous customer-owned number order. It never resubmits a paid order. */
export async function sweepTelnyxNumberOrders(env:AgentsEnv,now=new Date(),limit=10){
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new Error("telnyx_number_order_reconciliation_limit_invalid");
  const staleSubmitting=new Date(now.getTime()-5*60_000).toISOString();
  const due=await env.PLATFORM_DB.prepare(`SELECT o.*,i.id AS identity_record_id,i.tenant_id AS tenant_id,i.space_id AS space_id,i.project_id AS project_id,
      i.scope_key,i.owner_user_id,i.email_address,i.address_hash,i.email_provider,i.email_status,i.autonomy_json,i.status AS identity_status,
      b.payer AS binding_payer,b.provider_number_sid AS binding_provider_number_sid,b.phone_number AS binding_phone_number,b.status AS binding_status
    FROM assistant_telnyx_number_order_operations o
    JOIN assistant_communication_identities i ON i.id=o.identity_id
    JOIN assistant_phone_bindings b ON b.id=o.binding_id AND b.identity_id=o.identity_id
    JOIN spaces s ON s.id=i.space_id AND s.tenant_id=i.tenant_id AND s.status='active'
    JOIN orgs g ON g.id=i.tenant_id AND g.status='active'
    WHERE o.status IN ('submitting','uncertain','pending') AND (o.lease_until IS NULL OR julianday(o.lease_until)<=julianday(?))
      AND ((o.next_reconcile_at IS NOT NULL AND julianday(o.next_reconcile_at)<=julianday(?))
        OR (o.status='submitting' AND julianday(o.updated_at)<=julianday(?)))
      AND i.status='active' AND i.email_status!='erased'
    ORDER BY COALESCE(o.next_reconcile_at,o.updated_at),o.created_at LIMIT ?`)
    .bind(now.toISOString(),now.toISOString(),staleSubmitting,limit).all<TelnyxNumberOrderReconciliationRow>();
  const result={checked:due.results.length,reconciled:0,deferred:0,failed:0};
  for(const row of due.results){
    const claim=await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_order_operations SET lease_until=?,updated_at=?
      WHERE id=? AND identity_id=? AND status IN ('submitting','uncertain','pending')
        AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?))
        AND ((next_reconcile_at IS NOT NULL AND julianday(next_reconcile_at)<=julianday(?))
          OR (status='submitting' AND julianday(updated_at)<=julianday(?)))`)
      .bind(new Date(now.getTime()+120_000).toISOString(),now.toISOString(),row.id,row.identity_id,now.toISOString(),now.toISOString(),staleSubmitting).run();
    if(!claim.meta.changes){result.deferred++;continue;}
    try{
      if(!row.owner_user_id||row.binding_payer!=="byo"||!row.binding_phone_number
        ||!(["configuring","indeterminate"].includes(row.binding_status))||row.identity_status!=="active"){
        await deferTelnyxNumberOrderReconciliation(env,row,"telnyx_number_order_scope_unavailable",now);result.deferred++;continue;
      }
      const identity:CommunicationIdentity={id:row.identity_record_id,tenant_id:row.tenant_id,space_id:row.space_id,project_id:row.project_id??null,
        scope_key:row.scope_key,owner_user_id:row.owner_user_id,email_address:row.email_address??null,address_hash:row.address_hash??null,
        email_provider:row.email_provider,email_status:row.email_status,status:row.identity_status,autonomy_json:row.autonomy_json};
      const {resolveTelnyxAccount}=await import("./telnyx-account.js");
      const account=await resolveTelnyxAccount(env,identity,{payer:"byo",provider_number_sid:row.binding_provider_number_sid,phone_number:row.binding_phone_number});
      if(!account||String(account.verifiedNumberId)!==row.provider_account_ref){
        await deferTelnyxNumberOrderReconciliation(env,row,"telnyx_account_changed_since_order",now);result.deferred++;continue;
      }
      const client=new (await import("../voice/telnyx-telephony.js")).TelnyxTelephony(account);
      let matches:Record<string,unknown>[]=[];
      if(row.provider_order_id&&isTelnyxOrderId(row.provider_order_id)){
        try{const exact=await client.inspectNumberOrder(row.provider_order_id);if(exact.customer_reference===row.customer_reference)matches=[exact];}
        catch{/* A read-only reference search below recovers absent or temporarily unavailable order IDs. */}
      }
      if(!matches.length)matches=(await client.listNumberOrders(row.customer_reference)).filter(order=>order.customer_reference===row.customer_reference);
      if(matches.length!==1){
        if(matches.length>1){
          await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_order_operations SET lease_until=NULL,next_reconcile_at=NULL,
            last_error='duplicate_provider_orders_require_manual_review',last_reconciled_at=?,updated_at=? WHERE id=? AND identity_id=?`)
            .bind(now.toISOString(),now.toISOString(),row.id,row.identity_id).run();
          result.deferred++;continue;
        }
        await deferTelnyxNumberOrderReconciliation(env,row,"telnyx_number_order_not_yet_visible",now);result.deferred++;continue;
      }
      const outcome=await reconcileTelnyxNumberOrder(env,identity,client,row,matches[0]!);
      if(outcome.status==="pending")result.deferred++;else result.reconciled++;
    }catch(error){
      const code=error instanceof Error&&/^[a-z0-9_:-]{1,100}$/.test(error.message)?error.message:"telnyx_number_order_reconciliation_failed";
      await deferTelnyxNumberOrderReconciliation(env,row,code,now).catch(()=>undefined);result.failed++;
    }
  }
  return result;
}

type TelnyxNumberReleaseOperation = {
  id: string; identity_id: string; binding_id: string; provider_account_fingerprint: string;
  provider_number_id: string; phone_number: string; prior_binding_status: "active" | "billing_hold" | "indeterminate";
  status: "submitting" | "uncertain" | "released" | "failed"; reconcile_attempts: number;
  next_reconcile_at: string | null; lease_until: string | null; last_error: string | null;
};
function sha256Hex(bytes: Uint8Array) {
  return crypto.subtle.digest("SHA-256", bytes).then(digest => [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join(""));
}
async function telnyxAccountFingerprint(env: AgentsEnv, account: { apiKey: string; publicKey: string }) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.PLATFORM_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${account.apiKey}\0${account.publicKey}`));
  return [...new Uint8Array(signature)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
function boundedPhoneError(error: unknown, fallback: string) {
  return error instanceof Error && /^[a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : fallback;
}
async function finishTelnyxNumberRelease(env: AgentsEnv, operation: TelnyxNumberReleaseOperation, now: Date) {
  const at = now.toISOString();
  const result = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_release_operations SET status='released',next_reconcile_at=NULL,
      lease_until=NULL,last_error=NULL,last_reconciled_at=?,updated_at=? WHERE id=? AND status IN ('submitting','uncertain')`)
      .bind(at,at,operation.id),
    env.PLATFORM_DB.prepare(`UPDATE assistant_phone_bindings SET status='released',updated_at=? WHERE id=? AND identity_id=?
      AND provider='telnyx' AND payer='managed' AND provider_number_sid=? AND phone_number=? AND status IN ('disabling','indeterminate','released')`)
      .bind(at,operation.binding_id,operation.identity_id,operation.provider_number_id,operation.phone_number),
  ]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) throw new Error("managed_telnyx_release_receipt_unconfirmed");
  return { operation_id: operation.id, status: "released", released: true, carrier_number_released: true, current_month_rental_refundable: false };
}
async function deferTelnyxNumberRelease(env: AgentsEnv, operation: TelnyxNumberReleaseOperation, errorCode: string, now: Date) {
  const attempts=(operation.reconcile_attempts??0)+1;
  const delay=Math.min(6*60*60_000,5*60_000*2**Math.min(attempts-1,6));
  const next=new Date(now.getTime()+delay).toISOString();
  await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_release_operations SET status='uncertain',lease_until=NULL,last_error=?,
    reconcile_attempts=?,next_reconcile_at=?,last_reconciled_at=?,updated_at=? WHERE id=? AND status IN ('submitting','uncertain')`)
    .bind(errorCode,attempts,next,now.toISOString(),now.toISOString(),operation.id).run();
  await env.PLATFORM_DB.prepare(`UPDATE assistant_phone_bindings SET status='indeterminate',updated_at=? WHERE id=? AND identity_id=?
    AND provider='telnyx' AND payer='managed' AND provider_number_sid=? AND status IN ('disabling','indeterminate')`)
    .bind(now.toISOString(),operation.binding_id,operation.identity_id,operation.provider_number_id).run();
  return { operation_id: operation.id, status: "uncertain", released: false, reconciliation_scheduled: true, reason: errorCode };
}

/** Bounded read-only release reconciliation. DELETE is issued only by the owner action below;
 * a worker retry checks the exact Telnyx number and confirms absence without replaying DELETE. */
export async function sweepTelnyxNumberReleases(env: AgentsEnv, now = new Date(), limit = 10) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new Error("telnyx_number_release_reconciliation_limit_invalid");
  const staleSubmitting=new Date(now.getTime()-5*60_000).toISOString();
  const due=await env.PLATFORM_DB.prepare(`SELECT o.*,i.id AS identity_record_id,i.tenant_id,i.space_id,i.project_id,i.scope_key,
      i.owner_user_id,i.email_address,i.address_hash,i.email_provider,i.email_status,i.autonomy_json,i.status AS identity_status,
      b.payer AS binding_payer,b.provider_number_sid AS binding_provider_number_sid,b.phone_number AS binding_phone_number,b.status AS binding_status
    FROM assistant_telnyx_number_release_operations o JOIN assistant_communication_identities i ON i.id=o.identity_id
    JOIN assistant_phone_bindings b ON b.id=o.binding_id AND b.identity_id=o.identity_id
    WHERE o.status IN ('submitting','uncertain') AND (o.lease_until IS NULL OR julianday(o.lease_until)<=julianday(?))
      AND ((o.next_reconcile_at IS NOT NULL AND julianday(o.next_reconcile_at)<=julianday(?))
        OR (o.status='submitting' AND julianday(o.updated_at)<=julianday(?)))
    ORDER BY COALESCE(o.next_reconcile_at,o.updated_at),o.created_at LIMIT ?`)
    .bind(now.toISOString(),now.toISOString(),staleSubmitting,limit).all<Record<string,unknown>&TelnyxNumberReleaseOperation>();
  const result={checked:due.results.length,released:0,deferred:0,failed:0};
  for(const row of due.results){
    const claim=await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_release_operations SET lease_until=?,updated_at=?
      WHERE id=? AND status IN ('submitting','uncertain') AND (lease_until IS NULL OR julianday(lease_until)<=julianday(?))
        AND ((next_reconcile_at IS NOT NULL AND julianday(next_reconcile_at)<=julianday(?))
          OR (status='submitting' AND julianday(updated_at)<=julianday(?)))`)
      .bind(new Date(now.getTime()+120_000).toISOString(),now.toISOString(),row.id,now.toISOString(),now.toISOString(),staleSubmitting).run();
    if(!claim.meta.changes){result.deferred++;continue;}
    try{
      if(row.binding_payer!=="managed"||row.binding_provider_number_sid!==row.provider_number_id||row.binding_phone_number!==row.phone_number
        ||!(row.binding_status==="disabling"||row.binding_status==="indeterminate")){
        await deferTelnyxNumberRelease(env,row,"telnyx_release_scope_unavailable",now);result.deferred++;continue;
      }
      const identity:CommunicationIdentity={id:String(row.identity_record_id),tenant_id:String(row.tenant_id),space_id:String(row.space_id),
        project_id:typeof row.project_id==="string"?row.project_id:null,scope_key:String(row.scope_key),owner_user_id:String(row.owner_user_id),
        email_address:typeof row.email_address==="string"?row.email_address:null,address_hash:typeof row.address_hash==="string"?row.address_hash:null,
        email_provider:String(row.email_provider),email_status:String(row.email_status),status:String(row.identity_status),autonomy_json:String(row.autonomy_json)};
      const account=await (await import("./telnyx-account.js")).resolveTelnyxAccount(env,identity,{payer:"managed",provider_number_sid:row.provider_number_id,phone_number:row.phone_number});
      if(!account||await telnyxAccountFingerprint(env,account)!==row.provider_account_fingerprint){
        await deferTelnyxNumberRelease(env,row,"telnyx_managed_account_changed_since_release",now);result.deferred++;continue;
      }
      const client=new (await import("../voice/telnyx-telephony.js")).TelnyxTelephony(account);
      const current=await client.inspectPhoneNumberForRelease(row.provider_number_id);
      if(!current){await finishTelnyxNumberRelease(env,row,now);result.released++;continue;}
      if(current.phoneNumber!==row.phone_number){await deferTelnyxNumberRelease(env,row,"telnyx_release_resource_mismatch",now);result.deferred++;continue;}
      await deferTelnyxNumberRelease(env,row,"telnyx_number_still_present_after_release",now);result.deferred++;
    }catch(error){
      await deferTelnyxNumberRelease(env,row,boundedPhoneError(error,"telnyx_number_release_reconciliation_failed"),now).catch(()=>undefined);
      result.failed++;
    }
  }
  return result;
}

async function releaseManagedTelnyxNumber(env: AgentsEnv, identity: CommunicationIdentity, binding: AssistantPhoneBinding) {
  const existing=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_telnyx_number_release_operations WHERE binding_id=?
    AND status IN ('submitting','uncertain','released') ORDER BY created_at DESC LIMIT 1`).bind(binding.id).first<TelnyxNumberReleaseOperation>();
  if(existing){
    if(existing.status==="released")return {operation_id:existing.id,status:"released",released:true,carrier_number_released:true,current_month_rental_refundable:false};
    return {operation_id:existing.id,status:"uncertain",released:false,reconciliation_scheduled:true,reason:existing.last_error??"release_reconciliation_pending"};
  }
  const account=await (await import("./telnyx-account.js")).resolveTelnyxAccount(env,identity,binding);
  if(!account)throw new Error("managed_telnyx_credentials_unavailable");
  if(!binding.provider_number_sid||!binding.phone_number||!/^\d{1,32}$/.test(binding.provider_number_sid))throw new Error("telnyx_release_resource_invalid");
  const at=new Date().toISOString(),operationId=`tnrel_${crypto.randomUUID().replace(/-/g,"")}`;
  const statements=await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`INSERT INTO assistant_telnyx_number_release_operations(id,identity_id,binding_id,provider_account_fingerprint,
      provider_number_id,phone_number,prior_binding_status,status,next_reconcile_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?, ?,?,? WHERE EXISTS(SELECT 1 FROM assistant_phone_bindings WHERE id=? AND identity_id=?
        AND provider='telnyx' AND payer='managed' AND provider_number_sid=? AND phone_number=? AND status=?)`)
      .bind(operationId,identity.id,binding.id,await telnyxAccountFingerprint(env,account),binding.provider_number_sid,binding.phone_number,binding.status,
        binding.status==="active"?"submitting":"uncertain",binding.status==="active"?null:at,at,at,binding.id,identity.id,binding.provider_number_sid,binding.phone_number,binding.status),
    env.PLATFORM_DB.prepare(`UPDATE assistant_phone_bindings SET status=?,updated_at=? WHERE id=? AND identity_id=?
      AND provider='telnyx' AND payer='managed' AND provider_number_sid=? AND phone_number=? AND status=?
      AND EXISTS(SELECT 1 FROM assistant_telnyx_number_release_operations WHERE id=? AND binding_id=?)`)
      .bind(binding.status==="active"?"disabling":"indeterminate",at,binding.id,identity.id,binding.provider_number_sid,binding.phone_number,binding.status,operationId,binding.id),
    env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_release_operations SET status='failed',last_error='binding_changed_before_release',updated_at=?
      WHERE id=? AND status IN ('submitting','uncertain') AND NOT EXISTS(SELECT 1 FROM assistant_phone_bindings WHERE id=? AND status IN ('disabling','indeterminate'))`)
      .bind(at,operationId,binding.id),
  ]);
  if(statements[0]?.meta.changes!==1||statements[1]?.meta.changes!==1){
    const raced=await env.PLATFORM_DB.prepare(`SELECT * FROM assistant_telnyx_number_release_operations WHERE binding_id=? AND status IN ('submitting','uncertain','released') ORDER BY created_at DESC LIMIT 1`)
      .bind(binding.id).first<TelnyxNumberReleaseOperation>();
    if(raced)return {operation_id:raced.id,status:raced.status==="released"?"released":"uncertain",released:raced.status==="released",reconciliation_scheduled:raced.status!=="released",reason:raced.last_error??"release_reconciliation_pending"};
    throw new Error("telnyx_binding_changed");
  }
  const operation:TelnyxNumberReleaseOperation={id:operationId,identity_id:identity.id,binding_id:binding.id,
    provider_account_fingerprint:await telnyxAccountFingerprint(env,account),provider_number_id:binding.provider_number_sid,phone_number:binding.phone_number,
    prior_binding_status:binding.status as TelnyxNumberReleaseOperation["prior_binding_status"],status:binding.status==="active"?"submitting":"uncertain",reconcile_attempts:0,
    next_reconcile_at:binding.status==="active"?null:at,lease_until:null,last_error:binding.status==="active"?null:"preexisting_binding_state_requires_read_only_reconciliation"};
  if(operation.status==="uncertain"){
    return deferTelnyxNumberRelease(env,operation,operation.last_error!,new Date());
  }
  try{
    await new (await import("../voice/telnyx-telephony.js")).TelnyxTelephony(account).releasePhoneNumber(binding.provider_number_sid);
  }catch(error){
    if(error instanceof PhoneProviderError&&error.uncertain){
      return deferTelnyxNumberRelease(env,operation,boundedPhoneError(error,"telnyx_provider_outcome_unknown"),new Date());
    }
    const failedAt=new Date().toISOString();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_release_operations SET status='failed',last_error=?,next_reconcile_at=NULL,updated_at=? WHERE id=? AND status='submitting'`)
        .bind(boundedPhoneError(error,"telnyx_release_rejected"),failedAt,operationId),
      env.PLATFORM_DB.prepare(`UPDATE assistant_phone_bindings SET status=?,updated_at=? WHERE id=? AND identity_id=? AND status='disabling'`)
        .bind(binding.status,failedAt,binding.id,identity.id),
    ]);
    throw error;
  }
  const completed=await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_number_release_operations SET status='released',last_error=NULL,next_reconcile_at=NULL,updated_at=?
      WHERE id=? AND status='submitting'`).bind(new Date().toISOString(),operationId),
    env.PLATFORM_DB.prepare(`UPDATE assistant_phone_bindings SET status='released',updated_at=? WHERE id=? AND identity_id=?
      AND provider='telnyx' AND payer='managed' AND provider_number_sid=? AND phone_number=? AND status='disabling'`)
      .bind(new Date().toISOString(),binding.id,identity.id,binding.provider_number_sid,binding.phone_number),
  ]);
  if(completed[0]?.meta.changes!==1||completed[1]?.meta.changes!==1)throw new Error("managed_telnyx_release_receipt_unconfirmed");
  return {operation_id:operationId,status:"released",released:true,carrier_number_released:true,current_month_rental_refundable:false};
}

async function livePhoneAllowed(env: AgentsEnv, scope: CommunicationScope) {
  if (
    !(await scopeAccess(env, scope, false)) ||
    !(await channelPreferences(env, scope)).enabled.phone ||
    (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId))
  )
    throw new Error("assistant_phone_disabled_or_forbidden");
}
async function extensionPhoneSetupAllowed(env: AgentsEnv, scope: CommunicationScope) {
  if (
    !(await scopeAccess(env, scope, false)) ||
    (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId))
  )
    throw new Error("phone_extension_disabled_or_forbidden");
}
function metadata(binding: AssistantPhoneBinding | null) {
  if (!binding) return null;
  return {
    id: binding.id,
    provider: binding.provider ?? "twilio",
    provider_number_id: binding.provider_number_sid,
    phone_number: binding.phone_number,
    status: binding.status,
    payer: binding.payer,
    capabilities: JSON.parse(binding.capabilities_json),
    policy: JSON.parse(binding.policy_json),
    monthly_cost_minor: binding.monthly_cost_minor,
    currency: "USD",
  };
}

function maskedPhoneCaller(caller: string): string | null {
  const digits = caller.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : null;
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
    const currentPhone = await assistantPhone(env, identity.id);
    const carrierRates = (await import("./managed-carrier-billing.js")).managedTelnyxRateSchedule(env);
    const bindingRates = currentPhone?.payer === "managed" && currentPhone.managed_price_version
      && Number.isSafeInteger(currentPhone.managed_rental_credits_per_month) && Number(currentPhone.managed_rental_credits_per_month) > 0
      && Number.isSafeInteger(currentPhone.managed_sms_credits_per_segment) && Number(currentPhone.managed_sms_credits_per_segment) > 0
      && Number.isSafeInteger(currentPhone.managed_call_credits_per_minute) && Number(currentPhone.managed_call_credits_per_minute) > 0
      ? { rental_credits_per_month: currentPhone.managed_rental_credits_per_month,
          sms_credits_per_segment: currentPhone.managed_sms_credits_per_segment,
          call_credits_per_minute: currentPhone.managed_call_credits_per_minute }
      : null;
    const telnyxOrder = await env.PLATFORM_DB.prepare("SELECT id,status,phone_number,upfront_cost_minor,monthly_cost_minor,currency,provider_order_id FROM assistant_telnyx_number_order_operations WHERE identity_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .bind(identity.id).first<{ id: string; status: string; phone_number: string; upfront_cost_minor: number; monthly_cost_minor: number; currency: string; provider_order_id: string | null }>();
    const telnyxRelease = await env.PLATFORM_DB.prepare("SELECT id,status,phone_number,next_reconcile_at,last_error FROM assistant_telnyx_number_release_operations WHERE identity_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .bind(identity.id).first<{ id:string;status:string;phone_number:string;next_reconcile_at:string|null;last_error:string|null }>();
    const phoneHandlerCandidates = manager ? await listPhoneHandlerCandidates(env, scope) : [];
    const recentExtensionCallRows = manager
      ? (await env.PLATFORM_DB.prepare(`SELECT c.call_control_id,c.binding_id,c.extension_installation_id,c.handler_sha256,
          c.caller,c.state,c.turn_count,c.started_at,c.duration_seconds
          FROM assistant_telnyx_extension_calls c JOIN assistant_phone_bindings b ON b.id=c.binding_id
          WHERE b.identity_id=? AND b.purpose='extension' AND c.started_at>=?
          ORDER BY c.started_at DESC,c.call_control_id DESC LIMIT 50`)
          .bind(identity.id, Math.floor(Date.now() / 1000) - 7 * 86_400)
          .all<{ call_control_id:string;binding_id:string;extension_installation_id:string|null;handler_sha256:string|null;
            caller:string;state:string;turn_count:number;started_at:number;duration_seconds:number|null }>())
          .results
      : [];
    const recentTwilioExtensionCalls = manager
      ? (await env.PLATFORM_DB.prepare(`SELECT e.binding_id,e.extension_installation_id,e.handler_sha256,e.sender,e.status,
          CAST(strftime('%s',e.created_at) AS INTEGER) AS started_at,e.duration_seconds
          FROM assistant_phone_events e JOIN assistant_phone_bindings b ON b.id=e.binding_id
          WHERE b.identity_id=? AND b.purpose='extension' AND COALESCE(b.provider,'twilio')='twilio'
            AND e.kind='call' AND e.created_at>=datetime('now','-7 days')
          ORDER BY e.created_at DESC,e.id DESC LIMIT 50`)
          .bind(identity.id)
          .all<{ binding_id:string;extension_installation_id:string|null;handler_sha256:string|null;sender:string;status:string;
            started_at:number|null;duration_seconds:number|null }>())
          .results
      : [];
    const extensionCallCosts = await extensionCallCostSummaries(env, recentExtensionCallRows);
    const recentExtensionCalls = recentExtensionCallRows.map(row => ({
      binding_id: row.binding_id,
      installation_id: row.extension_installation_id,
      handler_sha256: row.handler_sha256,
      state: row.state, turn_count: row.turn_count, started_at: row.started_at,
      duration_seconds: row.duration_seconds, caller_hint: maskedPhoneCaller(row.caller),
      cost_report: extensionCallCosts.get(`${row.binding_id}\0${row.call_control_id}`)
        ?? { status: "not_linked" as const, provider_cost_micros: null, currency: null, leg_count: null },
    }));
    const agentPortShare = currentPhone?.provider === "telnyx" ? await env.PLATFORM_DB.prepare(`SELECT m.agentport_link_status,
        (SELECT o.operation_name FROM managed_service_operations o WHERE o.account_id=m.id AND o.operation_name IN ('agentport_sync','agentport_revoke')
          ORDER BY o.updated_at DESC LIMIT 1) AS operation_name,
        (SELECT o.status FROM managed_service_operations o WHERE o.account_id=m.id AND o.operation_name IN ('agentport_sync','agentport_revoke')
          ORDER BY o.updated_at DESC LIMIT 1) AS operation_status,
        (SELECT o.error_code FROM managed_service_operations o WHERE o.account_id=m.id AND o.operation_name IN ('agentport_sync','agentport_revoke')
          ORDER BY o.updated_at DESC LIMIT 1) AS operation_error
      FROM managed_service_accounts m WHERE m.id='telnyx-'||? AND m.tenant_id=? AND m.space_id=?`).bind(currentPhone.id,scope.tenantId,scope.spaceId)
      .first<{agentport_link_status:string|null;operation_name:string|null;operation_status:string|null;operation_error:string|null}>() : null;
    let telnyxWebhook: string | null = null;
    if (manager && currentPhone?.provider === "telnyx" && currentPhone.status === "configuring") {
      try { telnyxWebhook = currentPhone.payer === "managed"
        ? `${phonePublicOrigin(env)}/assistant-phone/telnyx-managed`
        : `${phonePublicOrigin(env)}/assistant-phone/telnyx/${encodeURIComponent(currentPhone.id)}`; } catch { /* Not configured. */ }
    }
    return {
      phone: metadata(currentPhone),
      telnyx_agentport_shared: agentPortShare?.agentport_link_status === "active",
      telnyx_agentport_link_status: agentPortShare?.agentport_link_status ?? null,
      telnyx_agentport_operation: agentPortShare?.operation_name ? { operation_name:agentPortShare.operation_name,
        status:agentPortShare.operation_status,error_code:agentPortShare.operation_error } : null,
      telnyx_order: telnyxOrder ? { operation_id: telnyxOrder.id, status: telnyxOrder.status, phone_number: telnyxOrder.phone_number,
        upfront_cost_minor: telnyxOrder.upfront_cost_minor, monthly_cost_minor: telnyxOrder.monthly_cost_minor,
        currency: telnyxOrder.currency, provider_order_id: telnyxOrder.provider_order_id } : null,
      telnyx_release: telnyxRelease ? { operation_id:telnyxRelease.id,status:telnyxRelease.status,phone_number:telnyxRelease.phone_number,
        next_reconcile_at:telnyxRelease.next_reconcile_at,error_code:telnyxRelease.last_error } : null,
      telnyx_webhook_url: telnyxWebhook,
      extension_lines: manager
        ? (
            await env.PLATFORM_DB.prepare(
              "SELECT b.id,b.provider,b.phone_number,b.provider_number_sid,b.status,b.policy_json,h.installation_id,h.handler_sha256,h.status AS handler_status FROM assistant_phone_bindings b LEFT JOIN assistant_phone_extension_handlers h ON h.binding_id=b.id WHERE b.identity_id=? AND b.purpose='extension' AND b.status NOT IN ('detached','released')"
            )
              .bind(identity.id)
              .all<{ id: string; provider: "twilio" | "telnyx"; phone_number: string | null; provider_number_sid: string | null; status: string; policy_json: string; installation_id: string | null; handler_sha256: string | null; handler_status: string | null }>()
          ).results.map(({ policy_json, ...line }) => {
            let speechInputAllowed = false;
            try { speechInputAllowed = line.provider === "twilio" && validatePhonePolicy(JSON.parse(policy_json)).allowSpeechInput === true; }
            catch { /* Invalid policy remains disabled in the read-only dashboard. */ }
            return { ...line, speech_input_allowed: speechInputAllowed };
          })
        : [],
      phone_handler_candidates: phoneHandlerCandidates,
      recent_telnyx_extension_calls: recentExtensionCalls,
      recent_twilio_extension_calls: recentTwilioExtensionCalls.map(row => ({
        binding_id: row.binding_id,
        installation_id: row.extension_installation_id,
        handler_sha256: row.handler_sha256,
        state: row.status,
        started_at: Number.isSafeInteger(row.started_at) ? row.started_at : null,
        duration_seconds: Number.isSafeInteger(row.duration_seconds) ? row.duration_seconds : null,
        caller_hint: maskedPhoneCaller(row.sender),
      })),
      legacy_numbers: manager
        ? (
            await env.PLATFORM_DB.prepare(
              `SELECT l.id,l.phone_number,l.provider_number_sid,l.status
                 FROM customer_voice_number_bindings l
                WHERE l.tenant_id=? AND l.space_id=? AND l.status='active'
                  AND NOT EXISTS (SELECT 1 FROM assistant_phone_bindings b WHERE b.provider_number_sid=l.provider_number_sid AND b.status NOT IN ('released','detached'))
                ORDER BY l.created_at,l.id`
            ).bind(scope.tenantId, scope.spaceId).all()
          ).results
        : [],
      enabled: preferences.enabled.phone,
      managed_available: Boolean(env.TELNYX_MANAGED_ENABLED === "true" && env.TELNYX_MANAGED_API_KEY && env.TELNYX_MANAGED_PUBLIC_KEY
        && env.TELNYX_MANAGED_MESSAGING_PROFILE_ID && env.TELNYX_MANAGED_CALL_CONTROL_ID && carrierRates && env.BILLING_WORKER),
      managed_price_version: currentPhone?.payer === "managed" ? currentPhone.managed_price_version : carrierRates?.priceVersion ?? null,
      managed_rates: currentPhone?.payer === "managed"
        ? bindingRates
        : carrierRates ? { rental_credits_per_month: carrierRates.rentalCreditsPerMonth,
            sms_credits_per_segment: carrierRates.smsCreditsPerSegment,
            call_credits_per_minute: carrierRates.callCreditsPerMinute } : null,
      managed_reason: env.TELNYX_MANAGED_ENABLED !== "true"
        ? "Managed Telnyx rollout is disabled."
        : "Managed Telnyx inventory requires Naelao carrier credentials and a versioned, operator-approved rate schedule.",
      authority:
        "Phone numbers and caller IDs do not authenticate task commands.",
      billing:
        `BYO ${currentPhone?.provider === "telnyx" ? "Telnyx" : "Twilio"} bills your carrier account directly; rental, calls, messages, taxes and regulatory charges are separate.`,
    };
  }
  const extensionSetup = action === "phone-handler" || action === "phone-handler-test" ||
    (action === "phone-import" && typeof body.legacy_binding_id === "string" && body.legacy_binding_id.length > 0);
  if (
    ![
      "phone-live",
      "phone-live-end",
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
      "phone-telnyx-remove",
      "phone-telnyx-status",
      "phone-agentport-unlink",
      "phone-telnyx-cancel",
      "phone-telnyx-detach",
      "phone-telnyx-reconcile",
      "phone-telnyx-order-reconcile",
      "phone-telnyx-cost",
      "phone-twilio-cost",
    ].includes(action)
  ) {
    if (extensionSetup) await extensionPhoneSetupAllowed(env, scope);
    else await livePhoneAllowed(env, scope);
  }
  let binding = await assistantPhone(env, identity.id);
  if (action === "phone-telnyx-cost-status") {
    if (!manager || agent || !binding || binding.provider !== "telnyx" || binding.status !== "active")
      throw new Error("telnyx_call_cost_status_owner_required");
    const account = await (await import("./telnyx-account.js")).resolveTelnyxAccount(env, identity, binding);
    if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number
      || !account.callControlId) throw new Error("telnyx_call_cost_application_unavailable");
    const client = new (await import("../voice/telnyx-telephony.js")).TelnyxTelephony(account);
    const [number, app] = await Promise.all([
      client.inspectPhoneNumber(account.verifiedNumberId), client.inspectCallControlApplication(account.callControlId),
    ]);
    const expected = binding.payer === "managed"
      ? `${phonePublicOrigin(env)}/assistant-phone/telnyx-managed`
      : `${phonePublicOrigin(env)}/assistant-phone/telnyx/${encodeURIComponent(binding.id)}`;
    if (number.callControlId !== account.callControlId || app.webhookUrl !== expected)
      throw new Error("telnyx_call_cost_application_mismatch");
    const capabilities = JSON.parse(binding.capabilities_json) as Record<string, unknown>;
    capabilities.call_cost_webhooks = app.callCostInWebhooks;
    const changed = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET capabilities_json=?,updated_at=datetime('now') WHERE id=? AND identity_id=? AND status='active'")
      .bind(JSON.stringify(capabilities), binding.id, identity.id).run();
    if (!changed.meta.changes) throw new Error("telnyx_binding_changed");
    return { call_cost_webhooks_enabled: app.callCostInWebhooks };
  }
  if (action === "phone-agentport-share" || action === "phone-agentport-unlink") {
    if (!manager || agent || body.confirm !== true || !binding || binding.provider !== "telnyx" || binding.status !== "active")
      throw new Error("telnyx_agentport_owner_confirmation_required");
    if (action === "phone-agentport-share")
      return (await import("./telnyx-agentport.js")).shareTelnyxSmsWithAgentPort(env, scope, identity, binding.id);
    return (await import("./telnyx-agentport.js")).revokeTelnyxAgentPortShare(env, scope, identity, binding.id);
  }
  if (action === "phone-telnyx-activate") {
    if (body.confirm !== true || !binding || binding.provider !== "telnyx" || binding.status !== "configuring") throw new Error("telnyx_staged_binding_required");
    const account = await (await import("./telnyx-account.js")).resolveTelnyxAccount(env, identity, binding);
    if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number) throw new Error("telnyx_binding_mismatch");
    const client = new (await import("../voice/telnyx-telephony.js")).TelnyxTelephony(account);
    const number = await client.inspectPhoneNumber(account.verifiedNumberId);
    if (number.phoneNumber !== account.verifiedPhoneNumber || !number.messagingProfileId) throw new Error("telnyx_messaging_profile_required");
    const profile = await client.inspectMessagingProfile(number.messagingProfileId);
    const expected = binding.payer === "managed"
      ? `${phonePublicOrigin(env)}/assistant-phone/telnyx-managed`
      : `${phonePublicOrigin(env)}/assistant-phone/telnyx/${encodeURIComponent(binding.id)}`;
    if (profile.webhookUrl !== expected) throw new Error("telnyx_webhook_not_configured");
    let voiceActive = false;
    let voiceCostWebhooksEnabled = false;
    if (account.callControlId && number.callControlId === account.callControlId) {
      const app = await client.inspectCallControlApplication(account.callControlId);
      if (app.webhookUrl !== expected) throw new Error("telnyx_call_webhook_not_configured");
      voiceCostWebhooksEnabled = app.callCostInWebhooks;
      voiceActive = true;
    }
    if (binding.payer === "managed" && (!voiceActive || !binding.managed_price_version
      || !binding.managed_rental_credits_per_month || !binding.managed_sms_credits_per_segment || !binding.managed_call_credits_per_minute))
      throw new Error("managed_telnyx_rate_agreement_required");
    if (binding.payer === "managed") {
      const rental = await (await import("./managed-carrier-billing.js")).billManagedTelnyxRental(env, binding, identity);
      if (!rental.billed) throw new Error("managed_telnyx_rental_billing_pending");
    }
    await livePhoneAllowed(env, scope);
    const updated = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='active',capabilities_json=?,updated_at=datetime('now') WHERE id=? AND identity_id=? AND provider='telnyx' AND status='configuring'")
      .bind(JSON.stringify({ sms: true, voice: voiceActive, mms: false, call_cost_webhooks: voiceCostWebhooksEnabled }), binding.id, identity.id).run();
    if (!updated.meta.changes) throw new Error("telnyx_staged_binding_changed");
    return { phone: metadata(await assistantPhone(env, identity.id)), sms_active: true, voice_active: voiceActive,
      voice_cost_webhooks_enabled: voiceCostWebhooksEnabled };
  }
  if (action === "phone-telnyx-detach") {
    if (body.confirm !== true || !binding || binding.provider !== "telnyx" || !["active", "billing_hold", "indeterminate"].includes(binding.status)
      || (binding.status !== "active" && body.provider_checked !== true)) throw new Error("telnyx_active_binding_required");
    if (await env.PLATFORM_DB.prepare("SELECT id FROM assistant_phone_actions WHERE binding_id=? AND status IN ('sending','indeterminate') LIMIT 1").bind(binding.id).first()) throw new Error("phone_reconciliation_required_before_detach");
    if (await env.PLATFORM_DB.prepare("SELECT event_id FROM assistant_telnyx_ingress_receipts WHERE binding_id=? AND state IN ('claimed','indeterminate') LIMIT 1").bind(binding.id).first()) throw new Error("phone_ingress_reconciliation_required_before_detach");
    if (binding.payer === "managed") {
      if (await env.PLATFORM_DB.prepare("SELECT id FROM assistant_live_calls WHERE binding_id=? AND status IN ('armed','connected') LIMIT 1").bind(binding.id).first()) throw new Error("end_live_calls_before_release");
      if (await env.PLATFORM_DB.prepare("SELECT action_id FROM assistant_telnyx_cost_polls p JOIN assistant_phone_actions a ON a.id=p.action_id WHERE a.binding_id=? AND p.status IN ('pending','running','held') LIMIT 1").bind(binding.id).first()) throw new Error("carrier_cost_reconciliation_required_before_release");
      if (await env.PLATFORM_DB.prepare("SELECT provider_message_id FROM assistant_managed_telnyx_message_costs WHERE binding_id=? AND status IN ('pending','running','held') LIMIT 1").bind(binding.id).first()) throw new Error("carrier_cost_reconciliation_required_before_release");
      if (await env.PLATFORM_DB.prepare("SELECT live_call_id FROM assistant_telnyx_live_calls WHERE binding_id=? AND state='ended' AND settled_credits IS NULL LIMIT 1").bind(binding.id).first()) throw new Error("carrier_call_reconciliation_required_before_release");
      await (await import("./telnyx-agentport.js")).revokeTelnyxAgentPortShare(env, scope, identity, binding.id);
      return releaseManagedTelnyxNumber(env,identity,binding);
    }
    await (await import("./telnyx-agentport.js")).revokeTelnyxAgentPortShare(env, scope, identity, binding.id);
    const updated = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='detached',updated_at=datetime('now') WHERE id=? AND identity_id=? AND provider='telnyx' AND status='active'")
      .bind(binding.id, identity.id).run();
    if (!updated.meta.changes) throw new Error("telnyx_binding_changed");
    return { detached: true, rental_continues: true, webhook_unchanged: true };
  }
  if (action === "phone-draft" && binding?.provider === "telnyx") {
    const recipient = String(body.to ?? ""), text = String(body.text ?? "");
    if (binding.status !== "active" || body.kind !== "sms" || !isE164(recipient) || !text.trim() || text.length > 1600 || body.media !== undefined || body.dtmf) throw new Error("telnyx_sms_draft_invalid");
    const id = `pa_${String(Date.now()).padStart(13, "0")}_${crypto.randomUUID()}`;
    const key = await storeBody(env, identity, id, { text, dtmf: "" });
    const managed = binding.payer === "managed";
    const terms = managed ? await import("./managed-carrier-billing.js") : null;
    const priceVersion = managed ? binding.managed_price_version : null;
    const reservedCredits = managed
      ? terms!.managedSmsCreditsPerSegment(env, binding) * terms!.managedSmsSegments(text)
      : null;
    if (reservedCredits !== null && (!Number.isSafeInteger(reservedCredits) || reservedCredits > 10_000_000)) throw new Error("managed_telnyx_sms_quote_invalid");
    await env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key,managed_price_version,managed_reserved_credits) VALUES(?,?,?,'sms',?,?,?,?)")
      .bind(id, binding.id, scope.userId, recipient, key, priceVersion, reservedCredits).run();
    return { id, status: "draft", requires_approval: true,
      ...(managed ? { estimated_credits: reservedCredits, segments: terms!.managedSmsSegments(text), price_version: priceVersion } : {}) };
  }
  if (action === "phone-telnyx-stage") {
    if (body.confirm !== true) throw new Error("phone_confirmation_required");
    if (binding && !["released", "detached"].includes(binding.status)) throw new Error("assistant_phone_already_bound");
    const { resolveTelnyxAccount } = await import("./telnyx-account.js");
    const account = await resolveTelnyxAccount(env, identity);
    if (!account) throw new Error("telnyx_account_not_configured");
    const { TelnyxTelephony } = await import("../voice/telnyx-telephony.js");
    const number = await new TelnyxTelephony(account).inspectPhoneNumber(account.verifiedNumberId);
    if (number.phoneNumber !== account.verifiedPhoneNumber) throw new Error("telnyx_number_changed");
    const id = crypto.randomUUID();
    await env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,capabilities_json,previous_callbacks_json,policy_json,status) VALUES(?,?,'assistant','byo','telnyx',?,?,?,'{}','{}',?,'configuring')")
      .bind(id, identity.id, `identity:${identity.id}`, number.id, number.phoneNumber, JSON.stringify(defaultPhonePolicy)).run();
    return { phone: metadata(await assistantPhone(env, identity.id)), transport_active: false };
  }
  if (action === "phone-telnyx-managed-stage") {
    if (body.confirm !== true || !manager || agent) throw new Error("human_control_required");
    if (env.TELNYX_MANAGED_ENABLED !== "true") throw new Error("managed_telnyx_rollout_disabled");
    if (binding && !["released", "detached"].includes(binding.status)) throw new Error("assistant_phone_already_bound");
    if (!env.TELNYX_MANAGED_API_KEY || !env.TELNYX_MANAGED_PUBLIC_KEY || !env.TELNYX_MANAGED_MESSAGING_PROFILE_ID || !env.TELNYX_MANAGED_CALL_CONTROL_ID)
      throw new Error("managed_telnyx_not_configured");
    const { managedTelnyxRateSchedule } = await import("./managed-carrier-billing.js");
    const rates = managedTelnyxRateSchedule(env);
    if (!rates) throw new Error("managed_telnyx_rate_schedule_unavailable");
    if (body.confirmed_price_version !== rates.priceVersion
      || body.confirmed_rental_credits_per_month !== rates.rentalCreditsPerMonth
      || body.confirmed_sms_credits_per_segment !== rates.smsCreditsPerSegment
      || body.confirmed_call_credits_per_minute !== rates.callCreditsPerMinute)
      throw new Error("managed_telnyx_rate_schedule_changed");
    const numberId = String(body.number_id ?? "");
    const { TelnyxTelephony } = await import("../voice/telnyx-telephony.js");
    const client = new TelnyxTelephony({ apiKey: env.TELNYX_MANAGED_API_KEY, publicKey: env.TELNYX_MANAGED_PUBLIC_KEY });
    const number = await client.inspectPhoneNumber(numberId);
    if (number.callControlId !== env.TELNYX_MANAGED_CALL_CONTROL_ID || number.messagingProfileId !== env.TELNYX_MANAGED_MESSAGING_PROFILE_ID)
      throw new Error("managed_telnyx_number_not_assigned");
    const expected = `${phonePublicOrigin(env)}/assistant-phone/telnyx-managed`;
    const [profile, callApp] = await Promise.all([
      client.inspectMessagingProfile(env.TELNYX_MANAGED_MESSAGING_PROFILE_ID),
      client.inspectCallControlApplication(env.TELNYX_MANAGED_CALL_CONTROL_ID),
    ]);
    if (profile.webhookUrl !== expected || callApp.webhookUrl !== expected) throw new Error("managed_telnyx_webhooks_not_configured");
    const id = crypto.randomUUID();
    await env.PLATFORM_DB.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,
      capabilities_json,previous_callbacks_json,policy_json,status,managed_price_version,managed_rental_credits_per_month,
      managed_sms_credits_per_segment,managed_call_credits_per_minute)
      VALUES(?,?,'assistant','managed','telnyx','naelao-managed-telnyx',?,?, '{}','{}',?,'configuring',?,?,?,?)`)
      .bind(id, identity.id, number.id, number.phoneNumber, JSON.stringify(defaultPhonePolicy), rates.priceVersion,
        rates.rentalCreditsPerMonth, rates.smsCreditsPerSegment, rates.callCreditsPerMinute).run();
    return { phone: metadata(await assistantPhone(env, identity.id)), transport_active: false, managed: true };
  }
  if (action === "phone-telnyx-cancel") {
    if (body.confirm !== true) throw new Error("phone_confirmation_required");
    if (!binding || binding.provider !== "telnyx" || binding.status !== "configuring") throw new Error("telnyx_staged_binding_required");
    if (await env.PLATFORM_DB.prepare("SELECT id FROM assistant_telnyx_number_order_operations WHERE binding_id=? AND status IN ('submitting','uncertain','pending') LIMIT 1").bind(binding.id).first())
      throw new Error("telnyx_number_order_reconciliation_required");
    const result = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='detached',updated_at=datetime('now') WHERE id=? AND identity_id=? AND provider='telnyx' AND status='configuring'")
      .bind(binding.id, identity.id).run();
    if (!result.meta.changes) throw new Error("telnyx_staged_binding_changed");
    return { detached: true, rental_continues: true };
  }
  if (["phone-telnyx-configure", "phone-telnyx-status", "phone-telnyx-remove"].includes(action)) {
    const { configureTelnyxAccount, telnyxAccountStatus, removeTelnyxAccount } = await import("./telnyx-account.js");
    if (action !== "phone-telnyx-status" && await env.PLATFORM_DB.prepare(
      "SELECT id FROM assistant_phone_bindings WHERE identity_id=? AND provider='telnyx' AND status NOT IN ('released','detached') LIMIT 1"
    ).bind(identity.id).first()) throw new Error("detach_telnyx_before_changing_credentials");
    if (action === "phone-telnyx-remove") {
      if (body.confirm !== true) throw new Error("phone_confirmation_required");
      return removeTelnyxAccount(env, scope, identity);
    }
    return action === "phone-telnyx-configure"
      ? configureTelnyxAccount(env, scope, identity, body)
      : telnyxAccountStatus(env, identity);
  }
  if (["phone-telnyx-search", "phone-telnyx-quote", "phone-telnyx-order", "phone-telnyx-order-reconcile"].includes(action)) {
    if (!manager || agent) throw new Error("human_control_required");
    const { resolveTelnyxAccount } = await import("./telnyx-account.js");
    const account = await resolveTelnyxAccount(env, identity);
    if (!account) throw new Error("telnyx_account_not_configured");
    const { TelnyxTelephony } = await import("../voice/telnyx-telephony.js");
    const client = new TelnyxTelephony(account);
    if (action === "phone-telnyx-search") {
      const countryCode = String(body.country ?? "").toUpperCase();
      const contains = typeof body.contains === "string" && body.contains ? body.contains : undefined;
      const numberType = body.number_type === undefined || body.number_type === "" ? undefined : String(body.number_type);
      if(numberType!==undefined&&!(["local","toll_free","mobile","national","shared_cost"] as string[]).includes(numberType))throw new Error("telnyx_number_type_invalid");
      const numbers = await client.searchAvailablePhoneNumbers({ countryCode,
        ...(contains ? { contains } : {}), ...(numberType ? { numberType: numberType as "local"|"toll_free"|"mobile"|"national"|"shared_cost" } : {}), limit: 20 });
      return { numbers: numbers.map(row => ({ phone_number: row.phoneNumber, country_code: row.countryCode,
        number_type: row.numberType, features: row.features, locality: row.locality, region: row.region,
        upfront_cost_minor: row.upfrontCostMinor, monthly_cost_minor: row.monthlyCostMinor, currency: row.currency })), purchased: false };
    }
    if (action === "phone-telnyx-quote") {
      if (binding && !["released", "detached"].includes(binding.status)) throw new Error("assistant_phone_already_bound");
      const phoneNumber = String(body.phone_number ?? ""), countryCode = String(body.country ?? "").toUpperCase();
      if (!isE164(phoneNumber) || !/^[A-Z]{2}$/.test(countryCode)) throw new Error("invalid_phone_number");
      const result = await client.searchAvailablePhoneNumbers({ countryCode, startsWith: phoneNumber.replace(/\D/g, ""), limit: 20 });
      const exact = result.find(row => row.phoneNumber === phoneNumber);
      if (!exact) throw new Error("telnyx_phone_number_unavailable");
      if (exact.currency !== "USD") throw new Error("telnyx_phone_currency_unsupported");
      const id = crypto.randomUUID(), expires = new Date(Date.now() + 180000).toISOString();
      await env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_quotes(id,identity_id,payer,provider_account_sid,phone_number,country_code,monthly_cost_minor,inbound_rate_minor,quoted_by,expires_at,provider,upfront_cost_minor,currency) VALUES(?,?,'byo',?,?,?, ?,0,?,?, 'telnyx',?,'USD')")
        .bind(id, identity.id, String(account.verifiedNumberId), phoneNumber, countryCode, exact.monthlyCostMinor, scope.userId, expires, exact.upfrontCostMinor).run();
      return { quote_id: id, phone_number: phoneNumber, upfront_cost_minor: exact.upfrontCostMinor,
        monthly_cost_minor: exact.monthlyCostMinor, currency: "USD", expires_at: expires,
        billed_by: "Telnyx", taxes_included: false, other_usage_charges_apply: true };
    }
    if (action === "phone-telnyx-order") {
      const quote = await env.PLATFORM_DB.prepare("SELECT id,phone_number,country_code,provider_account_sid,monthly_cost_minor,inbound_rate_minor,upfront_cost_minor,currency FROM assistant_phone_quotes WHERE id=? AND identity_id=? AND quoted_by=? AND provider='telnyx' AND status='quoted' AND expires_at>? LIMIT 1")
        .bind(String(body.quote_id ?? ""), identity.id, scope.userId, new Date().toISOString())
        .first<{ id: string; phone_number: string; country_code: string; provider_account_sid: string; monthly_cost_minor: number; inbound_rate_minor: number; upfront_cost_minor: number; currency: string }>();
      if (!quote || quote.provider_account_sid !== String(account.verifiedNumberId)
        || quote.currency !== "USD" || body.confirm_upfront_cost_minor !== quote.upfront_cost_minor
        || body.confirm_monthly_cost_minor !== quote.monthly_cost_minor || body.confirm !== true)
        throw new Error("phone_quote_expired_or_price_not_confirmed");
      if (binding && !["released", "detached"].includes(binding.status)) throw new Error("assistant_phone_already_bound");
      const current = await client.searchAvailablePhoneNumbers({ countryCode: quote.country_code,
        startsWith: quote.phone_number.replace(/\D/g, ""), limit: 20 });
      const exact = current.find(row => row.phoneNumber === quote.phone_number);
      if (!exact || exact.currency !== quote.currency || exact.upfrontCostMinor !== quote.upfront_cost_minor
        || exact.monthlyCostMinor !== quote.monthly_cost_minor) throw new Error("telnyx_phone_price_or_availability_changed");
      const operationId = `tn_${crypto.randomUUID()}`;
      const customerReference = `naelao_${operationId.replace(/-/g, "_")}`;
      const bindingId = crypto.randomUUID();
      const configured = await client.inspectPhoneNumber(account.verifiedNumberId);
      const inserted = await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare("UPDATE assistant_phone_quotes SET status='processing' WHERE id=? AND identity_id=? AND provider='telnyx' AND status='quoted' AND expires_at>?").bind(quote.id, identity.id, new Date().toISOString()),
        env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,country_code,capabilities_json,previous_callbacks_json,policy_json,monthly_cost_minor,status) SELECT ?,?,'assistant','byo','telnyx',?,NULL,?,?, '{}','{}',?,?,'configuring' WHERE EXISTS(SELECT 1 FROM assistant_phone_quotes WHERE id=? AND identity_id=? AND status='processing') AND NOT EXISTS(SELECT 1 FROM assistant_telnyx_number_order_operations WHERE quote_id=?)")
          .bind(bindingId, identity.id, `identity:${identity.id}`, quote.phone_number, quote.country_code, JSON.stringify(defaultPhonePolicy), quote.monthly_cost_minor, quote.id, identity.id, quote.id),
        env.PLATFORM_DB.prepare("INSERT INTO assistant_telnyx_number_order_operations(id,identity_id,quote_id,binding_id,provider_account_ref,customer_reference,phone_number,country_code,upfront_cost_minor,monthly_cost_minor,currency,status) SELECT ?,?,?,?,?,?,?,?,?,?,'USD','prepared' WHERE EXISTS(SELECT 1 FROM assistant_phone_bindings WHERE id=? AND identity_id=? AND status='configuring') AND EXISTS(SELECT 1 FROM assistant_phone_quotes WHERE id=? AND identity_id=? AND status='processing') AND NOT EXISTS(SELECT 1 FROM assistant_telnyx_number_order_operations WHERE quote_id=?)")
          .bind(operationId, identity.id, quote.id, bindingId, String(account.verifiedNumberId), customerReference, quote.phone_number, quote.country_code, quote.upfront_cost_minor, quote.monthly_cost_minor, bindingId, identity.id, quote.id, identity.id, quote.id),
      ]);
      if (inserted[0]?.meta.changes !== 1 || inserted[1]?.meta.changes !== 1 || inserted[2]?.meta.changes !== 1) throw new Error("phone_quote_already_used");
      const operation = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_telnyx_number_order_operations WHERE id=? AND identity_id=?")
        .bind(operationId, identity.id).first<TelnyxNumberOrderOperation>();
      if (!operation) throw new Error("telnyx_number_order_journal_unavailable");
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_number_order_operations SET status='submitting',updated_at=datetime('now') WHERE id=? AND status='prepared'")
        .bind(operationId).run();
      try {
        const order = await client.createNumberOrder({ phoneNumber: quote.phone_number, customerReference,
          connectionId: configured.callControlId, messagingProfileId: configured.messagingProfileId });
        const result = await reconcileTelnyxNumberOrder(env, identity, client, operation, order);
        return { ...result, upfront_cost_minor: quote.upfront_cost_minor, monthly_cost_minor: quote.monthly_cost_minor, currency: quote.currency };
      } catch (error) {
        const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "telnyx_number_order_outcome_unknown";
        const rejected = error instanceof PhoneProviderError && !error.uncertain;
        const nextReconcileAt=new Date(Date.now()+5*60_000).toISOString();
        await env.PLATFORM_DB.batch(rejected ? [
          env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_number_order_operations SET status='failed',last_error=?,lease_until=NULL,next_reconcile_at=NULL,updated_at=datetime('now') WHERE id=? AND status IN ('submitting','pending')").bind(code, operationId),
          env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='detached',updated_at=datetime('now') WHERE id=? AND status IN ('configuring','indeterminate')").bind(bindingId),
          env.PLATFORM_DB.prepare("UPDATE assistant_phone_quotes SET status='failed' WHERE id=? AND status='processing'").bind(quote.id),
        ] : [
          env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_number_order_operations SET status='uncertain',last_error=?,lease_until=NULL,next_reconcile_at=?,updated_at=datetime('now') WHERE id=? AND status IN ('submitting','pending')").bind(code,nextReconcileAt,operationId),
          env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='indeterminate',updated_at=datetime('now') WHERE id=? AND status='configuring'").bind(bindingId),
        ]);
        if (rejected) throw error;
        throw new PhoneProviderError(true, "telnyx_number_order_reconciliation_required");
      }
    }
    const operationId = String(body.operation_id ?? "");
    const operation = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_telnyx_number_order_operations WHERE id=? AND identity_id=?")
      .bind(operationId, identity.id).first<TelnyxNumberOrderOperation>();
    if (!operation || operation.status === "failed") throw new Error("telnyx_number_order_not_found");
    if (operation.provider_account_ref !== String(account.verifiedNumberId)) throw new Error("telnyx_account_changed_since_order");
    let matches: Record<string, unknown>[] = [];
    if (operation.provider_order_id && isTelnyxOrderId(operation.provider_order_id)) {
      try {
        const exact = await client.inspectNumberOrder(operation.provider_order_id);
        if (exact.customer_reference === operation.customer_reference) matches = [exact];
      } catch { /* Fall back to read-only reference search after a missing or unavailable receipt. */ }
    }
    if (!matches.length) {
      const listed = await client.listNumberOrders(operation.customer_reference);
      matches = listed.filter(row => row.customer_reference === operation.customer_reference);
    }
    if (matches.length !== 1) return { operation_id: operation.id, status: operation.status, reconciled: false,
      reason: matches.length ? "duplicate_provider_orders_require_manual_review" : "provider_order_not_yet_visible_no_replay" };
    const result = await reconcileTelnyxNumberOrder(env, identity, client, operation, matches[0]!);
    return { ...result, reconciled: true };
  }
  if (body.binding_id !== undefined) {
    if (
      !manager ||
      agent ||
      typeof body.binding_id !== "string" ||
      ![
        "phone-detach",
        "phone-release",
        "phone-handler",
        "phone-handler-test",
        "phone-policy",
        "phone-reconcile",
        "phone-reconcile-number",
        "phone-telnyx-approve",
        "phone-telnyx-send",
        "phone-telnyx-reconcile",
        "phone-telnyx-cost",
      ].includes(action)
    )
      throw new Error("human_control_required");
    binding = await env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_phone_bindings WHERE id=? AND identity_id=? AND purpose='extension'"
    )
      .bind(body.binding_id, identity.id)
      .first<AssistantPhoneBinding>();
  }
  if (["phone-telnyx-approve", "phone-telnyx-send", "phone-telnyx-reconcile", "phone-telnyx-cost"].includes(action)) {
    if (!binding || binding.provider !== "telnyx" || binding.status !== "active" || body.confirm !== true || typeof body.id !== "string")
      throw new Error("telnyx_sms_approval_required");
    if (action === "phone-telnyx-approve") {
      const draft = await env.PLATFORM_DB.prepare("SELECT body_key,managed_price_version,managed_reserved_credits FROM assistant_phone_actions WHERE id=? AND binding_id=? AND kind='sms' AND status='draft'")
        .bind(body.id, binding.id).first<{ body_key: string; managed_price_version: string | null; managed_reserved_credits: number | null }>();
      if (!draft) throw new Error("phone_action_not_draft");
      if (binding.payer === "managed") {
        const { managedSmsCreditsPerSegment, managedSmsSegments } = await import("./managed-carrier-billing.js");
        const content = await readBody(env, identity, body.id, draft.body_key);
        const expectedCredits = managedSmsCreditsPerSegment(env, binding) * managedSmsSegments(String(content.text ?? ""));
        if (!draft.managed_price_version || draft.managed_price_version !== binding.managed_price_version
          || draft.managed_reserved_credits !== expectedCredits
          || body.confirmed_price_version !== draft.managed_price_version
          || body.confirmed_max_charge_credits !== draft.managed_reserved_credits)
          throw new Error("managed_telnyx_sms_confirmation_mismatch");
      }
      const changed = await env.PLATFORM_DB.prepare("UPDATE assistant_phone_actions SET status='approved',approved_by=? WHERE id=? AND binding_id=? AND kind='sms' AND status='draft' AND managed_price_version IS ? AND managed_reserved_credits IS ?")
        .bind(scope.userId, body.id, binding.id, draft.managed_price_version, draft.managed_reserved_credits).run();
      if (!changed.meta.changes) throw new Error("phone_action_not_draft");
      return { id: body.id, status: "approved" };
    }
    if (action === "phone-telnyx-reconcile") {
      if (typeof body.provider_sid !== "string") throw new Error("telnyx_reconciliation_invalid");
      if (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId)) throw new Error("air_gap_egress_denied");
      return (await import("./telnyx-send.js")).reconcileTelnyxSms(env, identity, binding, body.id, body.provider_sid);
    }
    if (action === "phone-telnyx-cost") {
      if (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId)) throw new Error("air_gap_egress_denied");
      return (await import("./telnyx-send.js")).observeTelnyxSmsCost(env, identity, binding, body.id);
    }
    return (await import("./telnyx-send.js")).sendApprovedTelnyxSms(env, identity, binding, body.id, scope);
  }
  if (action === "phone-credentials") {
    if (!env.CREDENTIALS_WORKER)
      throw new Error("credential_vault_unavailable");
    if (
      await env.PLATFORM_DB.prepare(
        "SELECT id FROM assistant_phone_bindings WHERE identity_id=? AND status NOT IN ('released','detached') LIMIT 1"
      )
        .bind(identity.id)
        .first()
    )
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
      `SELECT *${action === "phone-actions" ? ", (SELECT status FROM assistant_telnyx_cost_polls p WHERE p.action_id=assistant_phone_actions.id) AS cost_collection_status, (SELECT managed_charge_credits FROM assistant_telnyx_usage_receipts r WHERE r.action_id=assistant_phone_actions.id ORDER BY r.observed_at DESC LIMIT 1) AS managed_charge_credits" : ""} FROM ${table} WHERE binding_id=? ${cursor ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT 51`
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

  // Telnyx live calls use the verified Telnyx account and never need a Twilio
  // credential. Keep this route ahead of the Twilio credential resolution below.
  if (action === "phone-live" && binding?.provider === "telnyx") {
    if (!binding || !binding.provider_number_sid) throw new Error("assistant_phone_not_connected");
    if (binding.purpose === "extension") throw new Error("internal_assistant_line_required");
    if (binding.provider === "telnyx" && JSON.parse(binding.capabilities_json || "{}").voice !== true)
      throw new Error("phone_provider_live_transport_unavailable");
    if (!manager || agent || body.confirm !== true) throw new Error("human_control_required");
    if (binding.provider === "telnyx" && binding.payer === "managed") {
      const { managedTelnyxCallCharge } = await import("./managed-carrier-billing.js");
      const quote = managedTelnyxCallCharge(binding);
      if (body.confirmed_price_version !== quote.priceVersion || body.confirmed_max_charge_credits !== quote.maxChargeCredits)
        throw new Error("managed_telnyx_call_confirmation_mismatch");
    }
    const account = await (await import("./telnyx-account.js")).resolveTelnyxAccount(env, identity, binding);
    if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number
      || !account.callControlId) throw new Error("phone_provider_live_transport_unavailable");
    const { armLiveCall } = await import("./live-calls.js");
    return armLiveCall(env, scope, binding, body.session_id);
  }

  const payer =
    binding?.payer ?? (body.payer === "managed" ? "managed" : "byo");
  const legacyBindingId = action === "phone-import" && typeof body.legacy_binding_id === "string"
    ? body.legacy_binding_id
    : null;
  const credentials = await resolvePhoneCredentials(env, identity, payer, binding ?? undefined);
  if (!credentials)
    throw new Error(
      payer === "managed"
        ? "managed_phone_billing_not_configured"
        : "assistant_phone_credentials_missing"
    );
  if (
    binding &&
    !["released", "detached"].includes(binding.status) &&
    !legacyBindingId && binding.provider_account_sid !== credentials.accountSid
  )
    throw new Error("phone_provider_account_changed");
  if (action === "phone-twilio-cost") {
    if (!manager || agent || body.confirm !== true || !binding || (binding.provider ?? "twilio") !== "twilio")
      throw new Error("twilio_cost_owner_confirmation_required");
    if (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId)) throw new Error("air_gap_egress_denied");
    return (await import("./twilio-cost.js")).observeTwilioSmsCost(env, identity, binding, credentials, String(body.id ?? ""));
  }
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
    if (binding && !["released", "detached"].includes(binding.status) && !legacyBindingId)
      throw new Error("assistant_phone_already_bound");
    if (body.confirm !== true)
      throw new Error("explicit_phone_confirmation_required");
    let record: Record<string, unknown> | undefined;
    let legacyBinding: { id: string; provider_account_sid: string; provider_number_sid: string; status: string } | null = null;
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
      if (legacyBindingId) {
        legacyBinding = await env.PLATFORM_DB.prepare(
          "SELECT id,provider_account_sid,provider_number_sid,status FROM customer_voice_number_bindings WHERE id=? AND tenant_id=? AND space_id=? AND status='active'"
        ).bind(legacyBindingId, scope.tenantId, scope.spaceId).first<{ id: string; provider_account_sid: string; provider_number_sid: string; status: string }>();
        if (!legacyBinding || legacyBinding.provider_number_sid !== body.number_sid || legacyBinding.provider_account_sid !== credentials.accountSid)
          throw new Error("legacy_phone_binding_mismatch");
      }
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
        "SELECT * FROM assistant_phone_quotes WHERE id=? AND identity_id=? AND quoted_by=? AND provider_account_sid=? AND provider='twilio' AND status='quoted' AND expires_at>?"
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
    const previous = legacyBinding
      ? { voice_url: "", voice_method: "POST", sms_url: "", sms_method: "POST", status_callback: "", status_callback_method: "POST" }
      : record
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
      "INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider_account_sid,provider_number_sid,phone_number,country_code,capabilities_json,previous_callbacks_json,policy_json,monthly_cost_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        id,
        identity.id,
        legacyBinding ? "extension" : "assistant",
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
      if (legacyBinding) await extensionPhoneSetupAllowed(env, scope);
      else await livePhoneAllowed(env, scope);
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
      if (legacyBinding) {
        await env.PLATFORM_DB.prepare(
          "UPDATE customer_voice_number_bindings SET status='disabled',updated_at=? WHERE id=? AND tenant_id=? AND space_id=? AND status='active'"
        ).bind(new Date().toISOString(), legacyBinding.id, scope.tenantId, scope.spaceId).run();
      }
      if (quote)
        await env.PLATFORM_DB.prepare(
          "UPDATE assistant_phone_quotes SET status='completed' WHERE id=?"
        )
          .bind(quote.id)
          .run();
      const migrated = legacyBinding
        ? await env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE id=? AND identity_id=?").bind(id, identity.id).first<AssistantPhoneBinding>()
        : await assistantPhone(env, identity.id);
      return { phone: metadata(migrated), legacy_migrated: Boolean(legacyBinding) };
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
    const reconciled = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE id=? AND identity_id=?").bind(binding.id, identity.id).first<AssistantPhoneBinding>();
    return { phone: metadata(reconciled) };
  }
  if (!binding || !binding.provider_number_sid)
    throw new Error("assistant_phone_not_connected");
  if (action === "phone-live") {
    if (binding.purpose === "extension") throw new Error("internal_assistant_line_required");
    if (agent || body.confirm !== true) throw new Error("human_control_required");
    const { armLiveCall } = await import("./live-calls.js");
    return armLiveCall(env, scope, binding, body.session_id);
  }
  if (action === "phone-live-end") {
    if (agent || body.confirm !== true)
      throw new Error("human_control_required");
    const live = await env.PLATFORM_DB.prepare(
      "SELECT call_sid,id FROM assistant_live_calls WHERE binding_id=? AND user_id=? AND status='connected'"
    )
      .bind(binding.id, scope.userId)
      .all<{ call_sid: string; id: string }>();
    const endedAt = Math.floor(Date.now() / 1000);
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("UPDATE assistant_live_calls SET status='revoked',managed_reservation_status=CASE WHEN reserved_credits>0 THEN 'release_pending' ELSE managed_reservation_status END,managed_reservation_updated_at=? WHERE binding_id=? AND user_id=? AND status='armed'")
        .bind(endedAt, binding.id, scope.userId),
      env.PLATFORM_DB.prepare("UPDATE assistant_live_calls SET status='revoked' WHERE binding_id=? AND user_id=? AND status='connected'")
        .bind(binding.id, scope.userId),
    ]);
    if (binding.provider === "telnyx") {
      const account = await (await import("./telnyx-account.js")).resolveTelnyxAccount(env, identity, binding);
      if (live.results.length && !account) throw new Error("phone_access_revoked_carrier_hangup_unconfirmed");
      const client = account ? new (await import("../voice/telnyx-telephony.js")).TelnyxTelephony(account) : null;
      for (const call of live.results) {
        const linked = await env.PLATFORM_DB.prepare("SELECT call_control_id FROM assistant_telnyx_live_calls WHERE live_call_id=? AND binding_id=? AND state IN ('answering','gathering','streaming','indeterminate')")
          .bind(call.id, binding.id).first<{ call_control_id: string }>();
        if (linked && client) await client.callAction(linked.call_control_id, "hangup", `owner_end_${call.id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
      }
    } else {
      const credentials = await resolvePhoneCredentials(env, identity, binding.payer, binding);
      if (live.results.length && !credentials) throw new Error("phone_access_revoked_carrier_hangup_unconfirmed");
      for (const call of live.results) await phoneProvider(credentials!, `Calls/${call.call_sid}.json`, "POST", new URLSearchParams({ Status: "completed" }));
    }
    if (binding.provider === "telnyx" && binding.payer === "managed")
      await (await import("./managed-carrier-billing.js")).sweepManagedTelnyxCallReservations(env).catch(() => undefined);
    return { revoked: true };
  }
  if (action === "phone-handler") {
    if (!manager || agent || body.confirm !== true)
      throw new Error("phone_handler_owner_confirmation_required");
    if (
      await env.PLATFORM_DB.prepare(
        "SELECT id FROM assistant_live_calls WHERE binding_id=? AND status='connected' AND deadline>?"
      )
        .bind(binding.id, Math.floor(Date.now() / 1000))
        .first()
    )
      throw new Error("end_live_calls_before_extension_conversion");
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
      const activated = await env.PLATFORM_DB.prepare(
        "UPDATE assistant_phone_extension_handlers SET status='active' WHERE binding_id=? AND installation_id=? AND handler_sha256=?"
      )
        .bind(binding.id, installation, digest)
        .run();
      if (activated.meta.changes !== 1)
        throw new Error("phone_handler_changed_during_validation");
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(
          "UPDATE assistant_phone_bindings SET purpose='extension' WHERE id=?"
        ).bind(binding.id),
        env.PLATFORM_DB.prepare(
          "UPDATE assistant_live_calls SET status='revoked',managed_reservation_status=CASE WHEN reserved_credits>0 THEN 'release_pending' ELSE managed_reservation_status END,managed_reservation_updated_at=? WHERE binding_id=? AND status='armed'"
        ).bind(Math.floor(Date.now() / 1000), binding.id),
      ]);
      return {
        bound: true,
        purpose: "extension",
        requires_separate_assistant_number: true,
      };
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
  if (action === "phone-handler-test") {
    if (!manager || agent || !binding || binding.status !== "active")
      throw new Error("phone_handler_owner_confirmation_required");
    const eventType = body.event_type === undefined ? "call.speech" : body.event_type;
    if (eventType !== "call.received" && eventType !== "call.digits" && eventType !== "call.speech")
      throw new Error("phone_simulation_event_invalid");
    const input = typeof body.input === "string" ? body.input.trim() : "";
    const digits = typeof body.digits === "string" ? body.digits : "";
    if (eventType === "call.speech" && (!input || new TextEncoder().encode(input).byteLength > 2_000)
      || eventType === "call.digits" && !/^[0-9]{1,8}$/.test(digits)
      || eventType === "call.received" && (body.input !== undefined || body.digits !== undefined)
      || eventType === "call.digits" && body.input !== undefined
      || eventType === "call.speech" && body.digits !== undefined)
      throw new Error("phone_simulation_input_invalid");
    const r = await env.AGENTS_WORKER.fetch(new Request("http://agents/internal/phone-extension-test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": scope.tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId),
      },
      body: JSON.stringify({ bindingId: binding.id, spaceId: scope.spaceId, eventType,
        ...(eventType === "call.speech" ? { input } : {}), ...(eventType === "call.digits" ? { digits } : {}) }),
    }));
    if (!r.ok) {
      const result = await r.json<{ error_code?: string }>().catch(() => ({} as { error_code?: string }));
      throw new Error(result.error_code ?? "phone_simulation_unavailable");
    }
    return r.json();
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
