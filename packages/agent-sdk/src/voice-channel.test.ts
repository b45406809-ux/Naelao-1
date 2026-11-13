import { describe, expect, it } from "vitest";
import { validateVoiceChannelResponse } from "./voice-channel.js";

describe("versioned voice channel response contract", () => {
  it("accepts v1 data and preserves the legacy response shape", () => {
    expect(validateVoiceChannelResponse({ schema_version: 1, actions: [
      { type: "say", text: "Welcome." }, { type: "gather", input: "dtmf", digits: 1, text: "Press one." },
    ] })).toEqual({ schema_version: 1, actions: [
      { type: "say", text: "Welcome." }, { type: "gather", input: "dtmf", digits: 1, text: "Press one." },
    ] });
    expect(validateVoiceChannelResponse({ actions: [{ type: "hangup" }] })).toEqual({ actions: [{ type: "hangup" }] });
  });

  it.each([
    { schema_version: 2, actions: [{ type: "hangup" }] },
    { schema_version: 1, actions: [{ type: "say", text: "Goodbye", twiml: "<Dial>+263...</Dial>" }] },
    { schema_version: 1, actions: [{ type: "gather", input: "stream", text: "Speak now" }] },
    { schema_version: 1, actions: [{ type: "gather", input: "dtmf", digits: 9, text: "Press" }] },
    { schema_version: 1, actions: Array.from({ length: 9 }, () => ({ type: "hangup" })) },
  ])("rejects unsupported or unsafe response %#", response => {
    expect(validateVoiceChannelResponse(response)).toBeNull();
  });

  it("copies actions and rejects malformed containers", () => {
    const actions = [{ type: "say", text: "Hello" }];
    const parsed = validateVoiceChannelResponse({ schema_version: 1, actions });
    actions[0]!.text = "changed";
    expect(parsed).toEqual({ schema_version: 1, actions: [{ type: "say", text: "Hello" }] });
    expect(validateVoiceChannelResponse(null)).toBeNull();
    expect(validateVoiceChannelResponse({ schema_version: 1, actions: [] })).toBeNull();
  });
});
