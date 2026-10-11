/** Bounded JSON requests for interactive pages. Never replay a mutation automatically. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public errorCode?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function requestJson<T>(url: string, options: RequestInit = {}, policy: {
  retries?: number | undefined;
  timeoutMs?: number | undefined;
  onRetry?: ((attempt: number, max: number) => void) | undefined;
} = {}): Promise<T> {
  const readOnly = ["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase());
  // Local service bindings can briefly return 503 while Wrangler reconnects a worker. Give
  // read-only page data a few bounded chances to recover; mutations remain single-attempt so we
  // never replay a write implicitly.
  const retries = readOnly ? (policy.retries ?? 3) : 0;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), policy.timeoutMs ?? 10_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string; error?: string; error_code?: string };
        throw new ApiError(body.message ?? body.error ?? `Request failed (${response.status})`, response.status, body.error_code);
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      const retryable = !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
      if (attempt < retries && retryable) {
        policy.onRetry?.(attempt + 1, retries);
      } else if (error instanceof ApiError) {
        throw error;
      } else {
        throw new ApiError(readOnly
          ? "Couldn't reach the server. Check your connection and try again."
          : "The server didn't confirm this change. Refresh to check whether it saved before trying again.", 0, "network_error");
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
}
