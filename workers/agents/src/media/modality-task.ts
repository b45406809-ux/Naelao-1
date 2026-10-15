/** Normalized media task boundary. A task names the requested transformation explicitly; a
 * provider adapter accepts only capabilities it can actually execute. Bytes reach this layer
 * only after the caller has independently authorized and bounded its source attachment. */
import type { VoiceAi } from "../voice/voice-pipeline.js";
import { WHISPER_MODEL } from "../voice/voice-pipeline.js";

export type ModalityTaskName = "transcribe" | "translate" | "describe_image" | "extract_document" | "summarize_video" | "speech_to_speech";

export interface ModalityTask {
  task: ModalityTaskName;
  mimeType: string;
  bytes: ArrayBuffer;
  maxOutputChars: number;
  timeoutMs?: number;
  languageHint?: string;
  signal?: AbortSignal;
}

export interface ModalityTaskResult {
  task: ModalityTaskName;
  provider: string;
  model: string;
  text: string;
}

export class ModalityTaskError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ModalityTaskError"; }
}

export const MAX_TRANSCRIPTION_BYTES = 8 * 1024 * 1024;
const AUDIO_MIME_TYPES = new Set(["audio/aac", "audio/amr", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"]);

/** This adapter currently implements transcription only. It does not guess that transcription
 * is equivalent to translation, image understanding, document extraction, or video summary. */
export async function runModalityTask(ai: VoiceAi, input: ModalityTask): Promise<ModalityTaskResult> {
  if (input.task !== "transcribe") throw new ModalityTaskError("modality_task_unsupported");
  const mimeType = input.mimeType.toLowerCase().split(";")[0]!.trim();
  if (!AUDIO_MIME_TYPES.has(mimeType)) throw new ModalityTaskError("audio_mime_unsupported");
  if (!(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength === 0) throw new ModalityTaskError("audio_input_empty");
  if (input.bytes.byteLength > MAX_TRANSCRIPTION_BYTES) throw new ModalityTaskError("audio_input_too_large");
  if (!Number.isInteger(input.maxOutputChars) || input.maxOutputChars < 1 || input.maxOutputChars > 20_000) {
    throw new ModalityTaskError("modality_output_limit_invalid");
  }
  if (input.languageHint !== undefined && !/^[A-Za-z0-9-]{2,35}$/.test(input.languageHint)) {
    throw new ModalityTaskError("modality_language_hint_invalid");
  }
  const controller = new AbortController();
  const timeout = Math.min(Math.max(input.timeoutMs ?? 25_000, 1_000), 60_000);
  const timeoutId = setTimeout(() => controller.abort(new Error("modality_task_timeout")), timeout);
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal?.aborted) throw new ModalityTaskError("modality_task_cancelled");
    const bytes = new Uint8Array(input.bytes);
    // Official Workers AI Whisper input shape: an array of 8-bit unsigned audio bytes.
    const response = await ai.run(WHISPER_MODEL, { audio: [...bytes] }, { signal: controller.signal });
    const text = response && typeof response === "object" && typeof (response as { text?: unknown }).text === "string"
      ? (response as { text: string }).text.trim() : "";
    if (!text) throw new ModalityTaskError("audio_transcription_empty");
    if (text.length > input.maxOutputChars) throw new ModalityTaskError("modality_output_too_large");
    return { task: input.task, provider: "cloudflare_workers_ai", model: WHISPER_MODEL, text };
  } catch (error) {
    if (error instanceof ModalityTaskError) throw error;
    if (input.signal?.aborted) throw new ModalityTaskError("modality_task_cancelled");
    if (controller.signal.aborted) throw new ModalityTaskError("modality_task_timeout");
    throw new ModalityTaskError("modality_provider_failed");
  } finally {
    clearTimeout(timeoutId);
    input.signal?.removeEventListener("abort", abort);
  }
}
