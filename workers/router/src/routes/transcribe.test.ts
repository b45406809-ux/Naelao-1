import { describe, expect, it, vi } from "vitest";
import { WHISPER_MODEL, transcribeAudio } from "./transcribe";

describe("voice transcription endpoint", () => {
  it("passes binary browser audio to Workers AI Whisper", async () => {
    const run = vi.fn(async (_model: string, _input: unknown) => ({
      text: " schedule a meeting ",
    }));
    const response = await transcribeAudio(
      new Request("https://router/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3]),
      }),
      { AI: { run } as unknown as Ai }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      text: "schedule a meeting",
    });
    expect(run.mock.calls[0]?.[0]).toBe(WHISPER_MODEL);
  });

  it("rejects non-audio and empty bodies", async () => {
    const AI = { run: vi.fn() } as unknown as Ai;
    expect(
      (
        await transcribeAudio(
          new Request("https://router/api/voice/transcribe", {
            method: "POST",
            body: "x",
          }),
          { AI }
        )
      ).status
    ).toBe(415);
    expect(
      (
        await transcribeAudio(
          new Request("https://router/api/voice/transcribe", {
            method: "POST",
            headers: { "content-type": "audio/wav" },
          }),
          { AI }
        )
      ).status
    ).toBe(400);
  });

  it("rejects streamed audio over 10 MiB before calling Workers AI", async () => {
    const run = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const request = new Request("https://router/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await transcribeAudio(request, {
      AI: { run } as unknown as Ai,
    });
    expect(response.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });
});
