export const MAX_MANAGED_ATTACHMENT_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export type ManagedServiceAttachment = {
  filename: string;
  sizeBytes: number | null;
  contentType: string | null;
  downloadUrl: string | null;
  textUrl: string | null;
  expiresAt: string | null;
  expired: boolean;
  tooLarge: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nestedAttachment(value: unknown): Record<string, unknown> | null {
  let current = record(value);
  for (let depth = 0; current && depth < 4; depth++) {
    const nested = record(current.attachment) ?? record(current.data) ?? record(current.result);
    if (!nested) return current;
    current = nested;
  }
  return current;
}

function textField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function signedHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

/**
 * AgentMail returns expiring signed URLs in attachment metadata. Keep them in Shell memory only,
 * never render their query strings, and offer them only while current and within the UI's download
 * bound. The link points directly to the provider's signed object; Shell never proxies the bytes.
 */
export function normalizeManagedServiceAttachment(value: unknown, now = Date.now()): ManagedServiceAttachment | null {
  const attachment = nestedAttachment(value);
  if (!attachment) return null;
  const sizeCandidate = attachment.size;
  const sizeBytes = typeof sizeCandidate === "number" && Number.isSafeInteger(sizeCandidate) && sizeCandidate >= 0
    ? sizeCandidate : null;
  const expiry = textField(attachment, "expires_at", "expiresAt");
  const expiresAtMs = expiry ? Date.parse(expiry) : Number.NaN;
  const expired = !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
  const tooLarge = sizeBytes !== null && sizeBytes > MAX_MANAGED_ATTACHMENT_DOWNLOAD_BYTES;
  const canOpen = !expired && !tooLarge && sizeBytes !== null;
  const downloadUrl = canOpen ? signedHttpsUrl(attachment.download_url ?? attachment.downloadUrl) : null;
  const textUrl = canOpen ? signedHttpsUrl(attachment.text_url ?? attachment.textUrl) : null;
  return {
    filename: textField(attachment, "filename", "name")?.slice(0, 255) ?? "Attachment",
    sizeBytes,
    contentType: textField(attachment, "content_type", "contentType")?.slice(0, 160) ?? null,
    downloadUrl,
    textUrl,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    expired,
    tooLarge,
  };
}
