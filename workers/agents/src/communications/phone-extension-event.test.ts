import { describe, expect, it } from "vitest";
import { validPhoneExtensionEvent } from "./phone-extension-event.js";

describe("phone extension event carrier scope", () => {
  it("accepts Telnyx SMS and scoped DTMF call events only on Telnyx bindings", () => {
    const sms = `SM${"a".repeat(32)}`;
    expect(validPhoneExtensionEvent("telnyx", "message.received", "telnyx-event-123")).toBe(true);
    expect(validPhoneExtensionEvent("twilio", "message.received", "telnyx-event-123")).toBe(false);
    expect(validPhoneExtensionEvent("telnyx", "message.received", sms)).toBe(false);
    expect(validPhoneExtensionEvent("telnyx", "call.received", "telnyx-event-123")).toBe(false);
    const voiceId = `telnyx-call-${"a".repeat(32)}`;
    expect(validPhoneExtensionEvent("telnyx", "call.received", voiceId)).toBe(true);
    expect(validPhoneExtensionEvent("telnyx", "call.digits", voiceId)).toBe(true);
    expect(validPhoneExtensionEvent("telnyx", "call.speech", voiceId)).toBe(false);
    expect(validPhoneExtensionEvent("twilio", "call.received", voiceId)).toBe(false);
    expect(validPhoneExtensionEvent("telnyx", "call.received", `telnyx-call-${"a".repeat(31)}`)).toBe(false);
    expect(validPhoneExtensionEvent("twilio", "message.received", sms)).toBe(true);
    expect(validPhoneExtensionEvent("unknown", "message.received", sms)).toBe(false);
  });
});
