import { describe, expect, it, vi } from "vitest";
import { transcribeTwilioWhatsAppVoice, transcribeWhatsAppVoiceNote } from "./whatsapp-media.js";

function payload() {
  return { entry: [{ changes: [{ value: { messages: [{ id: "wamid-1", from: "15551234567", type: "audio", timestamp: "1", audio: { id: "media-1", mime_type: "audio/ogg", voice: true } }] } }] }] };
}

describe("WhatsApp voice-note ingress", () => {
  it("retrieves bounded media with the platform token and replaces it with a transcript", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: "https://lookaside.fbsbx.com/media/1", mime_type: "audio/ogg", file_size: 3 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const ai = { run: vi.fn().mockResolvedValue({ text: "Please review the attached order." }) };
    const result = await transcribeWhatsAppVoiceNote(payload(), { accessToken: "private-token", ai, fetcher });
    const message = ((result.entry as Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }>)[0]!.changes[0]!.value.messages[0]!);
    expect(message.text).toEqual({ body: "Please review the attached order." });
    expect(message.audio).toEqual({ id: "media-1", mime_type: "audio/ogg", voice: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: "Bearer private-token", accept: "application/json" });
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("rejects untrusted media URLs before downloading them", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://attacker.example/audio", mime_type: "audio/ogg", file_size: 3 }));
    await expect(transcribeWhatsAppVoiceNote(payload(), { accessToken: "token", ai: { run: vi.fn() }, fetcher }))
      .rejects.toThrow("whatsapp_media_url_rejected");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects oversize media and fails closed when transcription is unavailable", async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://lookaside.fbsbx.com/media/1", mime_type: "audio/ogg", file_size: 9 * 1024 * 1024 }));
    await expect(transcribeWhatsAppVoiceNote(payload(), { accessToken: "token", ai: { run: vi.fn() }, fetcher: oversized })).rejects.toThrow("whatsapp_media_rejected");
    await expect(transcribeWhatsAppVoiceNote(payload(), {})).rejects.toThrow("whatsapp_voice_transcription_unavailable");
  });

  it("transcribes Twilio voice media only from the signed account message resource", async () => {
    const sid = "AC" + "a".repeat(32);
    const messageSid = "SM" + "b".repeat(32);
    const mediaSid = "ME" + "c".repeat(32);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([4, 5, 6])));
    const ai = { run: vi.fn().mockResolvedValue({ text: "What is my order status?" }) };
    const fields = {
      MessageSid: messageSid,
      MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}/Media/${mediaSid}`,
      MediaContentType0: "audio/ogg",
      NumMedia: "1",
    };
    await expect(transcribeTwilioWhatsAppVoice(fields, { accountSid: sid, authToken: "private", ai, fetcher }))
      .resolves.toMatchObject({ Body: "What is my order status?" });
    expect((fetcher.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: `Basic ${btoa(`${sid}:private`)}` });
    const invalid = { ...fields, MediaUrl0: `https://attacker.example/2010-04-01/Accounts/${sid}/Messages/${messageSid}/Media/${mediaSid}` };
    await expect(transcribeTwilioWhatsAppVoice(invalid, { accountSid: sid, authToken: "private", ai, fetcher }))
      .rejects.toThrow("whatsapp_media_url_rejected");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
