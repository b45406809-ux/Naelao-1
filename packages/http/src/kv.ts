/**
 * G-BE02: CF KV value size validation and safe-write helpers.
 *
 * CF KV values have a hard 25MB maximum. Writes that exceed this limit
 * fail silently. We enforce a 23MB (92%) warning threshold and support
 * chunked storage for values that exceed the limit.
 */

const KV_WARN_BYTES = 23 * 1024 * 1024;  // 23 MB — 92% of 25 MB hard limit
const KV_CHUNK_SIZE = 20 * 1024 * 1024;  // 20 MB per chunk

export interface KVPutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}

/**
 * Safe KV write: validates size before writing.
 * If value > 23MB: splits into chunks, stores chunk manifest at base key.
 * If value > 25MB: truncates with truncated:true flag.
 */
export async function safeKvPut(
  kv: KVNamespace,
  key: string,
  value: string,
  options?: KVPutOptions
): Promise<void> {
  const encoded = new TextEncoder().encode(value);
  const byteLength = encoded.length;

  if (byteLength <= KV_WARN_BYTES) {
    await kv.put(key, value, options);
    return;
  }

  // Warn — value exceeds 23MB threshold
  console.warn(
    `[KV] G-BE02 size threshold exceeded: key="${key}" size=${byteLength} bytes (${(byteLength / 1024 / 1024).toFixed(1)}MB)`
  );

  if (byteLength <= 25 * 1024 * 1024) {
    // Between 23MB and 25MB: store as-is with warning flag in metadata
    const meta = { _size_warn: true, _byte_length: byteLength, ...(options?.metadata as object ?? {}) };
    await kv.put(key, value, { ...options, metadata: meta });
    return;
  }

  // Over 25MB: chunk into 20MB pieces, store chunk manifest at base key
  const numChunks = Math.ceil(byteLength / KV_CHUNK_SIZE);
  const chunkKeys: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * KV_CHUNK_SIZE;
    const end = Math.min(start + KV_CHUNK_SIZE, byteLength);
    const chunkBytes = encoded.slice(start, end);
    const chunkValue = new TextDecoder().decode(chunkBytes);
    const chunkKey = `${key}_chunk_${i}`;
    await kv.put(chunkKey, chunkValue, options);
    chunkKeys.push(chunkKey);
  }

  // Store manifest at base key
  const manifest = JSON.stringify({
    chunked: true,
    total_bytes: byteLength,
    num_chunks: numChunks,
    chunk_keys: chunkKeys,
  });
  await kv.put(key, manifest, options);
}

/**
 * Read a value written by safeKvPut — reassembles chunks if needed.
 */
export async function safeKvGet(
  kv: KVNamespace,
  key: string
): Promise<string | null> {
  const value = await kv.get(key);
  if (!value) return null;

  // Check if it's a chunk manifest
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed["chunked"] === true && Array.isArray(parsed["chunk_keys"])) {
      const chunks = await Promise.all(
        (parsed["chunk_keys"] as string[]).map(k => kv.get(k))
      );
      return chunks.join("");
    }
  } catch {
    // Not a manifest — return value as-is
  }

  return value;
}
