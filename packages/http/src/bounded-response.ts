/** Read provider or service-binding output without allocating beyond a byte ceiling. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  const declaredLength =
    lengthHeader !== null && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader)
      : null;
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    const reader = response.body?.getReader();
    try {
      await reader?.cancel();
    } catch {
      // The body is already unusable; the size limit still fails closed.
    } finally {
      reader?.releaseLock();
    }
    throw new Error("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response_too_large");
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
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    bytes
  );
}

export async function readBoundedResponseJson<T>(
  response: Response,
  maximumBytes: number
): Promise<T> {
  return JSON.parse(await readBoundedResponseText(response, maximumBytes)) as T;
}
