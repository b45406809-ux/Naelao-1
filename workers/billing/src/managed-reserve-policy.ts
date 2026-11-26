// MS-29 / V-spec MD-6, MR-COM-1, MR-COM-3: quote and admission rules for
// POST /internal/managed-services/credits/reserve.
//
// Two rule sources produce the same `ReserveQuoteRules` shape:
//   - `resolveOfferingReserveRules` (MANAGED_OFFERINGS_ENABLED === "true"): provider-neutral. Admission and the
//     quote requirement come only from offering, capability and agreement rows (MS-28 admission).
//   - `legacyReserveQuoteRules` (flag off): the original hard-coded provider rules, kept verbatim so a disabled
//     flag changes nothing. Delete it once the owner accepts the flag; it is the only provider-literal code left.
//
// The reserve route itself contains no provider literals and only consumes `ReserveQuoteRules`.
import { resolveOfferingAdmission, type OfferingAdmissionDb, type OfferingAdmissionErrorCode, type ProvisioningStrategy } from "@naelao/billing-core";

export interface ReserveQuoteRules {
  /** A consumed quote bound to this operation must accompany the reservation. */
  quoteRequired: boolean;
  /** A quote-required, non-model operation must be priced exactly at the entitlement unless a pinned quote applies. */
  exactPriceWithoutModel: boolean;
  /** The quote must carry a request hash equal to the operation's (recurring-spend quotes). */
  quoteRequestHashRequired: boolean;
  /** When a quote carries a request hash it must equal the operation's (flag-on generalisation). */
  quoteRequestHashMustMatchWhenPresent: boolean;
  /** SQL predicate over aliases q (quote) and o (operation) for replaying a pinned, already-consumed quote. */
  pinnedQuoteBindingSql: string;
}

export type ReserveAdmissionResult =
  | { ok: true; rules: ReserveQuoteRules; offeringId: string; strategy: ProvisioningStrategy }
  | { ok: false; error_code: OfferingAdmissionErrorCode };

export interface ReserveAdmissionRequest {
  tenantId: string;
  provider: string;
  serviceId: string;
  operationName: string;
  region: string;
  now?: Date | number;
}

/**
 * A reserve call spends Naelao credits on a Naelao-managed resource. The request carries no strategy, so it is
 * derived from that fact: `customer_connection` (BYOK) never spends Naelao credits, `partner_direct` is deferred
 * (MD-12) and `native_subaccount` is a provider-billed mode, so the only strategies a Naelao-credit reservation can
 * run under are `first_party` and `managed_master`, tried in that order. The first that admission accepts wins.
 */
export const RESERVE_STRATEGY_CANDIDATES: readonly ProvisioningStrategy[] = ["first_party", "managed_master"];

/** Operations that create or extend a recurring charge. Names of operations, not providers. */
const RECURRING_OPERATIONS: readonly string[] = ["provision", "renew"];

const BOUND_QUOTE_SQL = "(q.request_sha256 IS NOT NULL AND o.request_sha256=q.request_sha256)";
const UNBOUND_QUOTE_SQL = "(q.request_sha256 IS NULL OR o.request_sha256=q.request_sha256)";

export function quoteRequiredByPolicy(quotePolicy: "none" | "required_for_recurring" | "always", operationName: string): boolean {
  if (quotePolicy === "always") return true;
  if (quotePolicy === "required_for_recurring") return RECURRING_OPERATIONS.includes(operationName);
  return false;
}

export function offeringReserveRules(quotePolicy: "none" | "required_for_recurring" | "always", operationName: string): ReserveQuoteRules {
  const quoteRequired = quoteRequiredByPolicy(quotePolicy, operationName);
  const bound = quoteRequired && quotePolicy === "required_for_recurring";
  return {
    quoteRequired,
    exactPriceWithoutModel: quoteRequired,
    quoteRequestHashRequired: bound,
    quoteRequestHashMustMatchWhenPresent: quoteRequired,
    pinnedQuoteBindingSql: bound ? BOUND_QUOTE_SQL : UNBOUND_QUOTE_SQL,
  };
}

export async function resolveOfferingReserveRules(db: OfferingAdmissionDb, request: ReserveAdmissionRequest): Promise<ReserveAdmissionResult> {
  let failure: OfferingAdmissionErrorCode = "offering_unavailable";
  for (const strategy of RESERVE_STRATEGY_CANDIDATES) {
    const admission = await resolveOfferingAdmission(db, {
      tenantId: request.tenantId, provider: request.provider, serviceId: request.serviceId,
      operation: request.operationName, region: request.region, strategy,
      ...(request.now === undefined ? {} : { now: request.now }),
    });
    if (admission.ok) {
      return { ok: true, rules: offeringReserveRules(admission.offering.quotePolicy, request.operationName), offeringId: admission.offering.id, strategy };
    }
    // Report the most specific refusal: any reason other than "no such offering" beats it.
    if (failure === "offering_unavailable") failure = admission.error_code;
  }
  return { ok: false, error_code: failure };
}

/** Flag-off rules: byte-for-byte the checks the route used before MS-29. */
export function legacyReserveQuoteRules(body: { provider?: string; service_id?: string; operation_name?: string } | null): ReserveQuoteRules {
  const modelOperationRequiresQuote = body?.provider === "cloudflare" && body?.service_id === "workers-ai";
  const agentMailOperationRequiresQuote = body?.provider === "agentmail" && body?.service_id === "agentmail"
    && (body?.operation_name === "provision" || body?.operation_name === "renew");
  return {
    quoteRequired: modelOperationRequiresQuote || agentMailOperationRequiresQuote,
    exactPriceWithoutModel: agentMailOperationRequiresQuote,
    quoteRequestHashRequired: agentMailOperationRequiresQuote,
    quoteRequestHashMustMatchWhenPresent: false,
    pinnedQuoteBindingSql: `((q.provider='agentmail' AND q.request_sha256 IS NOT NULL AND o.request_sha256=q.request_sha256)
          OR (q.provider='cloudflare' AND q.request_sha256 IS NULL))`,
  };
}
