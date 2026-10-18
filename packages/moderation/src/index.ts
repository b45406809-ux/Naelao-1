// Content policy enforcement, CSAM hash check interface, PHI detection

// Known CSAM hash list interface (actual hashes are never stored here; this is the check interface)
export interface CsamHashChecker {
  check(sha256Hex: string): Promise<boolean>;
}

// PHI patterns (HIPAA-covered health information indicators)
const PHI_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(dob|date\s+of\s+birth|born\s+on)[\s:]+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i,
  /\b(medical\s+record|mrn|patient\s+id)[\s:#]+[A-Z0-9]{4,}\b/i,
  /\b(diagnosis|diagnosed\s+with|icd[-_]?\d{1,2})[\s:]+[A-Z\d.]+\b/i,
  /\b(prescription|rx|medication|dosage)[\s:]+\w+\b/i,
];

export interface ModerationResult {
  allowed: boolean;
  flags: ModerationFlag[];
}

export interface ModerationFlag {
  type:
    | "csam_hash"
    | "phi"
    | "policy_violation"
    | "jailbreak"
    | "prompt_injection";
  confidence: "high" | "medium" | "low";
  detail?: string;
}

const MAX_MODERATION_TEXT_CHARS = 1_000_000;
const MAX_MODERATION_IMAGE_BYTES = 20 * 1024 * 1024;

function isModeratableText(text: unknown): text is string {
  return typeof text === "string" && text.length <= MAX_MODERATION_TEXT_CHARS;
}

// Check content for PHI
export function detectPhi(text: string): ModerationFlag[] {
  if (!isModeratableText(text)) return [];
  const flags: ModerationFlag[] = [];
  for (const pattern of PHI_PATTERNS) {
    if (pattern.test(text)) {
      flags.push({ type: "phi", confidence: "medium", detail: pattern.source });
    }
  }
  return flags;
}

// Prompt injection patterns — G-AH45: extended to cover tool-result injection vectors
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /system\s*:\s*you\s+are/i,
  /<\/?system>/i,
  /\[system\]/i,
  /###\s*system/i,
  /override\s+(your\s+)?(system\s+)?prompt/i,
  // Tool-result-specific injection patterns (G-AH45)
  /^(SYSTEM|ASSISTANT|USER)\s*:/im, // role prefixes at line start
  /\bexfiltrate\b.*\b(api\s*key|token|secret|credential)/i,
  /send\s+(all|the|this)\s+.{0,50}(to\s+)?(https?:\/\/|attacker|evil)/i,
  /forward\s+(this|all|the)\s+(conversation|data|context|message)/i,
  /print\s+(your\s+)?(system\s+)?prompt/i,
  /reveal\s+(your\s+)?(secret|instruction|system\s+prompt)/i,
];

export function detectPromptInjection(text: string): ModerationFlag[] {
  if (!isModeratableText(text)) return [];
  const flags: ModerationFlag[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      flags.push({
        type: "prompt_injection",
        confidence: "high",
        detail: pattern.source,
      });
    }
  }
  return flags;
}

// Policy violations
const POLICY_PATTERNS = [
  {
    pattern: /\b(child|minor|underage)\s+(sex|porn|nude)/i,
    type: "csam_text" as const,
  },
  {
    pattern:
      /how\s+to\s+(make|build|synthesize)\s+(a\s+)?(bomb|explosive|nerve\s+agent|ricin|bioweapon)/i,
    type: "weapons" as const,
  },
  {
    pattern: /step[s]?\s+to\s+(commit|perform)\s+(murder|terrorism|genocide)/i,
    type: "violence" as const,
  },
];

export function detectPolicyViolations(text: string): ModerationFlag[] {
  if (!isModeratableText(text)) return [];
  const flags: ModerationFlag[] = [];
  for (const { pattern } of POLICY_PATTERNS) {
    if (pattern.test(text)) {
      flags.push({
        type: "policy_violation",
        confidence: "high",
        detail: pattern.source,
      });
    }
  }
  return flags;
}

// Full moderation check (text-based)
export function moderateText(text: string): ModerationResult {
  if (!isModeratableText(text)) {
    return {
      allowed: false,
      flags: [
        {
          type: "policy_violation",
          confidence: "high",
          detail: "invalid_or_oversized_moderation_input",
        },
      ],
    };
  }
  const flags: ModerationFlag[] = [
    ...detectPhi(text),
    ...detectPromptInjection(text),
    ...detectPolicyViolations(text),
  ];
  // Block on high-confidence policy violations or prompt injection
  const blocked = flags.some(
    (f) =>
      f.confidence === "high" &&
      (f.type === "policy_violation" || f.type === "prompt_injection")
  );
  return { allowed: !blocked, flags };
}

// Image moderation: SHA-256 hash check against known CSAM database
export async function moderateImageHash(
  imageBytes: Uint8Array,
  checker: CsamHashChecker
): Promise<ModerationResult> {
  if (!(imageBytes instanceof Uint8Array)) {
    throw new TypeError("moderation_image_must_be_bytes");
  }
  if (imageBytes.byteLength > MAX_MODERATION_IMAGE_BYTES) {
    throw new RangeError("moderation_image_too_large");
  }
  if (!checker || typeof checker.check !== "function") {
    throw new TypeError("csam_hash_checker_required");
  }
  const hashBuf = await crypto.subtle.digest("SHA-256", imageBytes);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const isKnownCsam = await checker.check(hashHex);
  if (isKnownCsam) {
    return {
      allowed: false,
      flags: [
        {
          type: "csam_hash",
          confidence: "high",
          detail: "known content hash match",
        },
      ],
    };
  }
  return { allowed: true, flags: [] };
}

// Stub CSAM checker (real implementation connects to PhotoDNA / NCMEC API)
export class StubCsamHashChecker implements CsamHashChecker {
  async check(_sha256Hex: string): Promise<boolean> {
    // Always returns false in stub — real implementation must connect to PhotoDNA or NCMEC
    return false;
  }
}
