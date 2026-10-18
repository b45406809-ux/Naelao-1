import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "./headers.js";

describe("security headers middleware", () => {
  it("applies the configured browser security headers to successful responses", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (context) => context.text("ok"));

    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000"
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin"
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'"
    );
  });
});
