import { describe, expect, it } from "vitest";
import { validateVoiceExtensionStreamEvent, validateVoiceExtensionStreamResponse } from "./voice-stream.js";

const ref = `call_${"a".repeat(32)}`;

describe("voice extension stream V1 boundary", () => {
  it("accepts bounded provider-neutral transcript, interruption, keypad and end events", () => {
    expect(validateVoiceExtensionStreamEvent({ schema_version: 1, id: "evt_1", type: "transcript.final",
      payload: { call_ref: ref, sequence: 2, text: "I need help." } })).toEqual({ schema_version: 1, id: "evt_1",
      type: "transcript.final", payload: { call_ref: ref, sequence: 2, text: "I need help." } });
    expect(validateVoiceExtensionStreamEvent({ schema_version: 1, id: "evt_2", type: "call.interrupted",
      payload: { call_ref: ref, sequence: 2 } })?.type).toBe("call.interrupted");
    expect(validateVoiceExtensionStreamEvent({ schema_version: 1, id: "evt_3", type: "keypad.input",
      payload: { call_ref: ref, digits: "123" } })?.type).toBe("keypad.input");
    expect(validateVoiceExtensionStreamEvent({ schema_version: 1, id: "evt_4", type: "call.ended",
      payload: { call_ref: ref, reason: "caller_hangup" } })?.type).toBe("call.ended");
  });

  it.each([
    { schema_version: 1, id: "evt", type: "transcript.final", payload: { call_ref: ref, sequence: 0, text: "x".repeat(2_001) } },
    { schema_version: 1, id: "evt", type: "transcript.partial", payload: { call_ref: ref, sequence: -1, text: "hi" } },
    { schema_version: 1, id: "evt", type: "transcript.final", payload: { call_ref: ref, sequence: 0, text: "hi", provider_call_id: "secret" } },
    { schema_version: 1, id: "evt", type: "audio.frame", payload: { call_ref: ref, audio: "base64" } },
  ])("rejects invalid or provider-bearing events %#", value => {
    expect(validateVoiceExtensionStreamEvent(value)).toBeNull();
  });

  it("allows only host-mediated speak/listen/configured handoff/end actions", () => {
    expect(validateVoiceExtensionStreamResponse({ schema_version: 1, actions: [
      { type: "speak", text: "Welcome." }, { type: "listen", input: "speech", timeout_ms: 10_000 },
      { type: "transfer", target: "configured_handoff" },
    ] })).toEqual({ schema_version: 1, actions: [
      { type: "speak", text: "Welcome." }, { type: "listen", input: "speech", timeout_ms: 10_000 },
      { type: "transfer", target: "configured_handoff" },
    ] });
    expect(validateVoiceExtensionStreamResponse({ schema_version: 1, actions: [{ type: "transfer", target: "+263771234567" }] })).toBeNull();
    expect(validateVoiceExtensionStreamResponse({ schema_version: 1, actions: [{ type: "listen", input: "speech", timeout_ms: 30_001 }] })).toBeNull();
    expect(validateVoiceExtensionStreamResponse({ schema_version: 1, actions: [{ type: "speak", text: "hello", audioUrl: "https://evil" }] })).toBeNull();
  });
});
