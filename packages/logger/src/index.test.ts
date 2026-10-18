import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, scrubPii } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("structured logger boundaries", () => {
  it("redacts normalized secret field names and common PII in nested strings", () => {
    expect(
      scrubPii({
        apiKey: "key-a",
        openaiApiKey: "key-c",
        API_KEY: "key-b",
        refreshToken: "refresh",
        private_key: "private",
        phoneNumber: "4155552671",
        userEmail: "person@example.com",
        nested: ["mail me at user@example.com", "SSN 123-45-6789"],
        note: "Call (415) 555-2671",
      })
    ).toEqual({
      apiKey: "[REDACTED]",
      openaiApiKey: "[REDACTED]",
      API_KEY: "[REDACTED]",
      refreshToken: "[REDACTED]",
      private_key: "[REDACTED]",
      phoneNumber: "[REDACTED]",
      userEmail: "[REDACTED]",
      nested: ["mail me at [REDACTED]", "SSN [REDACTED]"],
      note: "Call [REDACTED]",
    });
  });

  it("prevents extra fields from forging reserved log fields and scrubs the message", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger("billing").info("contact user@example.com", {
      level: "error",
      message: "forged",
      service: "forged-service",
      tenant_id: "forged-tenant",
      trace_id: "forged-trace",
      timestamp: "forged-time",
      token: "secret-token",
    });
    const line = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: "info",
      message: "contact [REDACTED]",
      service: "billing",
      token: "[REDACTED]",
    });
    expect(line).not.toHaveProperty("tenant_id");
    expect(line).not.toHaveProperty("trace_id");
    expect(line.timestamp).toBeTypeOf("string");
  });

  it("bounds cyclic, deeply nested, binary, large, and bigint values", () => {
    const circular: Record<string, unknown> = {
      bytes: new Uint8Array([1, 2, 3]),
    };
    circular.self = circular;
    let deep: unknown = "end";
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const result = scrubPii({
      circular,
      deep,
      huge: "x".repeat(20_000),
      largeInteger: 12n,
    }) as Record<string, unknown>;
    expect(result.largeInteger).toBe("12n");
    expect(JSON.stringify(result)).toContain("[Circular]");
    expect(JSON.stringify(result)).toContain("[Binary data]");
    expect(JSON.stringify(result)).toContain("[Max depth]");
    expect(JSON.stringify(result)).toContain("[TRUNCATED]");
  });

  it("respects the configured minimum level and preserves context on child loggers", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("worker", "warn").withContext(
      "trace-1",
      "tenant-1"
    );
    logger.info("hidden");
    logger.warn("visible");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      trace_id: "trace-1",
      tenant_id: "tenant-1",
      level: "warn",
      service: "worker",
    });
  });
});
