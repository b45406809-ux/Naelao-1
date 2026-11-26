import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";

type ManagedServiceCreditRequest = {
  reservationId: string;
  operationId: string;
  provider: string;
  serviceId: string;
  operationName: string;
  modelId?:string;
  region: string;
  credits: number;
  priceVersion: string;
  quoteId?: string;
  payerMandateId?:string;
  agentPortAgentId?:string;
  /** MS-41: user-initiated spends compose the Project daily spend cap (flag MANAGED_LIMITS_COMPOSED_ENABLED). Renewals and sweeps leave it off. */
  enforceProjectSpend?: boolean;
};

async function postCredits(
  env: AgentsEnv,
  scope: CommunicationScope,
  action: "reserve" | "uncertain" | "settle" | "release",
  body: Record<string, unknown>,
) {
  if (!env.BILLING_WORKER) throw new Error("managed_service_billing_unavailable");
  const response = await env.BILLING_WORKER.fetch(
    new Request(`http://billing-worker/internal/managed-services/credits/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": scope.tenantId,
        "x-naelao-internal-token": await mintInternalToken(
          env.PLATFORM_SECRET,
          scope.tenantId,
        ),
      },
      body: JSON.stringify(body),
    }),
  );
  const result = await readBoundedResponseJson<Record<string, unknown>>(
    response,
    16_384,
  );
  if (!response.ok) {
    const code = typeof result.error_code === "string" ? result.error_code : "request_rejected";
    throw new Error(`managed_service_billing_${code}`);
  }
  return result;
}

type ComposedLimit = { kind: "project_spend"; scope_key: string; headroom_credits: number };

/**
 * MS-41 / MR-COM-10: the Project daily spend cap lives in the Spaces DO. Headroom is cap minus spent and reserved there
 * (Billing subtracts its own managed reservations carrying the same scope_key inside the reserve INSERT). Fails closed with a
 * billing-shaped error when the cap cannot be read. Returns null when the Project has no cap.
 */
export async function projectSpendComposedLimit(env: AgentsEnv, scope: CommunicationScope): Promise<ComposedLimit | null> {
  if (!scope.projectId) return null;
  if (!env.SPACES_WORKER) throw new Error("managed_service_billing_limit_unavailable");
  let body: { day?: unknown; cap?: unknown; spent_plus_reserved?: unknown };
  try {
    const response = await env.SPACES_WORKER.fetch(new Request(
      `http://spaces-worker/spaces/${encodeURIComponent(scope.spaceId)}/projects/${encodeURIComponent(scope.projectId)}/spend`,
      { method: "GET", headers: { "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) } }));
    if (!response.ok) throw new Error("spend_unreadable");
    body = await readBoundedResponseJson<typeof body>(response, 4096);
  } catch { throw new Error("managed_service_billing_limit_unavailable"); }
  if (typeof body.cap !== "number" || typeof body.spent_plus_reserved !== "number" || typeof body.day !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(body.day)) {
    throw new Error("managed_service_billing_limit_unavailable");
  }
  if (body.cap <= 0) return null;
  const headroom = Math.min(10_000_000, Math.max(0, Math.floor(body.cap - body.spent_plus_reserved)));
  return { kind: "project_spend", scope_key: `${scope.projectId}:${body.day}`, headroom_credits: headroom };
}

export async function reserveManagedServiceCredits(
  env: AgentsEnv,
  scope: CommunicationScope,
  request: ManagedServiceCreditRequest,
) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(request.reservationId)
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(request.operationId)
    || (request.modelId!==undefined&&!/^@?[A-Za-z0-9][A-Za-z0-9@._:/-]{0,198}$/.test(request.modelId))
    || (request.quoteId!==undefined&&!/^msq_[A-Fa-f0-9]{32}$/.test(request.quoteId))
    || (request.modelId!==undefined&&request.quoteId===undefined)
    || (request.provider==="agentmail"&&request.serviceId==="agentmail"&&(request.operationName==="provision"||request.operationName==="renew")&&request.quoteId===undefined)
    || (request.payerMandateId!==undefined&&!/^[A-Za-z0-9._:-]{1,200}$/.test(request.payerMandateId))
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.region)
    || (request.agentPortAgentId!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.agentPortAgentId))
    || !Number.isSafeInteger(request.credits)
    || request.credits < 1
    || request.credits > 10_000_000) {
    throw new Error("managed_service_reservation_invalid");
  }
  const limit = env.MANAGED_LIMITS_COMPOSED_ENABLED === "true" && request.enforceProjectSpend ? await projectSpendComposedLimit(env, scope) : null;
  return postCredits(env, scope, "reserve", {
    ...(limit ? { composed_limits: [limit] } : {}),
    reservation_id: request.reservationId,
    operation_id: request.operationId,
    space_id: scope.spaceId,
    ...(scope.projectId ? { project_id: scope.projectId } : {}),
    provider: request.provider,
    service_id: request.serviceId,
    operation_name: request.operationName,
    ...(request.modelId?{model_id:request.modelId}:{}),
    region: request.region,
    payer_type: "organization",
    payer_id: scope.tenantId,
    ...(request.agentPortAgentId?{agentport_agent_id:request.agentPortAgentId}:{}),
    credits: request.credits,
    price_version: request.priceVersion,
    ...(request.quoteId ? { quote_id: request.quoteId } : {}),
    ...(request.quoteId ? { requester_user_id: scope.userId } : {}),
    ...(request.payerMandateId?{payer_mandate_id:request.payerMandateId}:{}),
    expires_in_seconds: 172_800,
  });
}

export function markManagedServiceCreditsUncertain(
  env: AgentsEnv,
  scope: CommunicationScope,
  reservationId: string,
) {
  return postCredits(env, scope, "uncertain", { reservation_id: reservationId });
}

export function settleManagedServiceCredits(
  env: AgentsEnv,
  scope: CommunicationScope,
  reservationId: string,
  credits: number,
) {
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 10_000_000) {
    throw new Error("managed_service_settlement_invalid");
  }
  return postCredits(env, scope, "settle", {
    reservation_id: reservationId,
    credits,
  });
}

export function releaseManagedServiceCredits(
  env: AgentsEnv,
  scope: CommunicationScope,
  reservationId: string,
  outcome?: "no_effect",
) {
  return postCredits(env, scope, "release", {
    reservation_id: reservationId,
    ...(outcome ? { outcome } : {}),
  });
}
