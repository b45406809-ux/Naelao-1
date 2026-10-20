/** Read a provider response without allocating beyond its configured UTF-8 byte budget. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const declaredLength =
    contentLength !== null && /^\d+$/.test(contentLength)
      ? Number(contentLength)
      : null;
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    const reader = response.body?.getReader();
    await reader?.cancel().catch(() => undefined);
    throw new Error("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
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
