import { describe, expect, it } from "vitest";
import { decodeTelnyxPcmuToPcm16k, encodePcm16kToTelnyxPcmu, encodeTelnyxPcmuBase64, TELNYX_PCMU_PACKET_BYTES } from "./telnyx-extension-audio.js";

describe("Telnyx extension PCMU boundary", () => {
  it("decodes bounded 8 kHz PCMU to 16 kHz mono PCM16", () => {
    const decoded = decodeTelnyxPcmuToPcm16k("/38="); // positive and negative mu-law zero
    expect(decoded.byteLength).toBe(8);
    const samples = new DataView(decoded);
    expect([samples.getInt16(0, true), samples.getInt16(2, true), samples.getInt16(4, true), samples.getInt16(6, true)])
      .toEqual([0, 0, 0, 0]);
  });

  it("packetizes 16 kHz PCM16 into bounded 20 ms PCMU payloads", () => {
    const silence = new Uint8Array(TELNYX_PCMU_PACKET_BYTES * 4);
    const encoded = encodePcm16kToTelnyxPcmu(silence);
    expect(encoded).toHaveLength(TELNYX_PCMU_PACKET_BYTES);
    expect(new Set(encoded)).toEqual(new Set([0xff]));
    expect(encodeTelnyxPcmuBase64(encoded)).toBe(btoa(String.fromCharCode(...encoded)));
  });

  it("rejects malformed, oversized and unaligned audio", () => {
    expect(() => decodeTelnyxPcmuToPcm16k("")).toThrow("telnyx_audio_frame_invalid");
    expect(() => decodeTelnyxPcmuToPcm16k("!@#$")).toThrow("telnyx_audio_frame_invalid");
    expect(() => encodePcm16kToTelnyxPcmu(new Uint8Array(3))).toThrow("telnyx_speech_frame_invalid");
  });
});
