export interface ThreadSessionBinding {
  version: 1;
  consumerId: string;
  sessionRef: string;
  conversationRef?: string;
}

/** Parse the bounded, non-secret external consumer/session reference stored on a thread. */
export function parseThreadSessionBinding(value: unknown, consumerId?: string): ThreadSessionBinding | null {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).some(key => !["version", "consumerId", "sessionRef", "conversationRef"].includes(key))
      || row.version !== 1
      || typeof row.consumerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(row.consumerId)
      || (consumerId !== undefined && row.consumerId !== consumerId)
      || typeof row.sessionRef !== "string" || !row.sessionRef.trim() || row.sessionRef.length > 512
      || /[\u0000-\u001f\u007f]/.test(row.sessionRef)
      || (row.conversationRef !== undefined && (typeof row.conversationRef !== "string" || !row.conversationRef.trim()
        || row.conversationRef.length > 512 || /[\u0000-\u001f\u007f]/.test(row.conversationRef)))) return null;
  if (new TextEncoder().encode(JSON.stringify(row)).byteLength > 2048) return null;
  return { version: 1, consumerId: row.consumerId, sessionRef: row.sessionRef,
    ...(typeof row.conversationRef === "string" ? { conversationRef: row.conversationRef } : {}) };
}
