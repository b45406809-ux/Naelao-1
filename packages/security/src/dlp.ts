const PII_PATTERNS = [
  // Rough credit card match (13-16 digits with optional dashes/spaces)
  { name: "Credit Card", regex: /\b(?:\d[ -]*?){13,16}\b/g },
  // US Social Security Number
  { name: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Stripe Secret Keys
  { name: "Stripe Key", regex: /sk_(live|test)_[0-9a-zA-Z]{24,}/g },
  // Standard RSA/EC Private Keys
  { name: "Private Key", regex: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/g }
];

export interface DlpScanResult {
  isClean: boolean;
  scrubbedPayload: string;
  flaggedCategories: string[];
}

/**
 * Scans stringified payloads for sensitive PII/Secrets.
 * Returns the scrubbed payload and flags any matched categories.
 */
export function scrubOutboundPayload(payload: string): DlpScanResult {
  if (!payload) return { isClean: true, scrubbedPayload: payload, flaggedCategories: [] };

  let cleanPayload = payload;
  const flaggedCategories = new Set<string>();

  for (const { name, regex } of PII_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(cleanPayload)) {
      flaggedCategories.add(name);
      regex.lastIndex = 0;
      cleanPayload = cleanPayload.replace(regex, `[REDACTED_${name.replace(/\s+/g, "_").toUpperCase()}]`);
    }
  }

  return { 
    isClean: flaggedCategories.size === 0, 
    scrubbedPayload: cleanPayload, 
    flaggedCategories: Array.from(flaggedCategories) 
  };
}
