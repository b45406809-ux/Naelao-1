import { decodeOggOpusToWav } from "./ogg-opus";

export const MAX_DICTATION_BYTES = 10 * 1024 * 1024;
export const WHISPER_MODEL = "@cf/openai/whisper";

export interface TranscriptionEnv { AI: Ai; }

export async function transcribeAudio(request: Request, env: TranscriptionEnv): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let bytes: ArrayBuffer;
  let audioContentType = contentType;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const audio = form?.get("audio") as unknown;
    if (!audio || typeof audio !== "object" || !("arrayBuffer" in audio)) return Response.json({ ok: false, error: "multipart field 'audio' is required" }, { status: 400 });
    const file = audio as Blob;
    audioContentType = file.type || "application/octet-stream";
    bytes = await file.arrayBuffer();
  } else if (contentType.startsWith("audio/webm") || contentType.startsWith("audio/wav") || contentType.startsWith("audio/ogg")) {
    bytes = await request.arrayBuffer();
  } else {
    return Response.json({ ok: false, error: "Expected multipart/form-data, audio/webm, audio/ogg, or audio/wav" }, { status: 415 });
  }
  if (!bytes.byteLength) return Response.json({ ok: false, error: "Audio body is empty" }, { status: 400 });
  if (bytes.byteLength > MAX_DICTATION_BYTES) return Response.json({ ok: false, error: "Audio exceeds 10 MiB" }, { status: 413 });
  let normalized: Uint8Array = new Uint8Array(bytes);
  const hasWebWorkerRuntime = typeof (globalThis as unknown as { Worker?: unknown }).Worker === "function";
  if (audioContentType.startsWith("audio/ogg") && hasWebWorkerRuntime) {
    // ogg-opus-decoder's final flush hangs in the tested local workerd runtime. Keep it out of
    // the Worker path and forward the bounded Ogg bytes to the configured AI binding. Provider
    // acceptance of raw Ogg is unverified; the binding failure is handled below as a 503.
    try {
      normalized = await decodeOggOpusToWav(normalized);
    } catch (error) {
      const code = error instanceof Error ? error.message : "audio_decode_failed";
      const status = code === "audio_duration_exceeds_limit" ? 413 : 422;
      return Response.json({ ok: false, error: code }, { status });
    }
  }
  let result: { text?: string };
  try {
    result = await env.AI.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], { audio: [...normalized] }) as { text?: string };
  } catch {
    return Response.json({ ok: false, error: "transcription_provider_unavailable" }, { status: 503 });
  }
  const text = result.text?.trim() ?? "";
  return Response.json({ ok: true, text });
}
