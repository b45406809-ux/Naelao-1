import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import type { CommunicationIdentity } from "./core.js";
import type { AssistantPhoneBinding } from "./phones.js";
import type { LiveCall } from "./live-calls.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { TelnyxTelephony } from "../voice/telnyx-telephony.js";

function positiveConfig(value: string | undefined, max = 100_000): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : null;
}
export function managedSmsSegments(text: string): number {
  const gsmBasic = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const gsmExtended = "^{}\\[~]|€";
  let septets = 0;
  let gsm = true;
  for (const char of text) {
    if (gsmBasic.includes(char)) septets += 1;
    else if (gsmExtended.includes(char)) septets += 2;
    else { gsm = false; break; }
  }
  const units = gsm ? septets : [...text].length;
  return Math.max(1, Math.ceil(units / (gsm ? (units > 160 ? 153 : 160) : (units > 70 ? 67 : 70))));
}
export function carrierUsdToCredits(amount: string): number {
  const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(amount);
  if (!match) throw new Error("managed_carrier_amount_invalid");
  const decimals = match[2] ?? "";
  const scale = 10n ** BigInt(decimals.length);
  const numerator = BigInt(match[1]!) * scale + BigInt(decimals || "0");
  // 100 credits per USD with a 15% operational margin, rounded up to avoid undercollection.
  const credits = (numerator * 115n + scale - 1n) / scale;
  if (credits > 10_000_000n) throw new Error("managed_carrier_amount_limit");
  return Number(credits);
}
async function postBudget(env: AgentsEnv, scope: CommunicationScope, path: "reserve" | "settle" | "release", body: Record<string, unknown>) {
  if (!env.BILLING_WORKER) throw new Error("managed_carrier_billing_unavailable");
  const response = await env.BILLING_WORKER.fetch(new Request(`http://billing-worker/internal/workflows/budget/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) }, body: JSON.stringify(body),
  }));
  const result = await readBoundedResponseJson<Record<string, unknown>>(response, 16_384);
  if (!response.ok || result.reserved === false || result.settled === false) throw new Error(`managed_carrier_${path}_rejected`);
  return result;
}
export async function reserveManagedCarrierCredits(env: AgentsEnv, scope: CommunicationScope, workflowId: string, credits: number, budgetKey: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(workflowId) || !Number.isSafeInteger(credits) || credits < 1 || credits > 10_000_000) throw new Error("managed_carrier_reservation_invalid");
  return postBudget(env, scope, "reserve", { reservation_id: workflowId, workflow_id: workflowId, space_id: scope.spaceId,
    budget_key: budgetKey, credits, ...(scope.projectId ? { project_id: scope.projectId } : {}), expires_at: new Date(Date.now() + 2 * 86400_000).toISOString() });
}
export async function settleManagedCarrierCredits(env: AgentsEnv, scope: CommunicationScope, workflowId: string, credits: number) {
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 10_000_000) throw new Error("managed_carrier_settlement_invalid");
  return postBudget(env, scope, "settle", { reservation_id: workflowId, quantity: credits });
}
export async function releaseManagedCarrierCredits(env: AgentsEnv, scope: CommunicationScope, workflowId: string) {
  return postBudget(env, scope, "release", { reservation_id: workflowId });
}
export function managedSmsCreditsPerSegment(env: AgentsEnv): number {
  const value = positiveConfig(env.TELNYX_MANAGED_SMS_CREDITS_PER_SEGMENT);
  if (!value) throw new Error("managed_telnyx_sms_price_unconfigured");
  return value;
}
export async function managedMessageReservationId(bindingId: string, providerMessageId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bindingId}:${providerMessageId}`)));
  return `telnyx_sms_${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function managedCallCreditsPerMinute(env: AgentsEnv): number {
  const value = positiveConfig(env.TELNYX_MANAGED_CALL_CREDITS_PER_MINUTE);
  if (!value) throw new Error("managed_telnyx_call_price_unconfigured");
  return value;
}
export function managedRentalCreditsPerMonth(env: AgentsEnv): number {
  const value = positiveConfig(env.TELNYX_MANAGED_RENTAL_CREDITS_PER_MONTH);
  if (!value) throw new Error("managed_telnyx_rental_price_unconfigured");
  return value;
}

export async function billManagedTelnyxRental(env: AgentsEnv, binding: AssistantPhoneBinding, identity: CommunicationIdentity, now = Math.floor(Date.now() / 1000)) {
  if (binding.payer !== "managed" || binding.provider !== "telnyx" || !binding.phone_number || !binding.provider_number_sid) throw new Error("managed_telnyx_binding_invalid");
  const credits = managedRentalCreditsPerMonth(env);
  const period = new Date(now * 1000).toISOString().slice(0, 7);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${binding.id}:${period}:rental`)));
  const workflowId = `telnyx_rent_${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const inserted = await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_managed_phone_rentals(binding_id,billing_period,workflow_id,credits,status,next_at,updated_at) VALUES(?,?,?,?,'pending',?,?)")
    .bind(binding.id, period, workflowId, credits, now, now).run();
  const receipt = await env.PLATFORM_DB.prepare("SELECT workflow_id,credits,status FROM assistant_managed_phone_rentals WHERE binding_id=? AND billing_period=?")
    .bind(binding.id, period).first<{ workflow_id: string; credits: number; status: string }>();
  if (!receipt || receipt.workflow_id !== workflowId || receipt.credits !== credits) throw new Error("managed_telnyx_rental_receipt_conflict");
  if (receipt.status === "paid") return { billed: true, deduplicated: true, credits, period };
  const claim = await env.PLATFORM_DB.prepare("UPDATE assistant_managed_phone_rentals SET status='running',attempts=attempts+1,lease_until=?,updated_at=? WHERE binding_id=? AND billing_period=? AND ((status IN ('pending','held') AND next_at<=?) OR (status='running' AND lease_until<=?))")
    .bind(now + 120, now, binding.id, period, now, now).run();
  if (!claim.meta.changes) return { billed: false, pending: true, credits, period };
  const scope: CommunicationScope = { tenantId: identity.tenant_id, spaceId: identity.space_id, userId: identity.owner_user_id,
    role: "product_end_user", ...(identity.project_id ? { projectId: identity.project_id } : {}) };
  try {
    await reserveManagedCarrierCredits(env, scope, workflowId, credits, `managed-phone:${binding.id}`);
    await settleManagedCarrierCredits(env, scope, workflowId, credits);
    await env.PLATFORM_DB.prepare("UPDATE assistant_managed_phone_rentals SET status='paid',lease_until=NULL,last_error=NULL,updated_at=? WHERE binding_id=? AND billing_period=? AND status='running' AND lease_until=?")
      .bind(now, binding.id, period, now + 120).run();
    return { billed: true, credits, period };
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "managed_carrier_billing_unavailable";
    await env.PLATFORM_DB.prepare("UPDATE assistant_managed_phone_rentals SET status='held',next_at=?,lease_until=NULL,last_error=?,updated_at=? WHERE binding_id=? AND billing_period=? AND status='running' AND lease_until=?")
      .bind(now + 3600, code, now, binding.id, period, now + 120).run();
    throw error;
  }
}

export async function sweepManagedTelnyxRentals(env: AgentsEnv, now = Math.floor(Date.now() / 1000)) {
  if (!env.TELNYX_MANAGED_API_KEY || !env.TELNYX_MANAGED_PUBLIC_KEY || !env.TELNYX_MANAGED_RENTAL_CREDITS_PER_MONTH) return { checked: 0, billed: 0, held: 0 };
  const bindings = await env.PLATFORM_DB.prepare("SELECT b.*,i.tenant_id,i.space_id,i.project_id,i.owner_user_id,i.status AS identity_status FROM assistant_phone_bindings b JOIN assistant_communication_identities i ON i.id=b.identity_id WHERE b.provider='telnyx' AND b.payer='managed' AND b.purpose='assistant' AND b.status IN ('active','billing_hold','indeterminate') AND i.status='active' ORDER BY b.id LIMIT 100")
    .all<AssistantPhoneBinding & Pick<CommunicationIdentity, "tenant_id" | "space_id" | "project_id" | "owner_user_id"> & { identity_status: string }>();
  let billed = 0, held = 0;
  await Promise.all(bindings.results.map(async row => {
    const identity: CommunicationIdentity = { id: row.identity_id, tenant_id: row.tenant_id, space_id: row.space_id,
      project_id: row.project_id, owner_user_id: row.owner_user_id, status: row.identity_status } as CommunicationIdentity;
    try {
      const result = await billManagedTelnyxRental(env, row, identity, now);
      if (result.billed) {
        billed++;
        await env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='active',updated_at=datetime('now') WHERE id=? AND status='billing_hold'").bind(row.id).run();
      }
    } catch {
      held++;
      await env.PLATFORM_DB.prepare("UPDATE assistant_phone_bindings SET status='billing_hold',updated_at=datetime('now') WHERE id=? AND status='active'").bind(row.id).run();
    }
  }));
  return { checked: bindings.results.length, billed, held };
}

export async function settleManagedTelnyxCall(env: AgentsEnv, binding: AssistantPhoneBinding, liveCallId: string, durationSeconds: number) {
  if (binding.provider !== "telnyx" || binding.payer !== "managed" || !Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 900)
    throw new Error("managed_telnyx_call_usage_invalid");
  const live = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_live_calls WHERE id=? AND binding_id=?")
    .bind(liveCallId, binding.id).first<LiveCall>();
  if (!live) throw new Error("managed_telnyx_call_not_found");
  const credits = Math.ceil(durationSeconds / 60) * managedCallCreditsPerMinute(env);
  if (credits > live.reserved_credits) throw new Error("managed_telnyx_call_exceeds_reservation");
  const scope: CommunicationScope = { tenantId: live.tenant_id, spaceId: live.space_id, userId: live.user_id, role: live.caller_role,
    ...(live.project_id ? { projectId: live.project_id } : {}) };
  await settleManagedCarrierCredits(env, scope, liveCallId, credits);
  await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET settled_credits=? WHERE live_call_id=? AND binding_id=? AND settled_credits IS NULL")
    .bind(credits, liveCallId, binding.id).run();
  return { settled: true, credits, duration_seconds: durationSeconds };
}

export async function sweepManagedTelnyxCallCharges(env: AgentsEnv) {
  if (!env.TELNYX_MANAGED_API_KEY || !env.BILLING_WORKER || !env.TELNYX_MANAGED_CALL_CREDITS_PER_MINUTE) return { checked: 0, settled: 0, held: 0 };
  const rows = await env.PLATFORM_DB.prepare("SELECT tc.live_call_id,tc.binding_id,tc.duration_seconds FROM assistant_telnyx_live_calls tc JOIN assistant_phone_bindings b ON b.id=tc.binding_id WHERE b.provider='telnyx' AND b.payer='managed' AND tc.state='ended' AND tc.duration_seconds IS NOT NULL AND tc.settled_credits IS NULL ORDER BY tc.updated_at,tc.live_call_id LIMIT 100")
    .all<{ live_call_id: string; binding_id: string; duration_seconds: number }>();
  let settled = 0, held = 0;
  await Promise.all(rows.results.map(async row => {
    const binding = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE id=? AND provider='telnyx' AND payer='managed'").bind(row.binding_id).first<AssistantPhoneBinding>();
    if (!binding) { held++; return; }
    try { await settleManagedTelnyxCall(env, binding, row.live_call_id, row.duration_seconds); settled++; }
    catch { held++; }
  }));
  return { checked: rows.results.length, settled, held };
}

export async function sweepManagedTelnyxInboundSmsCosts(env: AgentsEnv, now = Math.floor(Date.now() / 1000)) {
  if (!env.TELNYX_MANAGED_API_KEY || !env.TELNYX_MANAGED_PUBLIC_KEY || !env.BILLING_WORKER) return { checked: 0, observed: 0, held: 0 };
  const due = await env.PLATFORM_DB.prepare("SELECT provider_message_id FROM assistant_managed_telnyx_message_costs WHERE (status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?) ORDER BY next_at,provider_message_id LIMIT 50")
    .bind(now, now).all<{ provider_message_id: string }>();
  let observed = 0, held = 0;
  await Promise.all(due.results.map(async ({ provider_message_id }) => {
    const claim = await env.PLATFORM_DB.prepare("UPDATE assistant_managed_telnyx_message_costs SET status='running',attempts=attempts+1,lease_until=?,updated_at=? WHERE provider_message_id=? AND ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?))")
      .bind(now + 120, now, provider_message_id, now, now).run();
    if (!claim.meta.changes) return;
    const row = await env.PLATFORM_DB.prepare("SELECT r.*,b.identity_id,b.provider_number_sid,b.phone_number FROM assistant_managed_telnyx_message_costs r JOIN assistant_phone_bindings b ON b.id=r.binding_id WHERE r.provider_message_id=? AND b.provider='telnyx' AND b.payer='managed'")
      .bind(provider_message_id).first<{ provider_message_id: string; binding_id: string; identity_id: string; sender: string; carrier_reservation_id: string; reserved_credits: number; attempts: number; created_at: number; provider_number_sid: string; phone_number: string }>();
    const identity = row && await env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=?")
      .bind(row.identity_id).first<CommunicationIdentity>();
    if (!row || !identity) { held++; return; }
    try {
      const account = await resolveTelnyxAccount(env, identity, { payer: "managed", provider_number_sid: row.provider_number_sid, phone_number: row.phone_number });
      if (!account) throw new Error("managed_telnyx_credentials_unavailable");
      const receipt = await new TelnyxTelephony(account).inspectMessage(provider_message_id);
      const from = receipt.from as { phone_number?: unknown } | undefined;
      const to = Array.isArray(receipt.to) ? receipt.to as Array<{ phone_number?: unknown }> : [];
      if (receipt.id !== provider_message_id || receipt.direction !== "inbound" || from?.phone_number !== row.sender
        || to.length !== 1 || to[0]?.phone_number !== row.phone_number) throw new Error("managed_telnyx_inbound_receipt_mismatch");
      const cost = receipt.cost as { amount?: unknown; currency?: unknown } | null | undefined;
      if (receipt.completed_at == null || cost == null) {
        if (row.attempts >= 215 || now - row.created_at > 9 * 86400) {
          await env.PLATFORM_DB.prepare("UPDATE assistant_managed_telnyx_message_costs SET status='expired',lease_until=NULL,last_error='provider_usage_window_expired',updated_at=? WHERE provider_message_id=? AND lease_until=?")
            .bind(now, provider_message_id, now + 120).run();
        } else await env.PLATFORM_DB.prepare("UPDATE assistant_managed_telnyx_message_costs SET status='pending',next_at=?,lease_until=NULL,last_error=NULL,updated_at=? WHERE provider_message_id=? AND lease_until=?")
          .bind(now + 3600, now, provider_message_id, now + 120).run();
        return;
      }
      if (typeof cost.amount !== "string" || !/^[0-9]+(?:\.[0-9]{1,12})?$/.test(cost.amount) || cost.currency !== "USD") throw new Error("managed_telnyx_inbound_cost_invalid");
      const credits = carrierUsdToCredits(cost.amount);
      if (credits > row.reserved_credits) throw new Error("managed_telnyx_inbound_cost_exceeds_reservation");
      await settleManagedCarrierCredits(env, { tenantId: identity.tenant_id, spaceId: identity.space_id, userId: identity.owner_user_id,
        role: "product_end_user", ...(identity.project_id ? { projectId: identity.project_id } : {}) }, row.carrier_reservation_id, credits);
      await env.PLATFORM_DB.prepare("UPDATE assistant_managed_telnyx_message_costs SET status='observed',lease_until=NULL,last_error=NULL,updated_at=? WHERE provider_message_id=? AND lease_until=?")
        .bind(now, provider_message_id, now + 120).run();
      observed++;
    } catch (error) {
      const message = error instanceof Error && /^[a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "provider_unavailable";
      const isMismatch = message.includes("mismatch") || message.includes("_invalid") || message.includes("exceeds_reservation");
      await env.PLATFORM_DB.prepare("UPDATE assistant_managed_telnyx_message_costs SET status=?,next_at=?,lease_until=NULL,last_error=?,updated_at=? WHERE provider_message_id=? AND lease_until=?")
        .bind(isMismatch ? "held" : "pending", now + 3600, message, now, provider_message_id, now + 120).run();
      if (isMismatch) held++;
    }
  }));
  return { checked: due.results.length, observed, held };
}
