import type { AgentsEnv } from "../index.js";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Twilio's adapter consumes raw 16 kHz PCM, not the default MP3/WAV response. */
export async function synthesizeVoicePcm(
  ai: AgentsEnv["AI"],
  text: string,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = (await ai.run(
    "@cf/deepgram/aura-1",
    {
      text: text.slice(0, 4000),
      speaker: "asteria",
      encoding: "linear16",
      container: "none",
      sample_rate: 16000,
    },
    { returnRawResponse: true, ...(signal ? { signal } : {}) }
  )) as unknown as Response;
  if (!(response instanceof Response) || !response.ok || !response.body)
    throw new Error("voice_synthesis_unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("voice_turn_cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) throw new Error("voice_audio_size_limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!size || size % 2) throw new Error("voice_audio_format_invalid");
  const pcm = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  if (
    new TextDecoder().decode(pcm.slice(0, 4)) === "RIFF" ||
    new TextDecoder().decode(pcm.slice(0, 3)) === "ID3"
  )
    throw new Error("voice_audio_format_invalid");
  return pcm.buffer;
}
