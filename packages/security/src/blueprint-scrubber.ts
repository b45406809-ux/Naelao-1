export interface ScrubbedCredential { name: string; description: string; required: boolean }
export type ScrubbedBlueprint = Record<string, unknown> & { requiredCredentials: ScrubbedCredential[] };

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<![\w])(?:\+?\d[\d ().-]{7,}\d)(?![\w])/g;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const PROVIDER_SECRETS: Array<[RegExp, string, string]> = [
  [/\bsk_live_[A-Za-z0-9_-]{8,}\b/g, "STRIPE_API_KEY", "Required for Stripe API access"],
  [/\bghp_[A-Za-z0-9]{8,}\b/g, "GITHUB_ACCESS_TOKEN", "Required for GitHub access"],
  [/\bwhsec_[A-Za-z0-9_-]{8,}\b/g, "WEBHOOK_SECRET", "Required to verify webhook signatures"],
  [/\bxoxb-[A-Za-z0-9-]{8,}\b/g, "SLACK_BOT_TOKEN", "Required for Slack bot access"],
  [/\b(?:access[_-]?token|api[_-]?key|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}["']?/gi, "ACCESS_TOKEN", "Required external service credential"],
];
const CREDENTIAL_REFERENCE = /(?:process\.env\.|env\.|\{\{)([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)(?:\}\})?/g;

/** Recursively scrub every string value without mutating the caller's object. */
export function sanitizeAndScrubBlueprint(rawExport: unknown): ScrubbedBlueprint {
  const credentials = new Map<string, ScrubbedCredential>();
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const match of value.matchAll(CREDENTIAL_REFERENCE)) {
        const name = match[1];
        if (name) credentials.set(name, { name, description: `Required credential: ${name}`, required: true });
      }
      let text = value.replace(PRIVATE_KEY, () => {
        credentials.set("PRIVATE_KEY", { name: "PRIVATE_KEY", description: "Required signing or SSH private key", required: true });
        return "{{PRIVATE_KEY}}";
      });
      for (const [pattern, name, description] of PROVIDER_SECRETS) {
        text = text.replace(pattern, () => {
          credentials.set(name, { name, description, required: true });
          return `{{${name}}}`;
        });
      }
      text = text.replace(EMAIL, "{{CUSTOMER_EMAIL}}").replace(PHONE, "{{PHONE_NUMBER}}");
      return text;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key) as string, scrub(item)]));
    return value;
  };
  const sanitized = scrub(rawExport) as ScrubbedBlueprint;
  const declared = Array.isArray(sanitized.requiredCredentials) ? sanitized.requiredCredentials : [];
  sanitized.requiredCredentials = [...new Map([...declared, ...credentials.values()].map((item) => [item.name, item])).values()];
  return sanitized;
}
