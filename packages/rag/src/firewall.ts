/**
 * Axis 5: Indirect Injection Security Firewalls & Semantic Boundary Envelopes
 *
 * Scans tool outputs, third-party web content, and retrieved vector chunks before prompt insertion.
 * Encapsulates dynamic payloads into strict XML sandbox envelopes (e.g. <context_chunk id="..." access="verified">
 * or <untrusted_retrieval_chunk>) to prevent recursive prompt injection and instruction overriding.
 */

export const PROMPT_INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "ignore_previous", pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { name: "disregard_instructions", pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { name: "forget_instructions", pattern: /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { name: "identity_switch", pattern: /you\s+are\s+now\s+(a|an|the)\s+/i },
  { name: "system_tag_mimic", pattern: /<\s*\/?\s*system\s*>/i },
  { name: "system_prompt_marker", pattern: /\[SYSTEM(?:_PROMPT)?\]|\bSYSTEM\s*PROMPT\b/i },
  { name: "jailbreak_header", pattern: /###\s*(INSTRUCTIONS?|SYSTEM|OVERRIDE|JAILBREAK|DAN|DEVELOPER MODE)/i },
  { name: "override_instructions", pattern: /\bOVERRIDE\s+(ALL\s+)?(PREVIOUS\s+)?INSTRUCTIONS?\b/i },
  { name: "act_as_roleplay", pattern: /\bACT\s+AS\s+(IF\s+YOU\s+ARE\s+)?(A\s+|AN\s+)?/i },
  { name: "dan_mode", pattern: /\b(DAN\s+mode|jailbroken|unrestricted\s+AI)\b/i },
  { name: "tool_dispatch_override", pattern: /\bcall\s+tool\s+[a-z0-9_-]+\s+with\b/i },
  { name: "security_policy_bypass", pattern: /\bbypass\s+(all\s+)?(safety|security|content)\s+filters?\b/i },
];

/**
 * Scans a text snippet for prompt injection and jailbreak signatures.
 */
export function scanForInjectionPatterns(text: string): { safe: boolean; detectedPatterns: string[] } {
  if (!text) return { safe: true, detectedPatterns: [] };
  const detected: string[] = [];

  for (const { name, pattern } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(name);
    }
  }

  return {
    safe: detected.length === 0,
    detectedPatterns: detected,
  };
}

/**
 * Escapes XML entities to prevent breaking out of semantic boundary tags.
 */
export function escapeXml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Masks detected prompt injection payloads inside untrusted text.
 */
export function maskInjectionPayload(text: string): string {
  let sanitized = text;
  for (const { pattern } of PROMPT_INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[FILTERED_UNTRUSTED_INJECTION_ATTEMPT]");
  }
  return escapeXml(sanitized);
}

/**
 * Computes a quick deterministic FNV-1a / hex hash of a string for chunk identification.
 */
export function computeChunkHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface RetrievalChunkInput {
  id?: string;
  content: string;
  access?: "verified" | "untrusted" | "role_checked";
  source?: string;
  similarityScore?: number;
}

/**
 * Encapsulates a verified or unverified retrieval chunk into a mathematical sandbox envelope:
 * F_sandbox(c_i) = "<context_chunk id=\"" + Hash(c_i) + "\" access=\"verified\">" + EscapeXML(c_i) + "</context_chunk>"
 */
export function createContextSandboxEnvelope(chunk: RetrievalChunkInput): string {
  const chunkId = chunk.id ?? `chk_${computeChunkHash(chunk.content)}`;
  const access = chunk.access ?? "verified";
  const scan = scanForInjectionPatterns(chunk.content);
  
  const safeContent = scan.safe 
    ? escapeXml(chunk.content) 
    : maskInjectionPayload(chunk.content);

  const sourceAttr = chunk.source ? ` source="${escapeXml(chunk.source)}"` : "";
  const scoreAttr = typeof chunk.similarityScore === "number" 
    ? ` score="${chunk.similarityScore.toFixed(4)}"` 
    : "";

  return `<context_chunk id="${chunkId}" access="${access}"${sourceAttr}${scoreAttr}>\n${safeContent}\n</context_chunk>`;
}

/**
 * Encapsulates raw untrusted external content (web scrape, tool output, user document)
 * with explicit instructions to the attention layers that this text cannot alter system instructions.
 */
export function wrapUntrustedRetrievalChunk(content: string, sourceUrl?: string): string {
  const scan = scanForInjectionPatterns(content);
  const safeContent = scan.safe ? escapeXml(content) : maskInjectionPayload(content);
  const src = sourceUrl ? ` source="${escapeXml(sourceUrl)}"` : "";

  return `<untrusted_retrieval_chunk${src}>\n${safeContent}\n</untrusted_retrieval_chunk>`;
}

/**
 * Concatenates multiple sanitized candidate chunks into a composite prompt context block.
 */
export function concatenateBoundaryEnvelopes(chunks: RetrievalChunkInput[]): string {
  if (chunks.length === 0) return "";
  return chunks.map((c) => createContextSandboxEnvelope(c)).join("\n\n");
}
