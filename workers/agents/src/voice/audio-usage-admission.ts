import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AudioReservation, OpenRouterAudioOptions } from "./openrouter-audio.js";

export interface VoiceUsageJournal {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
export interface VoiceUsageRecord {
  requestId: string; runId: string; model: string; operation: "transcription" | "speech";
  estimatedTokens: number; generationId?: string; state: "reserving" | "held" | "pending" | "settle_retry" | "settled" | "released" | "denied";
  actualTokens?: number; costUsd?: number; updatedAt: number;
}
export interface VoiceUsageScope {
  tenantId: string; spaceId: string; callId: string; secret: string; billingWorker: Fetcher;
  journal: VoiceUsageJournal; stillAllowed(): Promise<boolean>;
  resolveGeneration?(id: string): Promise<{ costUsd: number; tokens: number }>;
}

/** Couples audio requests to the account's subscription token reservation. Every upstream call
 * receives a distinct durable run id; unknown outcomes retain their quota hold for reconciliation. */
export function createVoiceAudioAdmission(scope: VoiceUsageScope): Pick<OpenRouterAudioOptions, "authorize"> & {
  reconcile(): Promise<{ settled: number; unresolved: number }>;
} {
  const prefix = `voice-audio:${scope.callId}:`;
  const send = async (path: string, body: Record<string, unknown>) => {
    const response = await scope.billingWorker.fetch(new Request(`http://billing-worker/internal/usage/llm-tokens/reservations/${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
        "x-naelao-internal-token": await mintInternalToken(scope.secret, scope.tenantId) }, body: JSON.stringify(body),
    }));
    if (!response.ok) throw new Error(`voice_usage_${path}_failed_${response.status}`);
    return readBoundedResponseJson<{ reserved?: boolean; settled?: boolean; error_code?: string }>(response, 16 * 1024);
  };
  const persistSettlement = async (record: VoiceUsageRecord, costUsd: number, generationId?: string, actualTokens?: number) => {
    if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > 10_000 || !Number.isSafeInteger(actualTokens) || (actualTokens ?? -1) < 0 || (actualTokens ?? 0) > 10_000_000)
      throw new Error("voice_usage_receipt_invalid");
    const next: VoiceUsageRecord = { ...record, state: "settle_retry", costUsd, actualTokens: actualTokens!, updatedAt: Date.now(), ...(generationId ? { generationId } : {}) };
    await scope.journal.put(prefix + record.requestId, next);
    const result = await send("settle", { run_id: record.runId, actual_tokens: actualTokens,
      model_id: record.model, cost_credits: Math.ceil(costUsd * 115), rate_card_version: "openrouter-audio-usage-v1" });
    if (!result.settled) throw new Error("voice_usage_settlement_unconfirmed");
    await scope.journal.put(prefix + record.requestId, { ...next, state: "settled", updatedAt: Date.now() });
  };
  return {
    async authorize(input): Promise<AudioReservation> {
      if (!await scope.stillAllowed()) throw new Error("voice_access_revoked");
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(input.requestId) || !Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 1 || input.estimatedTokens > 10_000_000)
        throw new Error("voice_usage_admission_invalid");
      const key = prefix + input.requestId;
      const runId = key;
      let record = await scope.journal.get<VoiceUsageRecord>(key);
      if (record && (record.runId !== runId || record.model !== input.model || record.operation !== input.operation || record.state === "settled"))
        throw new Error("voice_usage_request_id_conflict");
      if (record?.state === "denied" || record?.state === "released") throw new Error("voice_usage_request_not_admitted");
      if (!record) {
        record = { requestId: input.requestId, runId, model: input.model, operation: input.operation,
          estimatedTokens: input.estimatedTokens, state: "reserving", updatedAt: Date.now() };
        await scope.journal.put(key, record);
      }
      if (record.state === "reserving") {
        try {
          const response = await send("reserve", { reservation_id: runId, run_id: runId, space_id: scope.spaceId,
            estimated_tokens: input.estimatedTokens, expires_in_seconds: 30 * 86400 });
          if (!response.reserved) throw new Error("voice_usage_reservation_unconfirmed");
        } catch (error) {
          if (error instanceof Error && error.message.endsWith("_402"))
            await scope.journal.put(key, { ...record, state: "denied", updatedAt: Date.now() });
          throw error;
        }
        record = { ...record, state: "held", updatedAt: Date.now() };
        await scope.journal.put(key, record);
      }
      return {
        settle: async (costUsd, generationId, actualTokens) => {
          const latest = await scope.journal.get<VoiceUsageRecord>(key);
          if (!latest || latest.state === "settled") return;
          await persistSettlement(latest, costUsd, generationId, actualTokens);
        },
        pending: async generationId => {
          const latest = await scope.journal.get<VoiceUsageRecord>(key);
          if (latest && latest.state !== "settled") await scope.journal.put(key, { ...latest, state: "pending", ...(generationId ? { generationId } : {}), updatedAt: Date.now() });
        },
      };
    },
    async reconcile() {
      const entries = await scope.journal.list<VoiceUsageRecord>({ prefix });
      let settled = 0, unresolved = 0;
      for (const [key, record] of entries) {
        if (["settled", "released", "denied"].includes(record.state)) continue;
        if (record.state === "reserving") {
          try {
            await send("reserve", { reservation_id: record.runId, run_id: record.runId, space_id: scope.spaceId,
              estimated_tokens: record.estimatedTokens, expires_in_seconds: 30 * 86400 });
            await send("release", { run_id: record.runId });
            await scope.journal.put(key, { ...record, state: "released", updatedAt: Date.now() });
          } catch { unresolved++; }
          continue;
        }
        if (record.state === "settle_retry" && record.costUsd !== undefined && record.actualTokens !== undefined) {
          try { await persistSettlement(record, record.costUsd, record.generationId, record.actualTokens); settled++; }
          catch { unresolved++; }
          continue;
        }
        if (record.state === "pending" && record.generationId && scope.resolveGeneration) {
          try {
            const usage = await scope.resolveGeneration(record.generationId);
            await persistSettlement(record, usage.costUsd, record.generationId, usage.tokens); settled++;
          } catch { unresolved++; }
          continue;
        }
        unresolved++;
      }
      return { settled, unresolved };
    },
  };
}
