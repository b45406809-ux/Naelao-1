// MS-46 / V-spec MD-9 and MR-EVT-1..6: one provider-event module. Each provider supplies `verifyWebhook` and `normalizeWebhook`.
// Verification runs on the raw bytes before anything is parsed; normalization yields a canonical references-only event.

export type HeaderBag = Headers | Record<string, string | undefined>;

export function headerValue(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const bag = headers as Record<string, string | undefined>;
  const key = Object.keys(bag).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : bag[key] ?? null;
}

export interface VerifyWebhookInput {
  rawBody: string;
  headers: HeaderBag;
  /** Telnyx: the account public key. Meta: the app secret. AgentMail: the svix `whsec_` secret. */
  secret: string;
  nowSeconds?: number;
}

export interface NormalizedProviderEvent {
  /** Upstream event id, or a sha256 of the body when the provider has none (MR-EVT-2). */
  eventId: string;
  eventType: string;
  occurredAt: string;
  /** The provider's own resource reference (`provider_resource_ref`), used to resolve the tenant. Null when the payload has none. */
  resourceRef: string | null;
  /** References only, never message bodies (MR-EVT-4). */
  data: Record<string, string>;
}

export interface ProviderEventAdapter {
  provider: string;
  verifyWebhook(input: VerifyWebhookInput): Promise<boolean>;
  /** Returns null for an unusable or irrelevant payload. Must only be called after `verifyWebhook` returned true. */
  normalizeWebhook(rawBody: string): Promise<NormalizedProviderEvent | null>;
}

/** MR-EVT-4 canonical envelope. */
export interface ProviderEventEnvelope {
  id: string;
  type: string;
  version: 1;
  tenant_id: string;
  resource_id: string;
  provider: string;
  occurred_at: string;
  data: Record<string, string>;
}

export interface ProviderEventModuleEnv { PROVIDER_EVENT_MODULE_ENABLED?: string }
export const providerEventModuleEnabled = (env: ProviderEventModuleEnv) => env.PROVIDER_EVENT_MODULE_ENABLED === "true";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
