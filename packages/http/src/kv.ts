/**
 * G-BE02: CF KV value size validation and safe-write helpers.
 *
 * CF KV values have a hard 25MB maximum. Writes that exceed this limit
 * fail silently. We enforce a 23MB (92%) warning threshold and support
 * chunked storage for values that exceed the limit.
 */

const KV_WARN_BYTES = 23 * 1024 * 1024; // 23 MB — 92% of 25 MB hard limit
const KV_CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB per chunk

export interface KVPutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}

/**
 * Safe KV write: validates size before writing.
 * If value > 23MB: stores a warning flag or splits into UTF-8-safe chunks and
 * stores a chunk manifest at the base key.
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
    const meta = {
      _size_warn: true,
      _byte_length: byteLength,
      ...((options?.metadata as object) ?? {}),
    };
    await kv.put(key, value, { ...options, metadata: meta });
    return;
  }

  // Over 25MB: chunk into 20MB pieces, store chunk manifest at base key
  const numChunks = Math.ceil(byteLength / KV_CHUNK_SIZE);
  const chunkKeys: string[] = [];

  let start = 0;
  for (let i = 0; i < numChunks; i++) {
    let end = Math.min(start + KV_CHUNK_SIZE, byteLength);
    // Back up to the leading byte when the byte cap lands inside a UTF-8 code point.
    // Each stored chunk can then be decoded independently without inserting U+FFFD.
    while (
      end < byteLength &&
      ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000
    ) {
      end--;
    }
    const chunkBytes = encoded.slice(start, end);
    const chunkValue = new TextDecoder().decode(chunkBytes);
    const chunkKey = `${key}_chunk_${i}`;
    await kv.put(chunkKey, chunkValue, options);
    chunkKeys.push(chunkKey);
    start = end;
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
  if (value === null) return null;

  // Check if it's a chunk manifest
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }

  if (!parsed || typeof parsed !== "object") return value;
  const manifest = parsed as Record<string, unknown>;
  if (manifest.chunked !== true) return value;
  if (!Array.isArray(manifest.chunk_keys)) return null;

  const keys = manifest.chunk_keys;
  const numChunks = manifest.num_chunks;
  const totalBytes = manifest.total_bytes;
  if (
    keys.length === 0 ||
    !Number.isInteger(numChunks) ||
    numChunks !== keys.length ||
    !Number.isSafeInteger(totalBytes) ||
    (totalBytes as number) < 0 ||
    keys.some((k, i) => k !== `${key}_chunk_${i}`)
  ) {
    return null;
  }
  const chunks = await Promise.all(keys.map((k) => kv.get(k as string)));
  if (chunks.some((chunk) => typeof chunk !== "string")) return null;
  const result = (chunks as string[]).join("");
  if (new TextEncoder().encode(result).byteLength !== totalBytes) {
    return null;
  }
  return result;
}
