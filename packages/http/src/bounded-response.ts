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

/** Read only a response prefix, canceling an oversized body without buffering its tail. */
export async function readResponsePrefixText(
  response: Response,
  maximumBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError("maximumBytes must be a non-negative safe integer");
  if (!response.body) return { text: "", truncated: false };
  const lengthHeader = response.headers.get("content-length");
  const declaredLength =
    lengthHeader !== null && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader)
      : null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = declaredLength !== null && declaredLength > maximumBytes;
  try {
    while (total < maximumBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (!truncated && total === maximumBytes) {
      if (declaredLength !== null) truncated = declaredLength > total;
      else truncated = true;
      if (truncated) await reader.cancel().catch(() => undefined);
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
  return { text: new TextDecoder().decode(bytes), truncated };
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request_body_too_large");
    this.name = "RequestBodyTooLargeError";
  }
}

/** Consume a request body once under a hard cap; do not clone/tee the stream. */
export async function readBoundedRequestBytes(
  request: Request,
  maximumBytes: number
): Promise<Uint8Array> {
  const lengthHeader = request.headers.get("content-length");
  const declaredLength =
    lengthHeader !== null && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader)
      : null;
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await request.body?.cancel().catch(() => undefined);
    throw new RequestBodyTooLargeError();
  }
  if (request.bodyUsed) throw new Error("request_body_unavailable");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
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
  return bytes;
}

export async function readBoundedRequestText(
  request: Request,
  maximumBytes: number
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    await readBoundedRequestBytes(request, maximumBytes)
  );
}
