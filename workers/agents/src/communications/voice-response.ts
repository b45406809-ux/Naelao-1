import { xml } from "./phone-provider.js";
/** Extensions return data, never executable TwiML or credential-bearing callback URLs. */
export function renderExtensionVoiceResponse(
  value: unknown,
  callback: string
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
        Object.keys(a).every((k) => ["type", "text"].includes(k)) &&
        typeof a.text === "string" &&
        a.text.length <= 2000
      )
        return `<Say>${xml(a.text)}</Say>`;
      if (
        a.type === "gather" &&
        Object.keys(a).every((k) => ["type", "text", "digits"].includes(k)) &&
        typeof a.text === "string" &&
        a.text.length <= 1000 &&
        Number.isInteger(a.digits) &&
        Number(a.digits) >= 1 &&
        Number(a.digits) <= 8
      )
        return `<Gather input="dtmf" numDigits="${a.digits}" timeout="10" action="${xml(callback)}" method="POST"><Say>${xml(a.text)}</Say></Gather><Hangup/>`;
      if (a.type === "hangup" && Object.keys(a).length === 1)
        return "<Hangup/>";
      throw new Error("invalid_extension_voice_action");
    })
    .join("");
}
