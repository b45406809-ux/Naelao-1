import { describe, expect, it } from "vitest";
import { decodeOggOpusToWav } from "./ogg-opus";
import { transcribeAudio } from "./transcribe";

// 0.15s mono Ogg/Opus generated with ffmpeg (lavfi sine source).
const fixture = "T2dnUwACAAAAAAAAAAAZsXXoAAAAAJGivbsBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAABmxdegBAAAANwlslwE9T3B1c1RhZ3MMAAAATGF2ZjYxLjcuMTAzAQAAAB0AAABlbmNvZGVyPUxhdmM2MS4xOS4xMDEgbGlib3B1c09nZ1MABFgdAAAAAAAAGbF16AIAAAD2acFoCEUtMjw2Ny44eIIBt2x+QOYAAAq+mqe+/7aF1wpx4N1roOPGxcMyxmQebmNSOkUMilOPRBiwjGSr7JiWeWxUUzBVToLkFspZSdjHCV1ZeKM/96yYhQNXT87RdhOWMcBhIADljOWvRwG3yk4vJSlREI+/RaSsh9kQ7WtYeJujElbOI3Zy7VwMi1FYKOC3Yyms8LQkMLRb6RxW5MPSGPauymCNjqjDwNEAajoH5KJ4m6MRtBy/qJsXXiNPnr9GzZckLc+Jz2CjeH3WwgHthCJeCsyop2zEabgZ+MjghX8ta64nWNdc7ZoASR94m6NfdZz8RdDFUbT6kaMotq0p6sqjHczN8oiYv611hGlsdJ080oVJ/Z0w+TEyKJrzScsWBlp4m6MXS92wD3/8QjKLKNSBwzuf03iLcm6ii9AubZXFFA5dU1dw1fXGavKO3hpDV/JrMlSPjX/XeJujX3Wc/ElKInG42Ndh7/CPUXDOJsR/fkuRDu4SOE7Z8i+Z4xhvFfBIQjp4VHicNFTs/naCWYE2KPxTNhzl5NR/FoOzwSuaphno1CmTNfk5IWqQEbENLfs/im3qLZqnfewkk+8I";
const ogg = Uint8Array.from(atob(fixture), (character) => character.charCodeAt(0));

describe("Ogg/Opus normalization", () => {
  it("decodes a real Ogg stream to mono 16kHz PCM WAV", async () => {
    const wav = await decodeOggOpusToWav(ogg);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBeGreaterThan(0);
    expect(wav.byteLength).toBe(view.getUint32(40, true) + 44);
  });

  it("rejects an invalid container before allocating the decoder", async () => {
    await expect(decodeOggOpusToWav(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow("audio_ogg_container_invalid");
  });

  it("normalizes multipart Ogg audio before dispatching it to Whisper", async () => {
    let audio: number[] = [];
    const AI = { run: async (_model: string, input: { audio: number[] }) => { audio = input.audio; return { text: "hello" }; } } as unknown as Ai;
    const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class TestWorker {} });
    const form = new FormData();
    form.set("audio", new Blob([ogg], { type: "audio/ogg" }), "voice.ogg");
    try {
      const response = await transcribeAudio(new Request("https://router/api/voice/transcribe", { method: "POST", body: form }), { AI });
      expect(response.status).toBe(200);
      expect(audio.slice(0, 4)).toEqual([82, 73, 70, 70]);
      expect(audio.slice(8, 12)).toEqual([87, 65, 86, 69]);
    } finally {
      if (original) Object.defineProperty(globalThis, "Worker", original);
      else delete (globalThis as { Worker?: unknown }).Worker;
    }
  });

  it("keeps the Worker runtime off the Web Worker based decoder and forwards bounded Ogg to Whisper", async () => {
    let audio: number[] = [];
    const AI = { run: async (_model: string, input: { audio: number[] }) => { audio = input.audio; return { text: "hello" }; } } as unknown as Ai;
    const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
    try {
      const response = await transcribeAudio(new Request("https://router/api/voice/transcribe", {
        method: "POST", headers: { "content-type": "audio/ogg" }, body: ogg,
      }), { AI });
      expect(response.status).toBe(200);
      expect(audio).toEqual([...ogg]);
    } finally {
      if (original) Object.defineProperty(globalThis, "Worker", original);
      else delete (globalThis as { Worker?: unknown }).Worker;
    }
  });
});
