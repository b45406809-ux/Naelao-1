// MS-37 / V-spec §9.2, §9.5, MR-COM-4/6/7/8: one provider-free quote creator driven by an offering's
// `charge_components_json`. Used behind MANAGED_OFFERINGS_ENABLED by the AgentMail and Workers AI quote paths; with the
// flag off those paths keep their original INSERT. Nothing here names a provider.
//
// A quote shows EVERY component of the offering and the minimum monthly cost (setup is one-off, `rental` is the
// mandatory recurring part, `usage` and `storage` are metered with a zero minimum). It is bound to tenant, offering,
// region, configuration sha256 and price_version, and expires in at most 15 minutes.
//
// Price authority: when an offering has no priced components yet (the operator seed leaves `[]` for AgentMail and
// Workers AI) the caller supplies the exact entitlement price Billing will demand at reserve time (`priceOverride`).
// Billing never sees components; it compares `credits`, `price_version` and `capability_version` on the stored row.
import { resolveOfferingAdmission, type AdmittedOffering, type OfferingAdmissionDb, type OfferingAdmissionErrorCode, type ProvisioningStrategy } from "@naelao/billing-core";
import type { AgentsEnv } from "../index.js";

export const MAX_QUOTE_TTL_MS = 15 * 60_000;
/** A naelao-credit reservation runs under one of these strategies (same order as the Billing reserve path). */
export const QUOTE_STRATEGY_CANDIDATES: readonly ProvisioningStrategy[] = ["first_party", "managed_master"];

export type QuoteErrorCode = OfferingAdmissionErrorCode | "quote_components_invalid" | "quote_no_charge" | "quote_ttl_invalid";
export class ManagedQuoteError extends Error {
  constructor(readonly code: QuoteErrorCode) { super(code); this.name = "ManagedQuoteError"; }
}

export const managedOfferingsEnabled = (env: { MANAGED_OFFERINGS_ENABLED?: string }) => env.MANAGED_OFFERINGS_ENABLED === "true";

export type QuoteComponent =
  | { kind: "setup"; credits: number }
  | { kind: "rental"; interval: "month" | "year"; credits: number; includedSends?: number }
  | { kind: "usage"; meter: string; included: number; unitQty: number; unitCredits: number }
  | { kind: "storage"; meter: string; included: number; unitQty: number; unitCredits: number };

export interface QuoteBreakdown {
  components: QuoteComponent[];
  /** Components that are always charged (setup, rental). Usage and storage are shown but metered. */
  mandatory: QuoteComponent[];
  setupCredits: number;
  /** Rental normalised to a month (yearly rental rounded up). Metered components contribute 0 to the minimum. */
  minMonthlyCredits: number;
  /** Credits due when the resource is created: setup plus the first rental period. */
  initialCredits: number;
}

const isCredits = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Parses §9.2 components strictly. Throws `quote_components_invalid` on anything unknown or malformed (fail closed). */
export function parseChargeComponents(raw: unknown): QuoteComponent[] {
  const invalid = () => new ManagedQuoteError("quote_components_invalid");
  if (!Array.isArray(raw)) throw invalid();
  const out: QuoteComponent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const c = entry as Record<string, unknown>;
    switch (c.kind) {
      case "setup":
        if (!isCredits(c.credits)) throw invalid();
        out.push({ kind: "setup", credits: c.credits });
        break;
      case "rental": {
        if ((c.interval !== "month" && c.interval !== "year") || !isCredits(c.credits)) throw invalid();
        const included = c.included_sends;
        if (included !== undefined && !isCredits(included)) throw invalid();
        out.push({ kind: "rental", interval: c.interval, credits: c.credits, ...(included === undefined ? {} : { includedSends: included }) });
        break;
      }
      case "usage":
      case "storage": {
        const per = c.unit_credits_per as Record<string, unknown> | undefined;
        if (typeof c.meter !== "string" || !c.meter || !isCredits(c.included) || !per || !isPositiveInt(per.qty) || !isCredits(per.credits)) throw invalid();
        out.push({ kind: c.kind, meter: c.meter, included: c.included, unitQty: per.qty, unitCredits: per.credits });
        break;
      }
      default: throw invalid();
    }
  }
  return out;
}

export function computeQuoteBreakdown(components: QuoteComponent[]): QuoteBreakdown {
  let setupCredits = 0, rentalMonthly = 0, rentalFirst = 0;
  for (const c of components) {
    if (c.kind === "setup") setupCredits += c.credits;
    if (c.kind === "rental") {
      rentalFirst += c.credits;
      rentalMonthly += c.interval === "year" ? Math.ceil(c.credits / 12) : c.credits;
    }
  }
  return {
    components,
    mandatory: components.filter((c) => c.kind === "setup" || c.kind === "rental"),
    setupCredits,
    minMonthlyCredits: rentalMonthly,
    initialCredits: setupCredits + rentalFirst,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 over canonical (key-sorted) JSON, so equal configurations hash equally whatever the key order. */
export const configurationSha256 = (configuration: unknown) => sha256Hex(canonicalJson(configuration));

/**
 * MR-COM-6: price_version of an offering's own components. A price change alters the components and therefore the
 * version; it never edits an old one.
 */
export async function offeringPriceVersion(offeringId: string, components: QuoteComponent[]): Promise<string> {
  return `${offeringId}@${(await sha256Hex(canonicalJson(components))).slice(0, 16)}`;
}

export interface OfferingQuoteInput {
  scope: { tenantId: string; spaceId: string; projectId?: string | null; userId: string };
  planTier: string;
  provider: string;
  serviceId: string;
  operationName: string;
  region: string;
  /** Pins the offering; without it the best admissible one by preference_rank is used. */
  offeringId?: string;
  modelId?: string | null;
  maxOutputTokens?: number | null;
  /** The exact request the quote authorises. Hashed into `configuration_sha256`. */
  configuration: unknown;
  /** Stored as `request_sha256` when the caller binds operations by request hash (recurring-spend quotes). */
  requestSha256?: string | null;
  /** Entitlement price Billing will demand. Without it the price comes from the offering's components. */
  priceOverride?: { credits: number; priceVersion: string; capabilityVersion: number };
  renewal?: { credits: number; priceVersion: string; capabilityVersion: number; maxCreditsPerOperation: number } | null;
  ttlMs?: number;
  now?: Date;
}

export interface OfferingQuote {
  quoteId: string;
  offeringId: string;
  provider: string;
  serviceId: string;
  operationName: string;
  region: string;
  credits: number;
  creditUnit: "naelao_credit";
  priceVersion: string;
  capabilityVersion: number;
  configurationSha256: string;
  components: QuoteComponent[];
  mandatoryComponents: QuoteComponent[];
  minMonthlyCredits: number;
  status: "quoted";
  expiresAt: string;
}

export async function createOfferingQuote(env: Pick<AgentsEnv, "PLATFORM_DB">, input: OfferingQuoteInput): Promise<OfferingQuote> {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? MAX_QUOTE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > MAX_QUOTE_TTL_MS) throw new ManagedQuoteError("quote_ttl_invalid");

  let failure: OfferingAdmissionErrorCode = "offering_unavailable";
  let admitted: { offering: AdmittedOffering; capabilityVersion: number } | null = null;
  for (const strategy of QUOTE_STRATEGY_CANDIDATES) {
    const admission = await resolveOfferingAdmission(env.PLATFORM_DB as unknown as OfferingAdmissionDb, {
      tenantId: input.scope.tenantId, provider: input.provider, serviceId: input.serviceId, operation: input.operationName,
      region: input.region, strategy, now, ...(input.offeringId ? { offeringId: input.offeringId } : {}),
    });
    if (admission.ok) { admitted = { offering: admission.offering, capabilityVersion: admission.capabilityVersion }; break; }
    if (failure === "offering_unavailable") failure = admission.error_code;
  }
  if (!admitted) throw new ManagedQuoteError(failure);

  const components = parseChargeComponents(admitted.offering.chargeComponents);
  const breakdown = computeQuoteBreakdown(components);
  const credits = input.priceOverride?.credits ?? breakdown.initialCredits;
  if (!isPositiveInt(credits)) throw new ManagedQuoteError("quote_no_charge");
  const priceVersion = input.priceOverride?.priceVersion ?? await offeringPriceVersion(admitted.offering.id, components);
  const capabilityVersion = input.priceOverride?.capabilityVersion ?? admitted.capabilityVersion;
  const configHash = await configurationSha256(input.configuration);
  const quoteId = `msq_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  const renewal = input.renewal ?? null;
  await env.PLATFORM_DB.prepare(`INSERT INTO managed_service_operation_quotes(
    quote_id,tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,service_id,operation_name,model_id,region,
    capability_version,price_version,credits,max_output_tokens,request_sha256,renewal_credits,renewal_price_version,
    renewal_capability_version,renewal_max_credits_per_operation,status,expires_at,created_at,
    offering_id,configuration_sha256,charge_components_json,min_monthly_credits)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'quoted',?,?,?,?,?,?)`)
    .bind(quoteId, input.scope.tenantId, input.scope.spaceId, input.scope.projectId ?? null, input.scope.userId, input.planTier,
      input.provider, input.serviceId, input.operationName, input.modelId ?? null, input.region, capabilityVersion, priceVersion, credits,
      input.maxOutputTokens ?? null, input.requestSha256 ?? null, renewal?.credits ?? null, renewal?.priceVersion ?? null,
      renewal?.capabilityVersion ?? null, renewal?.maxCreditsPerOperation ?? null, expiresAt, now.toISOString(),
      admitted.offering.id, configHash, JSON.stringify(components), breakdown.minMonthlyCredits).run();
  return {
    quoteId, offeringId: admitted.offering.id, provider: input.provider, serviceId: input.serviceId, operationName: input.operationName,
    region: input.region, credits, creditUnit: "naelao_credit", priceVersion, capabilityVersion, configurationSha256: configHash,
    components, mandatoryComponents: breakdown.mandatory, minMonthlyCredits: breakdown.minMonthlyCredits, status: "quoted", expiresAt,
  };
}

export type QuoteVerifyErrorCode = "quote_not_found" | "quote_binding_mismatch" | "quote_expired" | "quote_price_changed" | "quote_already_used";
export type QuoteVerification = { ok: true; quoteId: string; credits: number; priceVersion: string } | { ok: false; error_code: QuoteVerifyErrorCode };

export interface QuoteExpectation {
  tenantId: string;
  offeringId: string;
  region: string;
  configuration: unknown;
  /** The price_version in force now. A quote made under another version is refused (MR-COM-8). */
  priceVersion: string;
  now?: Date;
}

/**
 * Read-only check of an offering-bound quote before provisioning. Order: unknown or foreign quote, binding mismatch
 * (offering, region, configuration), expiry, price change, already used. Refusals never reveal another tenant's quote.
 */
export async function verifyOfferingQuote(env: Pick<AgentsEnv, "PLATFORM_DB">, quoteId: string, expected: QuoteExpectation): Promise<QuoteVerification> {
  const fail = (error_code: QuoteVerifyErrorCode): QuoteVerification => ({ ok: false, error_code });
  const quote = await env.PLATFORM_DB.prepare(`SELECT tenant_id,offering_id,region,configuration_sha256,price_version,credits,status,expires_at
    FROM managed_service_operation_quotes WHERE quote_id=?`).bind(quoteId)
    .first<{ tenant_id: string; offering_id: string | null; region: string; configuration_sha256: string | null; price_version: string; credits: number; status: string; expires_at: string }>();
  if (!quote || quote.tenant_id !== expected.tenantId || quote.offering_id === null) return fail("quote_not_found");
  if (quote.offering_id !== expected.offeringId || quote.region !== expected.region
    || quote.configuration_sha256 !== await configurationSha256(expected.configuration)) return fail("quote_binding_mismatch");
  if (Date.parse(quote.expires_at) <= (expected.now ?? new Date()).getTime()) return fail("quote_expired");
  if (quote.price_version !== expected.priceVersion) return fail("quote_price_changed");
  if (quote.status !== "quoted") return fail("quote_already_used");
  return { ok: true, quoteId, credits: quote.credits, priceVersion: quote.price_version };
}
