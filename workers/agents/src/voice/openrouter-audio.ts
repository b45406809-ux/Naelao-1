import type { RuntimeVault } from "@naelao/agent-sdk";
import { readBoundedResponseJson } from "@naelao/http";
export interface AudioReservation {
  settle(costUsd: number, generationId?: string, actualTokens?: number): Promise<void>;
  /** Persist the reservation for reconciliation; do not release an unknown provider charge. */
  pending(generationId?: string): Promise<void>;
}
export interface OpenRouterAudioOptions {
  vault: RuntimeVault;
  credentialName: string;
  /** Host-owned admission validates current scope, catalog capabilities, limits and entitlement. */
  authorize(input: { model: string; operation: "transcription" | "speech"; inputBytes: number; inputCharacters?: number; estimatedTokens: number; requestId: string }): Promise<AudioReservation>;
}
const BASE = "https://openrouter.ai/api/v1";
function modelId(model: string): string {
  const id = model.replace(/^openrouter\//, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id)) throw new Error("invalid_audio_model");
  return id;
}
function requestId(id: string) { if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) throw new Error("invalid_audio_request_id"); }
function cost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10000) throw new Error("audio_usage_unavailable");
  return value;
}
export function createOpenRouterAudio(options: OpenRouterAudioOptions) {
  async function generationUsage(id: string): Promise<{ costUsd: number; tokens: number }> {
    const response = await options.vault.fetchWithAuth(`${BASE}/generation?id=${encodeURIComponent(id)}`, { credentialName: options.credentialName, method: "GET" });
    const result = await readBoundedResponseJson<{ data?: { total_cost?: unknown; total_tokens?: unknown; tokens_prompt?: unknown; tokens_completion?: unknown } }>(response, 64 * 1024);
    const prompt = result.data?.tokens_prompt, completion = result.data?.tokens_completion;
    const tokens = result.data?.total_tokens ?? (typeof prompt === "number" && typeof completion === "number" ? prompt + completion : undefined);
    if (!Number.isSafeInteger(tokens) || (tokens as number) < 0 || (tokens as number) > 10_000_000) throw new Error("audio_usage_unavailable");
    return { costUsd: cost(result.data?.total_cost), tokens: tokens as number };
  }
  return {
    async transcribe(input: { model: string; requestId: string; data: string; format: "wav" | "mp3" | "ogg" | "webm"; language?: string }): Promise<string> {
      requestId(input.requestId);
      const model = modelId(input.model);
      if (typeof input.data !== "string" || !input.data.length || input.data.length > 300_000 || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error("invalid_audio_reference");
      if (!["wav", "mp3", "ogg", "webm"].includes(input.format)) throw new Error("invalid_audio_format");
      if (input.language !== undefined && !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(input.language)) throw new Error("invalid_audio_language");
      const body = { model, input_audio: { data: input.data, format: input.format }, ...(input.language ? { language: input.language } : {}) };
      const reservation = await options.authorize({ model, operation: "transcription", inputBytes: new TextEncoder().encode(JSON.stringify(body)).length, estimatedTokens: 10_000, requestId: input.requestId });
      let settled = false;
      try {
        const response = await options.vault.fetchWithAuth(`${BASE}/audio/transcriptions`, { credentialName: options.credentialName, method: "POST", headers: { "content-type": "application/json" }, body, idempotencyKey: input.requestId });
        const result = await readBoundedResponseJson<{ text?: unknown; usage?: { cost?: unknown; total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown } }>(response, 128 * 1024);
        // Account for a valid receipt even when the provider's text is malformed.
        const usage = result.usage;
        const tokens = usage?.total_tokens ?? (typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number" ? usage.input_tokens + usage.output_tokens : undefined);
        if (!Number.isSafeInteger(tokens) || (tokens as number) < 0 || (tokens as number) > 10_000_000) throw new Error("audio_usage_unavailable");
        await reservation.settle(cost(usage?.cost), undefined, tokens as number); settled = true;
        if (typeof result.text !== "string" || result.text.length > 32_000) throw new Error("invalid_audio_transcript");
        return result.text;
      } catch (error) { if (!settled) await reservation.pending(); throw error; }
    },
    async speak(input: { model: string; requestId: string; text: string; voice?: string; instructions?: string; speed?: number; rate?: 8000 | 16000 | 24000 | 48000; channels?: 1 | 2; references?: { data: string; transcript?: string }[] }): Promise<{ stream: ReadableStream<Uint8Array>; generationId: string; contentType: string }> {
      requestId(input.requestId);
      const model = modelId(input.model);
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) throw new Error("invalid_speech_text");
      if (input.voice !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(input.voice)) throw new Error("invalid_speech_voice");
      if (input.instructions !== undefined && (typeof input.instructions !== "string" || input.instructions.length > 1000)) throw new Error("invalid_speech_instructions");
      if (input.speed !== undefined && (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)) throw new Error("invalid_speech_speed");
      if (input.rate !== undefined && ![8000, 16000, 24000, 48000].includes(input.rate)) throw new Error("invalid_speech_rate");
      if (input.channels !== undefined && input.channels !== 1 && input.channels !== 2) throw new Error("invalid_speech_channels");
      if (input.references && (input.references.length !== 1 || !input.references.every(r => typeof r.data === "string" && r.data.length > 0 && r.data.length <= 200_000 && r.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(r.data) && (r.transcript === undefined || typeof r.transcript === "string" && r.transcript.length <= 2000)))) throw new Error("invalid_speech_reference");
      const body = { model, input: input.text, response_format: "pcm", ...(input.voice ? { voice: input.voice } : {}), ...(input.instructions ? { instructions: input.instructions } : {}), ...(input.speed !== undefined ? { speed: input.speed } : {}), ...(input.rate ? { rate: input.rate } : {}), ...(input.channels ? { channels: input.channels } : {}), ...(input.references ? { input_references: input.references.flatMap(r => [
        { type: "input_audio", input_audio: { data: r.data } }, ...(r.transcript ? [{ type: "text", text: r.transcript }] : []),
      ]) } : {}) };
      const reservation = await options.authorize({ model, operation: "speech", inputBytes: new TextEncoder().encode(JSON.stringify(body)).length, inputCharacters: input.text.length, estimatedTokens: Math.min(10_000, Math.max(256, Math.ceil(input.text.length * 2))), requestId: input.requestId });
      let response: Response;
      try { response = await options.vault.fetchWithAuth(`${BASE}/audio/speech`, { credentialName: options.credentialName, responseMode: "audio", method: "POST", headers: { "content-type": "application/json" }, body, idempotencyKey: input.requestId }); }
      catch (error) { await reservation.pending(); throw error; }
      const id = response.headers.get("x-generation-id"), contentType = response.headers.get("content-type") ?? "";
      if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !response.body || !/^(audio\/(pcm|l16)|application\/octet-stream)(;|$)/i.test(contentType)) {
        await response.body?.cancel(); await reservation.pending(id ?? undefined); throw new Error("speech_receipt_or_format_unavailable");
      }
      const reader = response.body.getReader(); let finished = false;
      const pending = async () => { if (!finished) { finished = true; await reservation.pending(id); } };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (!done) { controller.enqueue(value); return; }
            try { const usage = await generationUsage(id); await reservation.settle(usage.costUsd, id, usage.tokens); finished = true; }
            catch { await pending(); }
            controller.close(); reader.releaseLock();
          } catch (error) { await pending(); controller.error(error); }
        },
        async cancel() { await reader.cancel().catch(() => {}); await pending(); },
      });
      return { stream, generationId: id, contentType };
    },
  };
}
