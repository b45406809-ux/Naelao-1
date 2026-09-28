import type { BillingEnv } from "./index.js";
import { mintInternalToken } from "@naelao/http";

export const MINIMUM_OPERATIONAL_BUFFER_CENTS = 1_000;

/** Post a revenue/expense settlement to the owning SpaceDO's authoritative ledger. */
export async function settleSpaceWallet(env: BillingEnv, tenantId: string, input: {
  space_id: string; amount_cents: number; type: "revenue" | "expense"; source: string; idempotency_key?: string;
}): Promise<Response> {
  if (!env.SPACES_WORKER) return Response.json({ error_code: "unavailable" }, { status: 503 });
  return env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/business-wallet/settle", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify(input),
  }));
}

/** Reserve funds and log the payout before a provider withdrawal is dispatched. */
export async function reserveOwnerPayout(env: BillingEnv, tenantId: string, input: {
  space_id: string; amount_cents: number; requested_by: string; destination_id?: string;
}): Promise<Response> {
  if (!env.SPACES_WORKER) return Response.json({ error_code: "unavailable" }, { status: 503 });
  return env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/business-wallet/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify(input),
  }));
}
