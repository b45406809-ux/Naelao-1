import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintInternalToken,
  mintLocalTunnelToken,
  requestId,
  verifyInternalToken,
  verifyLocalTunnelToken,
} from "./middleware.js";

const SECRET = "test-platform-secret";

afterEach(() => vi.useRealTimers());

describe("shared HTTP middleware tokens and request IDs", () => {
  it("accepts only a correctly scoped, fresh internal HMAC token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    const token = await mintInternalToken(SECRET, "tenant-1");
    expect(await verifyInternalToken(token, "tenant-1", SECRET)).toBe(true);
    expect(await verifyInternalToken(token, "tenant-2", SECRET)).toBe(false);
    expect(await verifyInternalToken(`${token},t=1`, "tenant-1", SECRET)).toBe(
      false
    );
    expect(
      await verifyInternalToken(
        token.replace(/^t=\d+/, "t=123x"),
        "tenant-1",
        SECRET
      )
    ).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(await verifyInternalToken(token, "tenant-1", SECRET)).toBe(false);
  });

  it("keeps local tunnel tokens scoped to one user and space", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    const token = await mintLocalTunnelToken(SECRET, "space-1", "user-1");
    expect(
      await verifyLocalTunnelToken(token, "space-1", "user-1", SECRET)
    ).toBe(true);
    expect(
      await verifyLocalTunnelToken(token, "space-2", "user-1", SECRET)
    ).toBe(false);
    expect(
      await verifyLocalTunnelToken(token, "space-1", "user-2", SECRET)
    ).toBe(false);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(
      await verifyLocalTunnelToken(token, "space-1", "user-1", SECRET)
    ).toBe(false);
  });

  it("replaces oversized or malformed request IDs with a safe generated ID", async () => {
    const app = new Hono();
    app.use("*", requestId);
    app.get("/", (c) => c.text("ok"));

    const response = await app.request("/", {
      headers: { "x-request-id": "bad\u0007id" },
    });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);

    const accepted = await app.request("/", {
      headers: { "x-request-id": "trace-123" },
    });
    expect(accepted.headers.get("x-request-id")).toBe("trace-123");
  });
});
