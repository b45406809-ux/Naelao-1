// Naelao Email provider adapter (MS-35, V-spec §8, MD-10): provision, lookup, deprovision and execute send/read over the
// NAELAO_EMAIL service binding. Everything is behind MANAGED_OFFERINGS_ENABLED and fails closed.
//
// - Provisioning resolves offering admission (strategy `first_party`) first and needs a Billing reservation id.
// - The per-tenant Naelao Email API key is created through the internal HMAC tenant route on first use and stored only as an
//   authenticated-encryption envelope (`managed_naelao_email_tenants`, key derived from PLATFORM_SECRET and bound to the tenant).
//   It is opened inside a call, sent only as the bearer header, and never returned, logged or placed in an error (MR-ADP-3).
// - A create is sent once. An ambiguous outcome throws `outcome_unknown`; the caller reconciles with `lookup`, never a blind retry (MR-ADP-2).
import { decryptAuthenticated, deriveKek, encryptAuthenticated, type EncryptedEnvelope } from "@naelao/crypto";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { resolveOfferingAdmission, type OfferingAdmissionDb } from "@naelao/billing-core";
import { enrollNaelaoEmailInboxSubscription } from "../managed-email-billing.js";
import {
  ProviderAdapterError, capabilityUnsupported,
  type AuthorizedExecution, type CapabilityDescriptor, type Page, type DeprovisionReq, type ExecutionResult, type LookupReq, type OperationCtx,
  type ProviderAdapterV1, type ProviderResource, type ProvisionReq, type ProvisionResult,
} from "./contract.js";

export const NAELAO_EMAIL_PROVIDER = "naelao";
export const NAELAO_EMAIL_SERVICE_ID = "email";
/** Must match the verified capability version's operations (docs/operations/managed-offerings-seed.sql). */
export const NAELAO_EMAIL_OPERATIONS = ["provision", "deprovision", "lookup", "send", "read"] as const;

/** Billing-only operations of the same capability version (MS-40): admitted by Billing, never executed through the adapter. */
export const NAELAO_EMAIL_BILLING_OPERATIONS = ["renew", "usage"] as const;

const BASE = "https://naelao-email.internal";
/** Tenant ids this adapter creates are `naelao-<tenant>`; the inventory lists only those (AgentPort and direct tenants are not Managed resources). */
export const NAELAO_EMAIL_INVENTORY_TENANT_PREFIX = "naelao-";
const INVENTORY_TENANT = "naelao-inventory";
const INVENTORY_PAGE_SIZE = 200;
const KEY_SCOPES = ["inboxes:read", "inboxes:write", "messages:read", "messages:send", "usage:read"];

export interface NaelaoEmailAdapterEnv {
  MANAGED_OFFERINGS_ENABLED?: string;
  MANAGED_SUBSCRIPTIONS_ENABLED?: string;
  NAELAO_EMAIL?: Fetcher;
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
}

const nemailTenantId = (tenantId: string) => `naelao-${tenantId}`;
const KEY_AAD = (tenantId: string) => `naelao-email-api-key:${tenantId}`;

/** Removes anything that looks like a Naelao Email key, webhook secret or bearer credential from text that may reach an error. */
export function redactSecrets(text: string): string {
  return text.replace(/\bnem_[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\bwhsec_[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

interface Reply { status: number; body: Record<string, unknown> | null }

/** MS-40: the platform's own read of a Managed inbox's sent-message count (not part of the §8 contract). */
export interface NaelaoEmailAdapter extends ProviderAdapterV1 {
  usageForPeriod(req: { tenantId: string; provider_resource_ref: string; startMs: number; endMs: number }): Promise<{ sentCount: number }>;
  /** MS-41: pause or resume one Managed inbox's sending through the email worker's platform route. Only the subscription-suspension pause is touched. */
  setSendingPaused(req: { tenantId: string; provider_resource_ref: string; paused: boolean; reason?: "subscription_suspended" | "owner_suspended" }): Promise<{ sendingPaused: boolean }>;
}

export function createNaelaoEmailAdapter(env: NaelaoEmailAdapterEnv, now: () => Date = () => new Date()): NaelaoEmailAdapter {
  const enabled = () => {
    if (env.MANAGED_OFFERINGS_ENABLED !== "true") throw new ProviderAdapterError("offering_unavailable");
    if (!env.NAELAO_EMAIL) throw new ProviderAdapterError("provider_unavailable");
    return env.NAELAO_EMAIL;
  };

  async function raw(request: Request): Promise<Reply> {
    const service = enabled();
    let response: Response;
    try { response = await service.fetch(request); } catch { throw new ProviderAdapterError("outcome_unknown"); }
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = await readBoundedResponseJson<unknown>(response, 262_144);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { /* non-JSON body */ }
    return { status: response.status, body };
  }

  /** Throws a code-only error for an upstream refusal. Upstream text is redacted and truncated. */
  const refuse = (reply: Reply): never => {
    const code = typeof reply.body?.error_code === "string" ? reply.body.error_code.replace(/[^a-z0-9_]/gi, "").slice(0, 60) : "request_rejected";
    if (reply.status >= 500) throw new ProviderAdapterError("outcome_unknown", `upstream ${reply.status}`);
    const message = typeof reply.body?.message === "string" ? redactSecrets(reply.body.message).slice(0, 200) : undefined;
    throw new ProviderAdapterError(`naelao_email_${code}`, message);
  };

  async function apiKey(tenantId: string): Promise<string> {
    const read = async () => {
      const row = await env.PLATFORM_DB.prepare("SELECT key_envelope_json FROM managed_naelao_email_tenants WHERE tenant_id=?").bind(tenantId).first<{ key_envelope_json: string }>();
      if (!row) return null;
      try { return await decryptAuthenticated(JSON.parse(row.key_envelope_json) as EncryptedEnvelope, await deriveKek(env.PLATFORM_SECRET, tenantId), KEY_AAD(tenantId)); } catch { return null; }
    };
    const existing = await read();
    if (existing) return existing;
    const tenant = nemailTenantId(tenantId);
    const created = await raw(new Request(`${BASE}/internal/v1/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenant, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenant) },
      body: JSON.stringify({ org_id: tenantId, name: `Naelao ${tenantId}`.slice(0, 120), scopes: KEY_SCOPES }),
    }));
    const key = (created.body?.data as { api_key?: unknown } | undefined)?.api_key;
    if (created.status !== 201 || typeof key !== "string" || !key.startsWith("nem_")) {
      if (created.status === 409) { const again = await read(); if (again) return again; }
      throw new ProviderAdapterError("provider_unavailable");
    }
    const envelope = await encryptAuthenticated(key, await deriveKek(env.PLATFORM_SECRET, tenantId), KEY_AAD(tenantId));
    await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO managed_naelao_email_tenants(tenant_id,nemail_tenant_id,key_envelope_json,created_at) VALUES(?,?,?,?)")
      .bind(tenantId, tenant, JSON.stringify(envelope), now().toISOString()).run();
    const stored = await read();
    if (!stored) throw new ProviderAdapterError("provider_unavailable");
    return stored;
  }

  async function api(tenantId: string, method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<Reply> {
    const key = await apiKey(tenantId);
    return raw(new Request(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }));
  }

  const toResource = (data: Record<string, unknown>): ProviderResource => ({
    provider: NAELAO_EMAIL_PROVIDER, service_id: NAELAO_EMAIL_SERVICE_ID, resource_type: "inbox",
    provider_resource_ref: String(data.id), status: "active", ...(typeof data.address === "string" ? { address: data.address } : {}),
  });
  const refPath = (ref: string) => {
    if (!/^inb_[A-Za-z0-9_-]{1,80}$/.test(ref)) throw new ProviderAdapterError("invalid_resource_ref");
    return encodeURIComponent(ref);
  };
  const idem = (op: OperationCtx) => {
    if (!op?.operation_id || !/^[\x21-\x7e]{1,128}$/.test(op.idempotency_key ?? "")) throw new ProviderAdapterError("invalid_operation_context");
    return op.idempotency_key;
  };

  return {
    provider: NAELAO_EMAIL_PROVIDER,
    capabilities: (): CapabilityDescriptor[] => NAELAO_EMAIL_OPERATIONS.map(operation => ({ operation })),

    async provision(req: ProvisionReq, op: OperationCtx): Promise<ProvisionResult> {
      enabled();
      if (!req.tenantId || !req.reservationId || !/^[A-Za-z0-9._:-]{1,200}$/.test(req.reservationId)) throw new ProviderAdapterError("reservation_required");
      const key = idem(op);
      // MR-CAT-3 / MS-28: no provisioning without admission. Any refusal, and any admission error, fails closed before an upstream call.
      let admission;
      try {
        admission = await resolveOfferingAdmission(env.PLATFORM_DB as unknown as OfferingAdmissionDb, {
          tenantId: req.tenantId, provider: NAELAO_EMAIL_PROVIDER, serviceId: NAELAO_EMAIL_SERVICE_ID, operation: "provision",
          region: req.region, strategy: "first_party", now: now(), ...(req.offeringId ? { offeringId: req.offeringId } : {}),
        });
      } catch { throw new ProviderAdapterError("offering_unavailable"); }
      if (!admission.ok) throw new ProviderAdapterError(admission.error_code);
      // MS-40: with subscriptions on, a Managed inbox is never created without the billing scope to enroll it (no free inboxes).
      const subscribe = env.MANAGED_SUBSCRIPTIONS_ENABLED === "true";
      if (subscribe && (!req.spaceId || !req.userId)) throw new ProviderAdapterError("subscription_scope_required");
      const reply = await api(req.tenantId, "POST", "/v1/inboxes", {
        idempotencyKey: key,
        body: { ...(req.localPart ? { local_part: req.localPart } : {}), ...(req.displayName ? { display_name: req.displayName } : {}) },
      });
      const data = reply.body?.data as Record<string, unknown> | undefined;
      if (![200, 201].includes(reply.status)) return refuse(reply);
      if (typeof data?.id !== "string") throw new ProviderAdapterError("outcome_unknown");
      if (subscribe) {
        // INSERT OR IGNORE: a replay of the same provision re-enrolls nothing and repairs a missed enrollment.
        try {
          await enrollNaelaoEmailInboxSubscription(env.PLATFORM_DB, {
            tenantId: req.tenantId, inboxId: data.id, offeringId: admission.offering.id, chargeComponents: admission.offering.chargeComponents,
            spaceId: req.spaceId!, projectId: req.projectId ?? null, userId: req.userId!, region: req.region, now: now(),
          });
        } catch { throw new ProviderAdapterError("subscription_enrollment_failed"); }
      }
      return { resource: toResource(data), offering_id: admission.offering.id, capability_version: admission.capabilityVersion };
    },

    async usageForPeriod(req: { tenantId: string; provider_resource_ref: string; startMs: number; endMs: number }) {
      enabled();
      const ref = refPath(req.provider_resource_ref);
      const tenant = nemailTenantId(req.tenantId);
      const reply = await raw(new Request(`${BASE}/internal/v1/usage/period`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenant, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenant) },
        body: JSON.stringify({ inbox_id: decodeURIComponent(ref), start_ms: req.startMs, end_ms: req.endMs }),
      }));
      const count = (reply.body?.data as { sent_count?: unknown } | undefined)?.sent_count;
      if (reply.status !== 200 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return refuse(reply);
      return { sentCount: count };
    },

    async setSendingPaused(req: { tenantId: string; provider_resource_ref: string; paused: boolean; reason?: "subscription_suspended" | "owner_suspended" }) {
      enabled();
      const ref = refPath(req.provider_resource_ref);
      const tenant = nemailTenantId(req.tenantId);
      const reply = await raw(new Request(`${BASE}/internal/v1/inboxes/sending`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenant, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenant) },
        body: JSON.stringify({ inbox_id: decodeURIComponent(ref), paused: req.paused, ...(req.reason ? { reason: req.reason } : {}) }),
      }));
      const paused = (reply.body?.data as { sending_paused?: unknown } | undefined)?.sending_paused;
      if (reply.status !== 200 || typeof paused !== "boolean") return refuse(reply);
      return { sendingPaused: paused };
    },

    async lookup(req: LookupReq): Promise<ProviderResource | null> {
      enabled();
      const reply = await api(req.tenantId, "GET", `/v1/inboxes/${refPath(req.provider_resource_ref)}`);
      if (reply.status === 404) return null;
      const data = reply.body?.data as Record<string, unknown> | undefined;
      if (reply.status !== 200 || typeof data?.id !== "string") return refuse(reply);
      return toResource(data);
    },

    /** MS-38: read-only. Uses the platform HMAC inventory route (no tenant key is opened); never deletes anything. */
    async listUpstreamResources(cursor?: string): Promise<Page<ProviderResource>> {
      enabled();
      if (cursor !== undefined && !/^inb_[A-Za-z0-9_-]{1,80}$/.test(cursor)) throw new ProviderAdapterError("invalid_cursor");
      const reply = await raw(new Request(`${BASE}/internal/v1/inventory/inboxes`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": INVENTORY_TENANT, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, INVENTORY_TENANT) },
        body: JSON.stringify({ tenant_prefix: NAELAO_EMAIL_INVENTORY_TENANT_PREFIX, limit: INVENTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      }));
      const data = reply.body?.data as { items?: unknown; next_cursor?: unknown } | undefined;
      if (reply.status !== 200 || !Array.isArray(data?.items)) return refuse(reply);
      const items: ProviderResource[] = [];
      for (const item of data.items as Array<Record<string, unknown>>) {
        if (typeof item?.id !== "string" || !/^inb_[A-Za-z0-9_-]{1,80}$/.test(item.id)) throw new ProviderAdapterError("invalid_inventory_response");
        items.push({ ...toResource(item), status: item.status === "deleted" ? "deleted" : "active" });
      }
      const next = typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : undefined;
      return { items, ...(next ? { next_cursor: next } : {}) };
    },

    async deprovision(req: DeprovisionReq, op: OperationCtx): Promise<void> {
      enabled();
      idem(op);
      const reply = await api(req.tenantId, "DELETE", `/v1/inboxes/${refPath(req.provider_resource_ref)}`);
      // Already gone is success: deprovision is idempotent.
      if (reply.status !== 200 && reply.status !== 404) refuse(reply);
    },

    async execute(req: AuthorizedExecution, op: OperationCtx): Promise<ExecutionResult> {
      enabled();
      if (req.operation !== "send" && req.operation !== "read") throw capabilityUnsupported(String(req.operation));
      const key = idem(op);
      const ref = refPath(req.provider_resource_ref);
      const params = req.params ?? {};
      if (req.operation === "send") {
        const reply = await api(req.tenantId, "POST", `/v1/inboxes/${ref}/messages/send`, { idempotencyKey: key, body: params });
        if (reply.status !== 201) return refuse(reply);
        return { operation: "send", data: reply.body?.data ?? null };
      }
      const messageId = typeof params.message_id === "string" ? params.message_id : null;
      if (messageId !== null && !/^msg_[A-Za-z0-9_-]{1,80}$/.test(messageId)) throw new ProviderAdapterError("invalid_request");
      const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 100 ? `?limit=${params.limit}` : "";
      const reply = await api(req.tenantId, "GET", messageId ? `/v1/messages/${encodeURIComponent(messageId)}` : `/v1/inboxes/${ref}/messages${limit}`);
      if (reply.status !== 200) return refuse(reply);
      return { operation: "read", data: reply.body ?? null };
    },
  };
}
