import { describe, expect, it, vi } from "vitest";
import { MAX_TRANSCRIPTION_BYTES, ModalityTaskError, runModalityTask } from "./modality-task.js";
import { WHISPER_MODEL } from "../voice/voice-pipeline.js";

describe("normalized modality task adapter", () => {
  it("maps only transcription to the documented Workers AI Whisper byte-array contract", async () => {
    const ai = { run: vi.fn(async () => ({ text: "  Hello from voice.  " })) };
    const result = await runModalityTask(ai, {
      task: "transcribe", mimeType: "audio/ogg; codecs=opus", bytes: new Uint8Array([0, 1, 255]).buffer,
      maxOutputChars: 100,
    });
    expect(result).toEqual({ task: "transcribe", provider: "cloudflare_workers_ai", model: WHISPER_MODEL, text: "Hello from voice." });
    expect(ai.run).toHaveBeenCalledWith(WHISPER_MODEL, { audio: [0, 1, 255] }, { signal: expect.any(AbortSignal) });
  });

  it("rejects unsupported tasks, MIME types, excessive bytes, and invalid output budgets before provider calls", async () => {
    const ai = { run: vi.fn() };
    const base = { task: "transcribe" as const, mimeType: "audio/ogg", bytes: new ArrayBuffer(1), maxOutputChars: 100 };
    await expect(runModalityTask(ai, { ...base, task: "summarize_video" })).rejects.toMatchObject<Partial<ModalityTaskError>>({ code: "modality_task_unsupported" });
    await expect(runModalityTask(ai, { ...base, mimeType: "application/pdf" })).rejects.toMatchObject({ code: "audio_mime_unsupported" });
    await expect(runModalityTask(ai, { ...base, bytes: new ArrayBuffer(MAX_TRANSCRIPTION_BYTES + 1) })).rejects.toMatchObject({ code: "audio_input_too_large" });
    await expect(runModalityTask(ai, { ...base, maxOutputChars: 20_001 })).rejects.toMatchObject({ code: "modality_output_limit_invalid" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("bounds returned transcript text and distinguishes cancellation from provider failure", async () => {
    await expect(runModalityTask({ run: async () => ({ text: "x".repeat(101) }) }, {
      task: "transcribe", mimeType: "audio/ogg", bytes: new ArrayBuffer(1), maxOutputChars: 100,
    })).rejects.toMatchObject({ code: "modality_output_too_large" });
    const controller = new AbortController();
    controller.abort();
    await expect(runModalityTask({ run: vi.fn() }, {
      task: "transcribe", mimeType: "audio/ogg", bytes: new ArrayBuffer(1), maxOutputChars: 100, signal: controller.signal,
    })).rejects.toMatchObject({ code: "modality_task_cancelled" });
  });
});
