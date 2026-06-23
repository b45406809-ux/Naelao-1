import type { ApiError } from "@naelao/types";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(400, "bad_request", message, details);
}

export function unauthorized(message = "Unauthorized"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function notFound(resource = "Resource"): HttpError {
  return new HttpError(404, "not_found", `${resource} not found`);
}

export function tooManyRequests(retryAfter?: number): HttpError {
  return new HttpError(429, "rate_limited", "Too many requests", {
    retry_after: retryAfter,
  });
}

export function internalError(message = "Internal server error"): HttpError {
  return new HttpError(500, "internal_error", message);
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof HttpError) {
    const body: ApiError = {
      error_code: err.code,
      message: err.message,
      details: err.details,
      request_id: requestId,
    };
    return Response.json(body, { status: err.status });
  }

  console.error("Unhandled error:", err);
  const body: ApiError = {
    error_code: "internal_error",
    message: "An unexpected error occurred",
    request_id: requestId,
  };
  return Response.json(body, { status: 500 });
}
