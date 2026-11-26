import { claimProviderEvent, deadLetterProviderEvent, releaseProviderEvent, resolveProviderResource, type ResolvedResource } from "./store.js";
import { sha256Hex, type HeaderBag, type ProviderEventAdapter, type ProviderEventEnvelope } from "./types.js";

export type IngestOutcome = "unauthorized" | "invalid" | "ignored" | "dead_lettered" | "duplicate" | "delivered" | "failed";
export interface IngestResult { outcome: IngestOutcome; status: number; envelope?: ProviderEventEnvelope }

/** The generic gateway: verify (401, nothing parsed or logged from the body) -> normalize -> resolve tenant from the resource
 * (unknown or ambiguous: dead-letter, 202) -> dedup before side effects -> deliver the references-only envelope.
 * `deliver` is the fan-out (AgentPort events, then the existing wake path, which re-checks the grant). A thrown error releases the claim. */
export async function ingestProviderEvent(env: { PLATFORM_DB: D1Database }, adapter: ProviderEventAdapter, input: {
  rawBody: string; headers: HeaderBag; secret: string;
  resolveResource?: (resourceRef: string) => Promise<ResolvedResource | null>;
  deliver(envelope: ProviderEventEnvelope, resource: ResolvedResource): Promise<void>;
}): Promise<IngestResult> {
  if (!await adapter.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, secret: input.secret })) return { outcome: "unauthorized", status: 401 };
  const event = await adapter.normalizeWebhook(input.rawBody);
  if (!event) return { outcome: "ignored", status: 204 };
  const eventId = event.eventId || await sha256Hex(input.rawBody);
  const resource = event.resourceRef ? await (input.resolveResource ?? ((ref: string) => resolveProviderResource(env.PLATFORM_DB, adapter.provider, ref)))(event.resourceRef) : null;
  if (!resource) {
    await deadLetterProviderEvent(env.PLATFORM_DB, { provider: adapter.provider, eventId, eventType: event.eventType, resourceRef: event.resourceRef,
      reason: event.resourceRef ? "unknown_resource" : "missing_resource_ref", rawBody: input.rawBody });
    return { outcome: "dead_lettered", status: 202 };
  }
  if (!await claimProviderEvent(env.PLATFORM_DB, adapter.provider, eventId, event.eventType)) return { outcome: "duplicate", status: 204 };
  const envelope: ProviderEventEnvelope = { id: eventId, type: event.eventType, version: 1, tenant_id: resource.tenantId, resource_id: resource.resourceId,
    provider: adapter.provider, occurred_at: event.occurredAt, data: event.data };
  try { await input.deliver(envelope, resource); }
  catch {
    await releaseProviderEvent(env.PLATFORM_DB, adapter.provider, eventId, event.eventType).catch(() => undefined);
    return { outcome: "failed", status: 503, envelope };
  }
  return { outcome: "delivered", status: 204, envelope };
}
