import { describe, expect, it } from "vitest";
import { validPhoneExtensionEvent } from "./phone-extension-event.js";

describe("phone extension event carrier scope", () => {
  it("accepts Telnyx SMS only on Telnyx bindings and preserves Twilio formats", () => {
    const sms = `SM${"a".repeat(32)}`;
    expect(validPhoneExtensionEvent("telnyx", "message.received", "telnyx-event-123")).toBe(true);
    expect(validPhoneExtensionEvent("twilio", "message.received", "telnyx-event-123")).toBe(false);
    expect(validPhoneExtensionEvent("telnyx", "message.received", sms)).toBe(false);
    expect(validPhoneExtensionEvent("telnyx", "call.received", "telnyx-event-123")).toBe(false);
    expect(validPhoneExtensionEvent("twilio", "message.received", sms)).toBe(true);
    expect(validPhoneExtensionEvent("unknown", "message.received", sms)).toBe(false);
  });
});
