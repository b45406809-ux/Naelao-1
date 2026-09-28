export const MAX_DICTATION_BYTES = 10 * 1024 * 1024;
export const WHISPER_MODEL = "@cf/openai/whisper";

export interface TranscriptionEnv { AI: Ai; }

export async function transcribeAudio(request: Request, env: TranscriptionEnv): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let bytes: ArrayBuffer;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const audio = form?.get("audio") as unknown;
    if (!audio || typeof audio !== "object" || !("arrayBuffer" in audio)) return Response.json({ ok: false, error: "multipart field 'audio' is required" }, { status: 400 });
    bytes = await (audio as Blob).arrayBuffer();
  } else if (contentType.startsWith("audio/webm") || contentType.startsWith("audio/wav") || contentType.startsWith("audio/ogg")) {
    bytes = await request.arrayBuffer();
  } else {
    return Response.json({ ok: false, error: "Expected multipart/form-data, audio/webm, audio/ogg, or audio/wav" }, { status: 415 });
  }
  if (!bytes.byteLength) return Response.json({ ok: false, error: "Audio body is empty" }, { status: 400 });
  if (bytes.byteLength > MAX_DICTATION_BYTES) return Response.json({ ok: false, error: "Audio exceeds 10 MiB" }, { status: 413 });
  const result = await env.AI.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], { audio: [...new Uint8Array(bytes)] }) as { text?: string };
  const text = result.text?.trim() ?? "";
  return Response.json({ ok: true, text });
}
