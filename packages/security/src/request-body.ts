export type RequestBodyLimitResult =
  | "within_limit"
  | "too_large"
  | "unavailable";

/** Enforces a byte ceiling without buffering the body; inspection runs on a clone so the
 * original request remains readable by its parser or endpoint. */
export async function checkRequestBodyByteLimit(
  request: Request,
  maxBytes: number
): Promise<RequestBodyLimitResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    return "too_large";
  }

  try {
    const stream = request.clone().body;
    if (!stream) return "within_limit";
    const reader = stream.getReader();
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return "within_limit";
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          // Both branches are discarded because the caller returns an error response.
          // Cancel them together so the tee can stop pulling and queueing the upload tail.
          await Promise.allSettled([
            reader.cancel(),
            request.body?.cancel(),
          ]);
          return "too_large";
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    return "unavailable";
  }
}
