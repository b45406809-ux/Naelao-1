import { claimProviderEvent, deadLetterProviderEvent, releaseProviderEvent, resolveProviderResource, type ResolvedResource } from "./store.js";
import { sha256Hex, type HeaderBag, type ProviderEventAdapter, type ProviderEventEnvelope } from "./types.js";

export type IngestOutcome = "unauthorized" | "invalid" | "ignored" | "dead_lettered" | "duplicate" | "grant_revoked" | "delivered" | "failed";
export interface IngestResult {
  outcome: IngestOutcome; status: number; envelope?: ProviderEventEnvelope;
  /** The route's own response, when `deliver` produced one (MS-49: routes keep their provider-facing status codes). */
  response?: Response;
  /** The error `deliver` threw. The claim is already released; a route that used to let the error propagate rethrows it. */
  error?: unknown;
}
/** `deliver` may return a response to hand back unchanged. `release: true` (or a non-2xx response) un-claims the event so the provider's retry is processed. */
export type DeliverResult = void | { response?: Response; release?: boolean };

/** The generic gateway: verify (401, nothing parsed or logged from the body) -> normalize -> resolve tenant from the resource
 * (unknown or ambiguous: dead-letter, 202) -> dedup before side effects -> deliver the references-only envelope.
 * `deliver` is the fan-out (AgentPort events, then the existing wake path, which re-checks the grant). A thrown error releases the claim. */
export async function ingestProviderEvent(env: { PLATFORM_DB: D1Database }, adapter: ProviderEventAdapter, input: {
  rawBody: string; headers: HeaderBag; secret: string;
  resolveResource?: (resourceRef: string) => Promise<ResolvedResource | null>;
  /** MR-EVT-5: re-checked before the claim and so before any wake. False acknowledges the event (204) without delivering it. */
  grantActive?: (envelope: ProviderEventEnvelope, resource: ResolvedResource) => Promise<boolean>;
  /** Only for a route that already verified these exact bytes with the adapter's own verifier in this request (one signed body, several events). */
  alreadyVerified?: boolean;
  deliver(envelope: ProviderEventEnvelope, resource: ResolvedResource): Promise<DeliverResult>;
}): Promise<IngestResult> {
  if (!input.alreadyVerified && !await adapter.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, secret: input.secret })) return { outcome: "unauthorized", status: 401 };
  const event = await adapter.normalizeWebhook(input.rawBody);
  if (!event) return { outcome: "ignored", status: 204 };
  const eventId = event.eventId || await sha256Hex(input.rawBody);
  const resource = event.resourceRef ? await (input.resolveResource ?? ((ref: string) => resolveProviderResource(env.PLATFORM_DB, adapter.provider, ref)))(event.resourceRef) : null;
  if (!resource) {
    await deadLetterProviderEvent(env.PLATFORM_DB, { provider: adapter.provider, eventId, eventType: event.eventType, resourceRef: event.resourceRef,
      reason: event.resourceRef ? "unknown_resource" : "missing_resource_ref", rawBody: input.rawBody });
    return { outcome: "dead_lettered", status: 202 };
  }
  const envelope: ProviderEventEnvelope = { id: eventId, type: event.eventType, version: 1, tenant_id: resource.tenantId, resource_id: resource.resourceId,
    provider: adapter.provider, occurred_at: event.occurredAt, data: event.data };
  if (input.grantActive && !await input.grantActive(envelope, resource)) return { outcome: "grant_revoked", status: 204, envelope };
  if (!await claimProviderEvent(env.PLATFORM_DB, adapter.provider, eventId, event.eventType)) return { outcome: "duplicate", status: 204, envelope };
  const release = () => releaseProviderEvent(env.PLATFORM_DB, adapter.provider, eventId, event.eventType).catch(() => undefined);
  let delivered: DeliverResult;
  try { delivered = await input.deliver(envelope, resource); }
  catch (error) {
    await release();
    return { outcome: "failed", status: 503, envelope, error };
  }
  const response = delivered?.response;
  if (delivered?.release || (response && !response.ok)) {
    await release();
    return { outcome: "failed", status: response?.status ?? 503, envelope, ...(response ? { response } : {}) };
  }
  return { outcome: "delivered", status: response?.status ?? 204, envelope, ...(response ? { response } : {}) };
}
