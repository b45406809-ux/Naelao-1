const DEFAULT_MAX_PROVIDER_JSON_BYTES = 256 * 1024;

/** Parse small provider metadata responses without allowing an unbounded JSON allocation. */
export async function readBoundedProviderJson(
  response: Response,
  maxBytes = DEFAULT_MAX_PROVIDER_JSON_BYTES
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxBytes must be a positive safe integer");
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new Error("provider_metadata_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_metadata_body_missing");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("provider_metadata_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("provider_metadata_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider_metadata_invalid_json");
  }
  return parsed as Record<string, unknown>;
}
