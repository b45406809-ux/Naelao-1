import { describe, expect, it, vi } from "vitest";
import { VoiceSession, WHISPER_MODEL, VOICE_LLM_MODEL } from "./voice-pipeline.js";
import { confirmVoiceAppointment, VOICE_AGENT_MANIFEST } from "../script-engine/prebuilt/voice-desk.js";

describe("voice runtime", () => {
  it("transcribes, generates a short turn, and sends TTS audio", async () => {
    const models: string[] = [];
    const ai = { run: vi.fn(async (model: string) => {
      models.push(model);
      if (model === WHISPER_MODEL) return { text: "Can I book tomorrow?" };
      if (model === VOICE_LLM_MODEL) return { response: "Certainly. What time works?" };
      return { audio: new Uint8Array([1, 2, 3]).buffer };
    }) };
    const transport = { sendAudio: vi.fn(async () => {}), stopAudio: vi.fn(async () => {}) };
    const session = new VoiceSession("call-1", "+15551234567", ai, transport, {
      greeting: "Welcome", businessHours: {}, voiceModel: "tts", timezone: "UTC",
    });
    await session.receiveAudio(new Uint8Array([4, 5]).buffer);
    expect(models).toEqual([WHISPER_MODEL, VOICE_LLM_MODEL, "tts"]);
    expect(transport.sendAudio).toHaveBeenCalledOnce();
    expect(session.getTranscript().map((t) => t.role)).toEqual(["caller", "assistant"]);
  });

  it("acquires the exact 15-second slot hold before booking", async () => {
    const order: string[] = [];
    const ctx = {
      connectors: { use: () => ({ get_availability: vi.fn(), book: vi.fn(async () => { order.push("book"); return { id: "booking-1" }; }) }) },
      concurrency: {
        acquireSlotHold: vi.fn(async (input: { ttlMs: number }) => { order.push(`hold:${input.ttlMs}`); return { success: true }; }),
        confirmSlotBooking: vi.fn(async () => { order.push("confirm"); return { success: true }; }),
        releaseSlotHold: vi.fn(async () => ({})),
      },
    };
    const result = await confirmVoiceAppointment(ctx, { callSid: "call-1", start: "2027-01-01T10:00:00Z", end: "2027-01-01T10:30:00Z", clientDetails: {}, patientConsented: true });
    expect(result.confirmed).toBe(true);
    expect(order).toEqual(["hold:15000", "book", "confirm"]);
    expect(VOICE_AGENT_MANIFEST).toMatchObject({ executionCeiling: 2, enabledTools: ["primary_calendar", "faq_search"] });
  });

  it("never holds or books without patient consent", async () => {
    const hold = vi.fn();
    const book = vi.fn();
    const result = await confirmVoiceAppointment({
      connectors: { use: () => ({ get_availability: vi.fn(), book }) },
      concurrency: { acquireSlotHold: hold, confirmSlotBooking: vi.fn(), releaseSlotHold: vi.fn() },
    }, { callSid: "call-2", start: "2027-01-01T10:00:00Z", end: "2027-01-01T10:30:00Z", clientDetails: {}, patientConsented: false });
    expect(result.reason).toBe("PATIENT_CONSENT_REQUIRED");
    expect(hold).not.toHaveBeenCalled();
    expect(book).not.toHaveBeenCalled();
  });
});
