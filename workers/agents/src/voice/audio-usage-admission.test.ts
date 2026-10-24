import { describe, expect, it, vi } from "vitest";
import { createVoiceAudioAdmission, type VoiceUsageRecord } from "./audio-usage-admission.js";

function fixture() {
  const values = new Map<string, unknown>();
  const journal = {
    get: vi.fn(async <T>(key: string) => values.get(key) as T | undefined),
    put: vi.fn(async <T>(key: string, value: T) => { values.set(key, value); }),
    list: vi.fn(async <T>({ prefix }: { prefix: string }) => new Map([...values.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][])),
  };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const billingWorker = { fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname.split("/").at(-1)!;
    requests.push({ path, body: await request.json() as Record<string, unknown> });
    return Response.json(path === "reserve" ? { reserved: true } : { settled: true });
  }) } as unknown as Fetcher;
  const admission = createVoiceAudioAdmission({ tenantId: "tenant", spaceId: "space", callId: "call-1", secret: "secret", billingWorker, maxCostUsd: 1,
    journal, stillAllowed: async () => true, resolveGeneration: async () => ({ costUsd: 0.02, tokens: 20 }) });
  return { admission, journal, requests, values };
}

describe("durable voice usage admission", () => {
  it("reserves plan tokens before egress and settles actual provider usage exactly once", async () => {
    const f = fixture();
    const reservation = await f.admission.authorize({ model: "openrouter/stt", operation: "transcription", requestId: "turn-1", inputBytes: 1000, estimatedTokens: 500, estimatedCostUsd: 0.01 });
    expect(f.requests[0]).toMatchObject({ path: "reserve", body: { space_id: "space", estimated_tokens: 500, expires_in_seconds: 2_592_000 } });
    await reservation.settle(0.02, undefined, 42);
    expect(f.requests[1]).toMatchObject({ path: "settle", body: { actual_tokens: 42, model_id: "openrouter/stt", cost_credits: 3 } });
    const row = [...f.values.values()].at(0) as VoiceUsageRecord;
    expect(row.state).toBe("settled");
    await reservation.settle(0.02, undefined, 42);
    expect(f.requests.filter(request => request.path === "settle")).toHaveLength(1);
  });

  it("retains and reconciles known generation ids after the stream disconnects", async () => {
    const f = fixture();
    const reservation = await f.admission.authorize({ model: "openrouter/tts", operation: "speech", requestId: "turn-2", inputBytes: 50, inputCharacters: 12, estimatedTokens: 256, estimatedCostUsd: 0.01 });
    await reservation.pending("generation-1");
    const result = await f.admission.reconcile();
    expect(result).toEqual({ settled: 1, unresolved: 0 });
    expect(f.requests.at(-1)).toMatchObject({ path: "settle", body: { actual_tokens: 20, model_id: "openrouter/tts" } });
  });

  it("keeps provider outcomes without a generation id unresolved and denied calls never reserve", async () => {
    const f = fixture();
    const denied = createVoiceAudioAdmission({ tenantId: "t", spaceId: "s", callId: "c", secret: "x", billingWorker: { fetch: vi.fn() } as unknown as Fetcher, maxCostUsd: 1,
      journal: f.journal, stillAllowed: async () => false });
    await expect(denied.authorize({ model: "m", operation: "speech", requestId: "denied", inputBytes: 1, estimatedTokens: 1, estimatedCostUsd: 0.001 })).rejects.toThrow("voice_access_revoked");
    expect(f.requests).toHaveLength(0);
    const reservation = await f.admission.authorize({ model: "m", operation: "speech", requestId: "turn-3", inputBytes: 1, estimatedTokens: 1, estimatedCostUsd: 0.001 });
    await reservation.pending();
    expect(await f.admission.reconcile()).toEqual({ settled: 0, unresolved: 1 });
  });

  it("enforces the durable per-call USD ceiling before a provider request", async () => {
    const f = fixture();
    const billingWorker = { fetch: vi.fn(async (request: Request) => { f.requests.push({ path: "reserve", body: await request.json() as Record<string, unknown> }); return Response.json({ reserved: true }); }) } as unknown as Fetcher;
    const admission = createVoiceAudioAdmission({ tenantId: "t", spaceId: "s", callId: "c", secret: "x", billingWorker,
      maxCostUsd: 0.02, journal: f.journal, stillAllowed: async () => true });
    await admission.authorize({ model: "m", operation: "speech", requestId: "one", inputBytes: 1, estimatedTokens: 10, estimatedCostUsd: 0.015 });
    await expect(admission.authorize({ model: "m", operation: "speech", requestId: "two", inputBytes: 1, estimatedTokens: 10, estimatedCostUsd: 0.01 })).rejects.toThrow("voice_call_cost_limit_reached");
  });
  it("counts provider-confirmed cost while settlement is retrying", async () => {
    const f = fixture();
    f.values.set("voice-audio:c:previous", { requestId: "previous", runId: "previous", model: "m", operation: "speech", estimatedTokens: 1, estimatedCostUsd: 0.01, costUsd: 0.04, actualTokens: 1, state: "settle_retry", updatedAt: Date.now() } satisfies VoiceUsageRecord);
    const admission = createVoiceAudioAdmission({ tenantId: "t", spaceId: "s", callId: "c", secret: "x", billingWorker: { fetch: vi.fn(async () => Response.json({ reserved: true })) } as unknown as Fetcher,
      maxCostUsd: 0.05, journal: f.journal, stillAllowed: async () => true });
    await expect(admission.authorize({ model: "m", operation: "speech", requestId: "next", inputBytes: 1, estimatedTokens: 10, estimatedCostUsd: 0.02 })).rejects.toThrow("voice_call_cost_limit_reached");
  });
});
