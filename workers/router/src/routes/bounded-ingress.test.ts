import { describe, expect, it, vi } from "vitest";
import { app } from "../index";

describe("bounded public ingress", () => {
  it("rejects oversized Desk Drop bodies before forwarding to Spaces", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const response = await app.request(
      "/v1/desk-drop/redeem",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: "x".repeat(64 * 1024 + 1),
      },
      {
        JWT_SECRET: "test-secret",
        PLATFORM_SECRET: "test-secret",
        SPACES_WORKER: { fetch },
      } as never
    );
    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
});
