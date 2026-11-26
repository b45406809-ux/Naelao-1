import { describe, expect, it, vi } from "vitest";
import { fixture, enableProviderEventModuleFixture } from "../../../../../tests/fixtures/assistant-communications.js";
import { ingestProviderEvent, type ProviderEventAdapter } from "./index.js";

// MS-49: the route-facing parts of the gateway (grant gate, route response pass-through, release on failure, one signed body).
const adapter = (verified = true): ProviderEventAdapter => ({ provider: "agentmail", verifyWebhook: vi.fn(async () => verified),
  normalizeWebhook: async () => ({ eventId: "evt-1", eventType: "message.received", occurredAt: "t", resourceRef: "inbox-1", data: { message_id: "m1" } }) });
const resolveResource = async () => ({ resourceId: "res-1", tenantId: "tenant" });
function harness() { const f = fixture(); enableProviderEventModuleFixture(f.db, f.env); return f; }
const claims = async (f: ReturnType<typeof fixture>) => (await f.db.prepare("SELECT COUNT(*) n FROM processed_webhook_events").first<{ n: number }>())!.n;

describe("ingestProviderEvent route support (MS-49)", () => {
  it("a revoked grant is acknowledged before the claim and before any delivery", async () => {
    const f = harness(); const deliver = vi.fn(async () => undefined);
    const result = await ingestProviderEvent(f.env, adapter(), { rawBody: "{}", headers: {}, secret: "s", resolveResource, grantActive: async () => false, deliver });
    expect(result).toMatchObject({ outcome: "grant_revoked", status: 204, envelope: { tenant_id: "tenant", resource_id: "res-1" } });
    expect(deliver).not.toHaveBeenCalled(); expect(await claims(f)).toBe(0);
  });
  it("an active grant is checked with the canonical envelope and the event is delivered and claimed once", async () => {
    const f = harness(); const grantActive = vi.fn(async () => true); const deliver = vi.fn(async () => ({ response: new Response("{}", { status: 200 }) }));
    const first = await ingestProviderEvent(f.env, adapter(), { rawBody: "{}", headers: {}, secret: "s", resolveResource, grantActive, deliver });
    expect(first).toMatchObject({ outcome: "delivered", status: 200 }); expect(first.response?.status).toBe(200);
    expect(grantActive.mock.calls[0]![0]).toMatchObject({ id: "evt-1", version: 1, tenant_id: "tenant", data: { message_id: "m1" } });
    expect((await ingestProviderEvent(f.env, adapter(), { rawBody: "{}", headers: {}, secret: "s", resolveResource, deliver })).outcome).toBe("duplicate");
    expect(deliver).toHaveBeenCalledTimes(1); expect(await claims(f)).toBe(1);
  });
  it("a non-2xx route response or a release request un-claims the event and the response is passed back unchanged", async () => {
    const f = harness();
    const failed = await ingestProviderEvent(f.env, adapter(), { rawBody: "{}", headers: {}, secret: "s", resolveResource, deliver: async () => ({ response: new Response("x", { status: 409 }) }) });
    expect(failed).toMatchObject({ outcome: "failed", status: 409 }); expect(failed.response?.status).toBe(409); expect(await claims(f)).toBe(0);
    const skipped = await ingestProviderEvent(f.env, adapter(), { rawBody: "{}", headers: {}, secret: "s", resolveResource, deliver: async () => ({ release: true }) });
    expect(skipped.outcome).toBe("failed"); expect(await claims(f)).toBe(0);
  });
  it("a thrown delivery error is returned for the route to rethrow, and the claim is released", async () => {
    const f = harness(); const boom = new Error("boom");
    const result = await ingestProviderEvent(f.env, adapter(), { rawBody: "{}", headers: {}, secret: "s", resolveResource, deliver: async () => { throw boom; } });
    expect(result).toMatchObject({ outcome: "failed", status: 503, error: boom }); expect(await claims(f)).toBe(0);
  });
  it("alreadyVerified skips only the signature call; a forged body is still refused when it is not set", async () => {
    const f = harness(); const bad = adapter(false); const deliver = vi.fn(async () => undefined);
    expect((await ingestProviderEvent(f.env, bad, { rawBody: "{}", headers: {}, secret: "s", resolveResource, deliver })).outcome).toBe("unauthorized");
    expect((await ingestProviderEvent(f.env, bad, { rawBody: "{}", headers: {}, secret: "s", alreadyVerified: true, resolveResource, deliver })).outcome).toBe("delivered");
    expect(bad.verifyWebhook).toHaveBeenCalledTimes(1);
  });
});
