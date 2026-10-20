import { describe, expect, it, vi } from "vitest";
import { downloadTwilioWhatsAppAttachments, downloadWhatsAppAttachments, transcribeTwilioWhatsAppVoice, transcribeWhatsAppVoiceNote } from "./whatsapp-media.js";
import { WHISPER_MODEL } from "../voice/voice-pipeline.js";

function payload() {
  return { entry: [{ changes: [{ value: { messages: [{ id: "wamid-1", from: "15551234567", type: "audio", timestamp: "1", audio: { id: "media-1", mime_type: "audio/ogg", voice: true } }] } }] }] };
}

describe("WhatsApp voice-note ingress", () => {
  it("retrieves bounded media with the platform token and replaces it with a transcript", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: "https://lookaside.fbsbx.com/media/1", mime_type: "audio/ogg", file_size: 3 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const ai = { run: vi.fn().mockResolvedValue({ text: "Please review the attached order." }) };
    const result = await transcribeWhatsAppVoiceNote(payload(), { accessToken: "private-token", graphApiVersion: "v26.0", ai, fetcher });
    const message = ((result.entry as Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }>)[0]!.changes[0]!.value.messages[0]!);
    expect(message.text).toEqual({ body: "Please review the attached order." });
    expect(message.audio).toEqual({ id: "media-1", mime_type: "audio/ogg", voice: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toBe("https://graph.facebook.com/v26.0/media-1");
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: "Bearer private-token", accept: "application/json" });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(ai.run).toHaveBeenCalledWith(WHISPER_MODEL, { audio: [1, 2, 3] }, { signal: expect.any(AbortSignal) });
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
    await expect(transcribeWhatsAppVoiceNote(payload(), { accessToken: "token", ai: { run: vi.fn() }, graphApiVersion: "latest" }))
      .rejects.toThrow("whatsapp_graph_api_version_invalid");
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

describe("WhatsApp attachment ingress", () => {
  it("resolves signed provider media IDs and returns bounded bytes with safe filenames", async () => {
    const raw = { entry: [{ changes: [{ value: { messages: [{ type: "document", document: { id: "media-2", filename: "../invoice.pdf" } }] } }] }] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: "https://lookaside.fbsbx.com/media/2", mime_type: "application/pdf", file_size: 4 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
    const files = await downloadWhatsAppAttachments(raw, { accessToken: "private-token", fetcher });
    expect(files).toEqual([{ filename: "_invoice.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[1]![1] as RequestInit).redirect).toBe("manual");
  });

  it("rejects untrusted download hosts and oversized provider declarations", async () => {
    const raw = { entry: [{ changes: [{ value: { messages: [{ type: "image", image: { id: "media-3" } }] } }] }] };
    const untrusted = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://attacker.example/image", mime_type: "image/png", file_size: 3 }));
    await expect(downloadWhatsAppAttachments(raw, { accessToken: "token", fetcher: untrusted })).rejects.toThrow("whatsapp_media_url_rejected");
    const alternatePort = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://lookaside.fbsbx.com:8443/image", mime_type: "image/png", file_size: 3 }));
    await expect(downloadWhatsAppAttachments(raw, { accessToken: "token", fetcher: alternatePort })).rejects.toThrow("whatsapp_media_url_rejected");
    expect(alternatePort).toHaveBeenCalledOnce();
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://lookaside.fbsbx.com/media/3", mime_type: "image/png", file_size: 6 * 1024 * 1024 }));
    await expect(downloadWhatsAppAttachments(raw, { accessToken: "token", fetcher: oversized })).rejects.toThrow("whatsapp_media_rejected");
  });

  it("downloads Twilio attachments only from the signed account/message media resource", async () => {
    const sid = "AC" + "a".repeat(32);
    const messageSid = "SM" + "b".repeat(32);
    const mediaSid = "ME" + "c".repeat(32);
    const fields = {
      MessageSid: messageSid, NumMedia: "1", MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}/Media/${mediaSid}`,
      MediaContentType0: "application/pdf",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    await expect(downloadTwilioWhatsAppAttachments(fields, { accountSid: sid, authToken: "private", fetcher }))
      .resolves.toMatchObject([{ filename: `whatsapp-${messageSid}-1`, mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toEqual({ authorization: `Basic ${btoa(`${sid}:private`)}` });
    await expect(downloadTwilioWhatsAppAttachments({ ...fields, MediaUrl0: "https://attacker.example/file" }, { accountSid: sid, authToken: "private", fetcher }))
      .rejects.toThrow("twilio_whatsapp_media_url_rejected");
  });

  it("stops Twilio downloads at the 15 MiB aggregate ceiling", async () => {
    const sid = `AC${"a".repeat(32)}`;
    const messageSid = `SM${"b".repeat(32)}`;
    const fields: Record<string, string> = { MessageSid: messageSid, NumMedia: "4" };
    for (let index = 0; index < 4; index++) {
      const mediaSid = `ME${"c".repeat(32)}`;
      fields[`MediaUrl${index}`] = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}/Media/${mediaSid}`;
      fields[`MediaContentType${index}`] = "application/octet-stream";
    }
    const fiveMiB = 5 * 1024 * 1024;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(fiveMiB)));

    await expect(downloadTwilioWhatsAppAttachments(fields, { accountSid: sid, authToken: "private", fetcher }))
      .rejects.toThrow("twilio_whatsapp_media_too_large");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
