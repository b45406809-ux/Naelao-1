import { describe, expect, it, vi } from "vitest";
import { OpenRouterLiveTranscriber, openRouterLiveTranscriberLimits } from "./openrouter-live-transcriber.js";

function pcm(amplitude: number, samples = 320): ArrayBuffer {
  const bytes = new Uint8Array(samples * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, amplitude, true);
  return bytes.buffer;
}
const decoded = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

describe("OpenRouter live PCM utterance bridge", () => {
  it("frames a bounded 16kHz PCM utterance as a valid WAV before transcription", async () => {
    let now = 0;
    const provider = { transcribe: vi.fn(async () => "hello") };
    const transcript = vi.fn();
    const session = new OpenRouterLiveTranscriber({ provider, requestId: () => "call-turn-1", now: () => now }).createSession({ onUtterance: transcript });
    for (let n = 0; n < 8; n++) { session.feed(pcm(1200)); now += 20; }
    for (let n = 0; n < 34; n++) { session.feed(pcm(0)); now += 20; }
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledWith("hello"));
    expect(provider.transcribe).toHaveBeenCalledOnce();
    const request = provider.transcribe.mock.calls[0]![0];
    expect(request.format).toBe("wav");
    const wav = decoded(request.data);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect(wav.byteLength).toBeLessThanOrEqual(44 + openRouterLiveTranscriberLimits.MAX_UTTERANCE_BYTES);
    session.close();
  });

  it("bounds a continuous speech stream to 20-second requests", async () => {
    let now = 0;
    const provider = { transcribe: vi.fn(async () => "ok") };
    const transcript = vi.fn();
    const session = new OpenRouterLiveTranscriber({ provider, requestId: () => crypto.randomUUID(), now: () => now }).createSession({ onUtterance: transcript });
    for (let n = 0; n < 1_050; n++) { session.feed(pcm(1200)); now += 20; }
    await vi.waitFor(() => expect(provider.transcribe).toHaveBeenCalled());
    for (const call of provider.transcribe.mock.calls) {
      expect(decoded(call[0].data).byteLength).toBeLessThanOrEqual(44 + openRouterLiveTranscriberLimits.MAX_UTTERANCE_BYTES);
    }
    session.close();
  });

  it("does not submit noise-only frames and reports provider failures without falling back", async () => {
    let now = 0;
    const provider = { transcribe: vi.fn(async () => { throw new Error("provider down"); }) };
    const fatal = vi.fn();
    const session = new OpenRouterLiveTranscriber({ provider, requestId: () => "call-turn-2", now: () => now }).createSession({ onFatalError: fatal });
    for (let n = 0; n < 50; n++) { session.feed(pcm(100)); now += 20; }
    expect(provider.transcribe).not.toHaveBeenCalled();
    session.feed(pcm(2000)); now += 20;
    for (let n = 0; n < 34; n++) { session.feed(pcm(0)); now += 20; }
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: "openrouter_transcription_unavailable" })));
    expect(provider.transcribe).toHaveBeenCalledOnce();
    session.close();
  });
});
