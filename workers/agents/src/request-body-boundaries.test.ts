import { describe, expect, it } from "vitest";
import { app, fetchAgentsRequest } from "./index.js";

describe("Agents inbound request body limits", () => {
  it("rejects an oversized tunnel enrollment before parsing or reaching Spaces", async () => {
    const response = await app.request(
      "/tunnel/enroll",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(32_769),
      },
      { PLATFORM_SECRET: "test-secret" } as never
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error_code: "payload_too_large",
    });
  });

  it("bounds every JSON route at the Worker entry point", async () => {
    const request = new Request("https://agents.example.test/unmatched", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(4 * 1024 * 1024 + 1),
    });
    const response = await fetchAgentsRequest(
      request,
      { PLATFORM_SECRET: "test-secret" } as never,
      {} as never
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error_code: "payload_too_large",
    });
  });
});
