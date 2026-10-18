import { describe, expect, it } from "vitest";
import worker from "./index.js";

describe("thread list query bounds", () => {
  it("passes a positive capped limit and offset to D1 for both request extremes", async () => {
    const bindings: unknown[][] = [];
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-platform-secret",
      LLM_GATEWAY_URL: "https://llm.invalid",
      PLATFORM_DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => ({
            all: async () => {
              bindings.push(values);
              return { results: [] };
            },
          }),
        }),
      },
    };
    const request = (query: string) =>
      worker.fetch(
        new Request(`https://threads.invalid/v1/threads?${query}`, {
          headers: { "x-naelao-tenant-id": "tenant-a" },
        }),
        env as never
      );

    expect((await request("limit=-1&offset=-500")).status).toBe(200);
    expect(bindings[0]).toEqual(["tenant-a", 1, 0]);
    expect((await request("limit=999999&offset=999999999")).status).toBe(200);
    expect(bindings[1]).toEqual(["tenant-a", 100, 100_000]);
  });
});
