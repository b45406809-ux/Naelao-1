/** Validate the event ID against the carrier on the host-resolved binding. */
export function validPhoneExtensionEvent(provider: string, type: string, id: string): boolean {
  if (provider === "twilio") return ["call.received", "call.digits", "call.speech", "message.received"].includes(type)
    && /^(?:CA[a-fA-F0-9]{32}(?::(?:digits|speech):[A-Za-z0-9._-]{1,128})?|(?:SM|MM)[a-fA-F0-9]{32})$/.test(id);
  if (provider === "telnyx") return type === "message.received" && /^telnyx-[A-Za-z0-9_-]{1,128}$/.test(id);
  return false;
}
