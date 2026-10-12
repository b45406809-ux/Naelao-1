export const TOOL_OUTPUT_EXPIRY_PREFIX = "tool-output-expiry:item:";
const CURSOR_KEY = "tool-output-expiry:cursor";

export interface ToolOutputExpiryIndex {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: Record<string, unknown> }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: Record<string, unknown> | null }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

function hex(bytes: Uint8Array): string { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }

/** Persist a private R2 key in a metadata-only index; no log contents enter KV. */
export async function scheduleToolOutputExpiry(index: ToolOutputExpiryIndex, storageKey: string, expiresAt: number): Promise<void> {
  if (!storageKey.startsWith("private/tool-output/") || !Number.isSafeInteger(expiresAt)) throw new Error("invalid_tool_output_expiry");
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(storageKey))));
  await index.put(`${TOOL_OUTPUT_EXPIRY_PREFIX}${digest}`, "", { metadata: { storageKey, expiresAt } });
}

/** Delete due private logs and advance a bounded cursor so large buckets make steady progress. */
export async function expireToolOutputs(index: ToolOutputExpiryIndex, bucket: Pick<R2Bucket, "delete">, now = Date.now(), maxPages = 10): Promise<{ scanned: number; deleted: number }> {
  let cursor = await index.get(CURSOR_KEY) ?? undefined;
  let scanned = 0, deleted = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await index.list({ prefix: TOOL_OUTPUT_EXPIRY_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const entry of page.keys) {
      scanned++;
      const key = entry.metadata?.storageKey;
      const expiry = entry.metadata?.expiresAt;
      if (typeof key === "string" && key.startsWith("private/tool-output/") && typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry <= now) {
        await bucket.delete(key);
        deleted++;
      }
      if (typeof key !== "string" || typeof expiry !== "number" || expiry <= now) await index.delete(entry.name);
    }
    if (page.list_complete || !page.cursor) {
      cursor = undefined;
      await index.delete(CURSOR_KEY);
      break;
    }
    cursor = page.cursor;
    await index.put(CURSOR_KEY, cursor);
  }
  return { scanned, deleted };
}
