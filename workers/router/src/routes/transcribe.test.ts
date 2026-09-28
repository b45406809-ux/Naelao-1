import { describe, expect, it, vi } from "vitest";
import { transcribeAudio, WHISPER_MODEL } from "./transcribe";

describe("voice transcription endpoint", () => {
  it("passes binary browser audio to Workers AI Whisper", async () => {
    const run = vi.fn(async (_model: string, _input: unknown) => ({ text: " schedule a meeting " }));
    const response = await transcribeAudio(new Request("https://router/api/voice/transcribe", {
      method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([1, 2, 3]),
    }), { AI: { run } as unknown as Ai });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, text: "schedule a meeting" });
    expect(run.mock.calls[0]?.[0]).toBe(WHISPER_MODEL);
  });

  it("rejects non-audio and empty bodies", async () => {
    const AI = { run: vi.fn() } as unknown as Ai;
    expect((await transcribeAudio(new Request("https://router/api/voice/transcribe", { method: "POST", body: "x" }), { AI })).status).toBe(415);
    expect((await transcribeAudio(new Request("https://router/api/voice/transcribe", { method: "POST", headers: { "content-type": "audio/wav" } }), { AI })).status).toBe(400);
  });
});
