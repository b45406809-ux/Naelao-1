import { xml } from "./phone-provider.js";
/** Extensions return data, never executable TwiML or credential-bearing callback URLs. */
export function renderExtensionVoiceResponse(
  value: unknown,
  callback: string,
  allowSpeechInput = false,
): string {
  const plan = value as { actions?: unknown[] };
  if (!plan || !Array.isArray(plan.actions) || plan.actions.length > 8)
    throw new Error("invalid_extension_voice_response");
  return plan.actions
    .map((raw) => {
      const a = raw as Record<string, unknown>;
      if (!a || typeof a !== "object" || Array.isArray(a))
        throw new Error("invalid_extension_voice_action");
      if (
        a.type === "say" &&
        Object.keys(a).every((k) => ["type", "text", "style"].includes(k)) &&
        typeof a.text === "string" &&
        a.text.length <= 2000 &&
        (a.style === undefined || a.style === "man" || a.style === "woman")
      )
        return `<Say${a.style ? ` voice="${a.style}"` : ""}>${xml(a.text)}</Say>`;
      if (
        a.type === "gather" &&
        Object.keys(a).every((k) => ["type", "text", "digits", "input", "style"].includes(k)) &&
        typeof a.text === "string" &&
        a.text.length <= 1000 &&
        (a.style === undefined || a.style === "man" || a.style === "woman") &&
        (a.input === undefined || ["dtmf", "speech", "dtmf speech"].includes(String(a.input))) &&
        (allowSpeechInput || (a.input !== "speech" && a.input !== "dtmf speech")) &&
        ((a.input === "speech" && a.digits === undefined) ||
          (Number.isInteger(a.digits) && Number(a.digits) >= 1 && Number(a.digits) <= 8))
      ) {
        const input = a.input === "speech" ? "speech" : a.input === "dtmf speech" ? "dtmf speech" : "dtmf";
        const digits = input === "speech" ? "" : ` numDigits="${Number(a.digits)}"`;
        const speechTimeout = input.includes("speech") ? ` speechTimeout="auto"` : "";
        return `<Gather input="${input}"${digits}${speechTimeout} timeout="10" action="${xml(callback)}" method="POST"><Say${a.style ? ` voice="${a.style}"` : ""}>${xml(a.text)}</Say></Gather><Hangup/>`;
      }
      if (a.type === "hangup" && Object.keys(a).length === 1)
        return "<Hangup/>";
      throw new Error("invalid_extension_voice_action");
    })
    .join("");
}
