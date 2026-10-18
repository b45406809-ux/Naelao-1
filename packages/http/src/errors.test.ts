import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  badRequest,
  errorResponse,
  forbidden,
  internalError,
  notFound,
  tooManyRequests,
  unauthorized,
} from "./errors.js";

afterEach(() => vi.restoreAllMocks());

describe("HTTP error responses", () => {
  it("serializes known errors with status, code, request ID, and optional details", async () => {
    const response = errorResponse(
      badRequest("invalid input", { field: "name" }),
      "req-1"
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error_code: "bad_request",
      message: "invalid input",
      request_id: "req-1",
      details: { field: "name" },
    });
  });

  it("keeps factory status codes stable", () => {
    expect(unauthorized().status).toBe(401);
    expect(forbidden().status).toBe(403);
    expect(notFound("Space").message).toBe("Space not found");
    expect(tooManyRequests(30).details).toEqual({ retry_after: 30 });
    expect(internalError().status).toBe(500);
  });

  it("masks unexpected exception details while logging the original error", async () => {
    const failure = new Error("sensitive upstream credential");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(failure, "req-2");
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledWith("Unhandled error:", failure);
    await expect(response.json()).resolves.toEqual({
      error_code: "internal_error",
      message: "An unexpected error occurred",
      request_id: "req-2",
    });
  });

  it("masks messages and details from explicit server errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(
      new HttpError(500, "database_failure", "private payload", {
        secret: "private",
      }),
      "req-3"
    );
    await expect(response.json()).resolves.toEqual({
      error_code: "internal_error",
      message: "An unexpected error occurred",
      request_id: "req-3",
    });
    expect(log).toHaveBeenCalledTimes(1);
  });
});
