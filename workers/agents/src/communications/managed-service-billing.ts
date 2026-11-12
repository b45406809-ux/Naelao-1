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
  payerMandateId?:string;
  agentPortAgentId?:string;
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

export function reserveManagedServiceCredits(
  env: AgentsEnv,
  scope: CommunicationScope,
  request: ManagedServiceCreditRequest,
) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(request.reservationId)
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(request.operationId)
    || (request.modelId!==undefined&&!/^@?[A-Za-z0-9][A-Za-z0-9@._:/-]{0,198}$/.test(request.modelId))
    || (request.payerMandateId!==undefined&&!/^[A-Za-z0-9._:-]{1,200}$/.test(request.payerMandateId))
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.region)
    || (request.agentPortAgentId!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.agentPortAgentId))
    || !Number.isSafeInteger(request.credits)
    || request.credits < 1
    || request.credits > 10_000_000) {
    throw new Error("managed_service_reservation_invalid");
  }
  return postCredits(env, scope, "reserve", {
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
